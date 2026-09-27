// HTTP-сервер: API + раздача статического интерфейса. Без npm-зависимостей.
// DEMO=1 — тестовый стенд, хранилище в памяти с демо-данными, вход — выбор пользователя.
// DEMO=0 — пилот: SQLite на постоянном диске, вход по email/паролю (docs/specs/08-foundation.md).

import { createServer } from 'node:http';
import { accessSync, constants as fsConstants, mkdirSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStore, createSqliteStore } from './store.js';
import {
  listEvents, listAttention, getEvent, createEvent, updateEvent, retryPlan,
  archiveEvent, restoreEvent,
} from './events.js';
import {
  listTasks, createTask, getTask, updateTask, completeTask, restoreTask as restoreTaskAction,
} from './tasks.js';
import { getChecklist, addChecklistItems, rescheduleTasks } from './checklist.js';
import { listVendors, createVendor, updateVendor, deleteVendor } from './vendors.js';
import {
  listEventVendors, addEventVendors, updateEventVendorStatus, removeEventVendor,
} from './eventVendors.js';
import {
  getBudget, setCurrency, addManualLine, updateBudgetLine, removeBudgetLine,
} from './budget.js';
import { getWorkspace, updateWorkspace, exportWorkspaceData } from './workspace.js';
import { listTeam, inviteMember, resetLinkFor, updateTeamMember } from './team.js';
import { getEventMembersView, setEventMembers } from './eventMembers.js';
import { inspectInvite, acceptInvite } from './auth/invites.js';
import { attemptLogin } from './auth/login.js';
import { createSession, resolveSession, revokeSession } from './auth/sessions.js';
import { runBackup, scheduleDailyBackup } from './backup.js';
import { ServiceError } from './errors.js';
import { hasPermission } from './access.js';
import { isValidTimeZone } from './time.js';
import { seedDemo, DEMO_TIME_ZONE } from './demo/seed.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const PORT = Number(process.env.PORT ?? 3000);
const DEMO = process.env.DEMO !== '0';
const NODE_ENV = process.env.NODE_ENV ?? 'development';
const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://localhost:${PORT}`;
const DATABASE_PATH = process.env.DATABASE_PATH ?? './data/app.db';
const DATABASE_BACKUP_DIR = process.env.DATABASE_BACKUP_DIR ?? './data/backups';
const BODY_LIMIT = 16 * 1024;
const IDEMPOTENCY_MAX_AGE_MS = 7 * 86400_000;

// ---------- хранилище ----------

let store;
let stopBackupSchedule = null;
if (DEMO) {
  store = createStore();
  seedDemo(store);
} else {
  // Без постоянного диска данные теряются при каждом деплое (docs/specs/08-foundation.md, §6) —
  // лучше отказаться стартовать сразу, с понятной причиной, чем молча терять свадьбы организаторов.
  try {
    mkdirSync(dirname(DATABASE_PATH), { recursive: true });
    accessSync(dirname(DATABASE_PATH), fsConstants.W_OK);
  } catch (err) {
    console.error(`Каталог базы данных недоступен для записи (${DATABASE_PATH}): ${err.message}`);
    console.error('Проверьте, что подключён постоянный диск и DATABASE_PATH указывает на него.');
    process.exit(1);
  }
  store = createSqliteStore(DATABASE_PATH);
  store.pruneIdempotency(Date.now() - IDEMPOTENCY_MAX_AGE_MS);
  setInterval(() => store.pruneIdempotency(Date.now() - IDEMPOTENCY_MAX_AGE_MS), 24 * 3600_000).unref?.();
  stopBackupSchedule = scheduleDailyBackup(store, DATABASE_BACKUP_DIR, (m) => console.error(m));
}

// ---------- сессии ----------
// Cookie хранит только случайный токен; сервер ищет по хэшу токена (server/auth/sessions.js).
// Secure и проверка Origin — только при DEMO=0, чтобы локальный запуск и демо работали по http
// (docs/specs/08-foundation.md, §6).

function readCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function currentUser(req, now) {
  return resolveSession(store, readCookies(req).sid, now);
}

function sessionCookie(value, maxAgeSeconds) {
  const attrs = ['Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
  if (!DEMO) attrs.push('Secure');
  return `sid=${value}; ${attrs.join('; ')}`;
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim()) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress ?? 'unknown';
}

/** Внутренний безопасный путь для returnTo: только «/…», без «//» и схем. */
export function safeReturnTo(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
    return '/events';
  }
  return value;
}

// ---------- часовой пояс ----------
// DEMO=1: пояс пространства → Europe/Moscow демо-стенда → пояс устройства (заголовок
// X-Time-Zone) → UTC. DEMO=0: только пояс пространства (docs/specs/08-foundation.md, §3) —
// заголовок клиента в расчётах больше не участвует, даже если клиент его пришлёт.

function resolveTimeZone(user, req) {
  const ws = store.getWorkspace(user.workspaceId);
  if (ws?.timeZone && isValidTimeZone(ws.timeZone)) return ws.timeZone;
  if (DEMO) {
    const clientTz = req.headers['x-time-zone'];
    if (isValidTimeZone(clientTz)) return clientTz;
    return DEMO_TIME_ZONE;
  }
  return 'UTC';
}

// ---------- ответы ----------

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; " +
    "font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function json(res, status, data, headers = {}) {
  send(res, status, JSON.stringify(data), {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers,
  });
}

function apiError(res, status, code, message, fields) {
  json(res, status, { error: { code, message, ...(fields ? { fields } : {}) } });
}

async function readJson(req) {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
    // JSON-only защищает POST от межсайтовых форм (вместе с SameSite=Lax и проверкой Origin).
    throw new ServiceError(415, 'unsupported_media_type', 'Ожидается application/json');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new ServiceError(413, 'too_large', 'Слишком большой запрос');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new ServiceError(400, 'bad_json', 'Неверный JSON');
  }
}

const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/** Заголовок Origin должен совпадать с PUBLIC_URL на изменяющих запросах (docs/specs/08-foundation.md, §2.3). */
function checkOrigin(req) {
  if (DEMO || !MUTATING.has(req.method)) return true;
  return req.headers.origin === PUBLIC_URL;
}

// ---------- API ----------

async function handleApi(req, res, url, now) {
  const { pathname } = url;
  const method = req.method;

  if (!checkOrigin(req)) return apiError(res, 403, 'bad_origin', 'Запрос отклонён (Origin)');

  if (pathname === '/api/demo-users' && method === 'GET') {
    if (!DEMO) return apiError(res, 404, 'not_found', 'Не найдено');
    return json(res, 200, {
      users: store.listUsers().map(({ id, name, role, note }) => ({ id, name, role, note })),
    });
  }

  if (pathname === '/api/session' && method === 'POST') {
    if (DEMO) {
      const body = await readJson(req);
      const demoUser = store.getUser(body.userId);
      if (!demoUser) return apiError(res, 400, 'bad_user', 'Пользователь не найден');
      const { token } = createSession(store, demoUser.id, req.headers['user-agent'], now);
      return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(token, 60 * 60 * 24 * 30) });
    }
    const body = await readJson(req);
    const result = attemptLogin(store, body.email, body.password, clientIp(req), req.headers['user-agent'], now);
    if (!result.ok) return apiError(res, result.locked ? 429 : 401, result.locked ? 'locked' : 'invalid_credentials', result.message);
    return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(result.token, 60 * 60 * 24 * 30) });
  }

  if (pathname === '/api/session' && method === 'DELETE') {
    const sid = readCookies(req).sid;
    if (sid) revokeSession(store, sid);
    return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
  }

  // ---------- приглашения и сброс пароля: доступны без сессии ----------

  const inviteMatch = pathname.match(/^\/api\/invites\/([A-Za-z0-9_-]{1,80})$/);
  if (inviteMatch && method === 'GET') {
    const check = inspectInvite(store, inviteMatch[1], now);
    if (!check.ok) return apiError(res, 404, 'invalid_invite', check.message);
    return json(res, 200, { email: check.invite.email, name: check.invite.name, kind: check.invite.kind });
  }
  const inviteAccept = pathname.match(/^\/api\/invites\/([A-Za-z0-9_-]{1,80})\/accept$/);
  if (inviteAccept && method === 'POST') {
    const body = await readJson(req);
    const result = acceptInvite(store, inviteAccept[1], body, now);
    if (!result.ok) {
      const status = result.field ? 422 : 404;
      return apiError(res, status, result.field ? 'validation' : 'invalid_invite', result.message, result.field ? { [result.field]: result.message } : undefined);
    }
    const { token } = createSession(store, result.user.id, req.headers['user-agent'], now);
    return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(token, 60 * 60 * 24 * 30) });
  }

  const user = currentUser(req, now);
  if (!user) return apiError(res, 401, 'unauthorized', 'Нужно войти');

  const ctx = {
    store, user, now, timeZone: resolveTimeZone(user, req),
    log: (m) => console.error(m),
  };

  if (pathname === '/api/session' && method === 'GET') {
    const ws = store.getWorkspace(user.workspaceId);
    return json(res, 200, {
      user: { id: user.id, name: user.name, role: user.role },
      workspace: { id: ws.id, name: ws.name, timeZone: ws.timeZone ?? null },
      permissions: { createEvent: hasPermission(user, 'event:create') },
      demo: DEMO,
    });
  }

  if (pathname === '/api/workspace' && method === 'GET') return json(res, 200, getWorkspace(ctx));
  if (pathname === '/api/workspace' && method === 'PATCH') return json(res, 200, updateWorkspace(ctx, await readJson(req)));
  if (pathname === '/api/workspace/export' && method === 'GET') {
    const data = exportWorkspaceData(ctx);
    return send(res, 200, JSON.stringify(data, null, 2), {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="workspace-export-${new Date(now).toISOString().slice(0, 10)}.json"`,
      'Cache-Control': 'no-store',
    });
  }

  if (pathname === '/api/team' && method === 'GET') return json(res, 200, listTeam(ctx));
  if (pathname === '/api/team/invite' && method === 'POST') return json(res, 201, inviteMember(ctx, await readJson(req)));
  const teamReset = pathname.match(/^\/api\/team\/([A-Za-z0-9_-]{1,64})\/reset-link$/);
  if (teamReset && method === 'POST') return json(res, 200, resetLinkFor(ctx, teamReset[1]));
  const teamItem = pathname.match(/^\/api\/team\/([A-Za-z0-9_-]{1,64})$/);
  if (teamItem && method === 'PATCH') return json(res, 200, updateTeamMember(ctx, teamItem[1], await readJson(req)));

  const eventMembers = pathname.match(/^\/api\/events\/([A-Za-z0-9_-]{1,64})\/members$/);
  if (eventMembers) {
    const [, eventId] = eventMembers;
    if (method === 'GET') return json(res, 200, getEventMembersView(ctx, eventId));
    if (method === 'PUT') return json(res, 200, setEventMembers(ctx, eventId, await readJson(req)));
  }

  if (pathname === '/api/events' && method === 'GET') {
    return json(res, 200, listEvents(ctx, Object.fromEntries(url.searchParams)));
  }
  if (pathname === '/api/events' && method === 'POST') {
    const result = createEvent(ctx, await readJson(req));
    return json(res, result.replayed ? 200 : 201, result);
  }
  if (pathname === '/api/events/attention' && method === 'GET') {
    return json(res, 200, listAttention(ctx, Object.fromEntries(url.searchParams)));
  }

  const taskAction = pathname.match(
    /^\/api\/events\/([A-Za-z0-9_-]{1,64})\/tasks\/([A-Za-z0-9_-]{1,64})\/(complete|restore)$/,
  );
  if (taskAction && method === 'POST') {
    await readJson(req);
    const [, eventId, taskId, action] = taskAction;
    return json(res, 200, action === 'complete'
      ? completeTask(ctx, eventId, taskId)
      : restoreTaskAction(ctx, eventId, taskId));
  }

  // Отдельно и раньше общего /tasks/:id — иначе «reschedule» читался бы как taskId.
  const reschedule = pathname.match(/^\/api\/events\/([A-Za-z0-9_-]{1,64})\/tasks\/reschedule$/);
  if (reschedule && method === 'POST') {
    const [, eventId] = reschedule;
    return json(res, 200, rescheduleTasks(ctx, eventId, await readJson(req)));
  }

  const taskItem = pathname.match(/^\/api\/events\/([A-Za-z0-9_-]{1,64})\/tasks\/([A-Za-z0-9_-]{1,64})$/);
  if (taskItem) {
    const [, eventId, taskId] = taskItem;
    if (method === 'GET') return json(res, 200, getTask(ctx, eventId, taskId));
    if (method === 'PATCH') return json(res, 200, updateTask(ctx, eventId, taskId, await readJson(req)));
  }

  const taskList = pathname.match(/^\/api\/events\/([A-Za-z0-9_-]{1,64})\/tasks$/);
  if (taskList) {
    const [, eventId] = taskList;
    if (method === 'GET') return json(res, 200, listTasks(ctx, eventId, Object.fromEntries(url.searchParams)));
    if (method === 'POST') {
      const result = createTask(ctx, eventId, await readJson(req));
      return json(res, 201, result);
    }
  }

  const checklist = pathname.match(/^\/api\/events\/([A-Za-z0-9_-]{1,64})\/checklist$/);
  if (checklist) {
    const [, eventId] = checklist;
    if (method === 'GET') return json(res, 200, getChecklist(ctx, eventId));
    if (method === 'POST') return json(res, 200, addChecklistItems(ctx, eventId, await readJson(req)));
  }

  // ---------- личная база подрядчиков ----------

  if (pathname === '/api/vendors' && method === 'GET') {
    return json(res, 200, listVendors(ctx, Object.fromEntries(url.searchParams)));
  }
  if (pathname === '/api/vendors' && method === 'POST') {
    return json(res, 201, createVendor(ctx, await readJson(req)));
  }
  const vendorItem = pathname.match(/^\/api\/vendors\/([A-Za-z0-9_-]{1,64})$/);
  if (vendorItem) {
    const [, vendorId] = vendorItem;
    if (method === 'PATCH') return json(res, 200, updateVendor(ctx, vendorId, await readJson(req)));
    if (method === 'DELETE') return json(res, 200, deleteVendor(ctx, vendorId));
  }

  // ---------- подрядчики свадьбы ----------

  const eventVendorItem = pathname.match(/^\/api\/events\/([A-Za-z0-9_-]{1,64})\/vendors\/([A-Za-z0-9_-]{1,64})$/);
  if (eventVendorItem) {
    const [, eventId, linkId] = eventVendorItem;
    if (method === 'PATCH') {
      const body = await readJson(req);
      return json(res, 200, updateEventVendorStatus(ctx, eventId, linkId, body?.status));
    }
    if (method === 'DELETE') {
      const body = await readJson(req).catch(() => null);
      return json(res, 200, removeEventVendor(ctx, eventId, linkId, body?.budgetAction));
    }
  }

  const eventVendorList = pathname.match(/^\/api\/events\/([A-Za-z0-9_-]{1,64})\/vendors$/);
  if (eventVendorList) {
    const [, eventId] = eventVendorList;
    if (method === 'GET') return json(res, 200, listEventVendors(ctx, eventId));
    if (method === 'POST') return json(res, 200, addEventVendors(ctx, eventId, await readJson(req)));
  }

  // ---------- смета свадьбы ----------

  const budgetRoot = pathname.match(/^\/api\/events\/([A-Za-z0-9_-]{1,64})\/budget$/);
  if (budgetRoot) {
    const [, eventId] = budgetRoot;
    if (method === 'GET') return json(res, 200, getBudget(ctx, eventId));
    if (method === 'PATCH') {
      const body = await readJson(req);
      return json(res, 200, setCurrency(ctx, eventId, body?.currency));
    }
  }

  const budgetLines = pathname.match(/^\/api\/events\/([A-Za-z0-9_-]{1,64})\/budget\/lines$/);
  if (budgetLines) {
    const [, eventId] = budgetLines;
    if (method === 'POST') return json(res, 201, addManualLine(ctx, eventId, await readJson(req)));
  }

  const budgetLineItem = pathname.match(/^\/api\/events\/([A-Za-z0-9_-]{1,64})\/budget\/lines\/([A-Za-z0-9_-]{1,64})$/);
  if (budgetLineItem) {
    const [, eventId, lineId] = budgetLineItem;
    if (method === 'PATCH') return json(res, 200, updateBudgetLine(ctx, eventId, lineId, await readJson(req)));
    if (method === 'DELETE') return json(res, 200, removeBudgetLine(ctx, eventId, lineId));
  }

  const m = pathname.match(/^\/api\/events\/([A-Za-z0-9_-]{1,64})(?:\/(archive|restore|plan))?$/);
  if (m) {
    const [, id, action] = m;
    if (!action && method === 'GET') return json(res, 200, getEvent(ctx, id));
    if (!action && method === 'PATCH') return json(res, 200, updateEvent(ctx, id, await readJson(req)));
    if (method === 'POST') {
      await readJson(req);
      if (action === 'archive') return json(res, 200, archiveEvent(ctx, id));
      if (action === 'restore') return json(res, 200, restoreEvent(ctx, id));
      if (action === 'plan') return json(res, 200, retryPlan(ctx, id));
    }
  }
  return apiError(res, 404, 'not_found', 'Не найдено');
}

// ---------- статика ----------

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
};

async function serveFile(res, relPath, cache = 'no-cache') {
  const full = normalize(join(ROOT, relPath));
  if (!full.startsWith(ROOT)) return false;
  try {
    const s = await stat(full);
    if (!s.isFile()) return false;
    send(res, 200, await readFile(full), {
      'Content-Type': TYPES[extname(full)] ?? 'application/octet-stream',
      'Cache-Control': cache,
    });
    return true;
  } catch {
    return false;
  }
}

// Пути, доступные без сессии — экраны входа и приглашения/сброса пароля.
const PUBLIC_PAGES = [/^\/login$/, /^\/invite\/[A-Za-z0-9_-]{1,80}$/];

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const now = Date.now();
  try {
    if (url.pathname === '/healthz') {
      const ok = store.ping ? store.ping() : true;
      return json(res, ok ? 200 : 503, { ok });
    }

    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url, now);

    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method Not Allowed');

    if (url.pathname.startsWith('/fonts/') && (await serveFile(res, url.pathname, 'public, max-age=604800'))) return;
    if (/^\/(styles|js)\//.test(url.pathname) && (await serveFile(res, url.pathname))) return;

    // Страницы приложения. Без сессии — на вход с безопасным returnTo, кроме публичных страниц.
    if (PUBLIC_PAGES.some((re) => re.test(url.pathname))) return void (await serveFile(res, 'index.html'));
    if (!currentUser(req, now)) {
      const returnTo = safeReturnTo(url.pathname + url.search);
      return send(res, 302, '', { Location: `/login?returnTo=${encodeURIComponent(returnTo)}` });
    }
    if (url.pathname === '/') return send(res, 302, '', { Location: '/events' });
    return void (await serveFile(res, 'index.html'));
  } catch (err) {
    if (err instanceof ServiceError) return apiError(res, err.status, err.code, err.message, err.fields);
    console.error(err);
    return apiError(res, 500, 'internal', 'Внутренняя ошибка');
  }
}

// Лог запроса без персональных данных (docs/specs/08-foundation.md, §4): метод, путь с
// заменёнными ID, статус, длительность, userId — никогда тело запроса/ответа, имена, email,
// телефоны или пароли.
const ID_SEGMENT = /^[a-z]+_[A-Za-z0-9_-]+$/i;
function redactPath(pathname) {
  return pathname.split('/').map((seg) => (ID_SEGMENT.test(seg) ? ':id' : seg)).join('/');
}

async function loggedHandle(req, res) {
  const start = Date.now();
  const path = redactPath(new URL(req.url, 'http://localhost').pathname);
  res.on('finish', () => {
    const user = (() => { try { return currentUser(req, Date.now()); } catch { return null; } })();
    console.error(`${req.method} ${path} ${res.statusCode} ${Date.now() - start}ms${user ? ` user=${user.id}` : ''}`);
  });
  return handle(req, res);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = createServer(loggedHandle).listen(PORT, () => {
    console.log(`http://localhost:${PORT}  ${DEMO ? '(тестовый стенд, демо-данные)' : `(${NODE_ENV})`}`);
  });

  // Корректная остановка: перестать принимать новые соединения, дождаться текущих, закрыть базу
  // (docs/specs/08-foundation.md, §6).
  function shutdown() {
    console.error('Получен SIGTERM — останавливаюсь…');
    stopBackupSchedule?.();
    server.close(() => {
      store.close?.();
      process.exit(0);
    });
  }
  process.on('SIGTERM', shutdown);
}

export { handle, runBackup, DATABASE_BACKUP_DIR };
