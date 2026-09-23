// HTTP-сервер: API экрана «Мои мероприятия» + раздача статического интерфейса.
// Без зависимостей, Node ≥ 20.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStore } from './store.js';
import {
  listEvents, listAttention, getEvent, createEvent, retryPlan,
  archiveEvent, restoreEvent, completeTask, ServiceError,
} from './events.js';
import { hasPermission } from './access.js';
import { isValidTimeZone } from './time.js';
import { seedDemo, DEMO_TIME_ZONE } from './demo/seed.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const PORT = Number(process.env.PORT ?? 3000);
const DEMO = process.env.DEMO !== '0';
const BODY_LIMIT = 16 * 1024;

const store = createStore();
if (DEMO) seedDemo(store);

// ---------- сессии ----------
// Системы входа в проекте пока нет. На тестовом стенде вход — выбор демо-пользователя.
// Сессия — случайный идентификатор в HttpOnly cookie, данные сессии только на сервере.

const sessions = new Map();

function readCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function currentUser(req) {
  const sid = readCookies(req).sid;
  const userId = sid && sessions.get(sid);
  return userId ? store.getUser(userId) : null;
}

function sessionCookie(value, maxAge) {
  return `sid=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

/** Внутренний безопасный путь для returnTo: только «/…», без «//» и схем. */
export function safeReturnTo(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
    return '/events';
  }
  return value;
}

// ---------- часовой пояс ----------
// Приоритет: настройка пространства → на тестовом стенде Europe/Moscow → пояс устройства
// (заголовок X-Time-Zone от клиента) → UTC.

function resolveTimeZone(user, req) {
  const ws = store.getWorkspace(user.workspaceId);
  if (ws?.timeZone && isValidTimeZone(ws.timeZone)) return ws.timeZone;
  if (DEMO) return DEMO_TIME_ZONE;
  const clientTz = req.headers['x-time-zone'];
  if (isValidTimeZone(clientTz)) return clientTz;
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
    // JSON-only защищает POST от межсайтовых форм (вместе с SameSite=Lax).
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

// ---------- API ----------

async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method;

  if (pathname === '/api/demo-users' && method === 'GET') {
    if (!DEMO) return apiError(res, 404, 'not_found', 'Не найдено');
    return json(res, 200, {
      users: store.listUsers().map(({ id, name, role, note }) => ({ id, name, role, note })),
    });
  }

  if (pathname === '/api/session' && method === 'POST') {
    if (!DEMO) return apiError(res, 404, 'not_found', 'Вход не настроен');
    const body = await readJson(req);
    const user = store.getUser(body.userId);
    if (!user) return apiError(res, 400, 'bad_user', 'Пользователь не найден');
    const sid = randomBytes(24).toString('base64url');
    sessions.set(sid, user.id);
    return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(sid, 60 * 60 * 24 * 30) });
  }

  if (pathname === '/api/session' && method === 'DELETE') {
    const sid = readCookies(req).sid;
    if (sid) sessions.delete(sid);
    return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
  }

  const user = currentUser(req);
  if (!user) return apiError(res, 401, 'unauthorized', 'Нужно войти');

  const ctx = {
    store, user, now: Date.now(), timeZone: resolveTimeZone(user, req),
    log: (m) => console.error(m),
  };

  if (pathname === '/api/session' && method === 'GET') {
    const ws = store.getWorkspace(user.workspaceId);
    return json(res, 200, {
      user: { id: user.id, name: user.name, role: user.role },
      workspace: { id: ws.id, name: ws.name },
      permissions: { createEvent: hasPermission(user, 'event:create') },
      demo: DEMO,
    });
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

  const t = pathname.match(/^\/api\/events\/([A-Za-z0-9_-]{1,64})\/tasks\/([A-Za-z0-9_-]{1,64})\/complete$/);
  if (t && method === 'POST') {
    await readJson(req);
    return json(res, 200, completeTask(ctx, t[1], t[2]));
  }

  const m = pathname.match(/^\/api\/events\/([A-Za-z0-9_-]{1,64})(?:\/(archive|restore|plan))?$/);
  if (m) {
    const [, id, action] = m;
    if (!action && method === 'GET') return json(res, 200, getEvent(ctx, id));
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

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);

    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method Not Allowed');

    if (url.pathname.startsWith('/fonts/') && (await serveFile(res, url.pathname, 'public, max-age=604800'))) return;
    if (/^\/(styles|js)\//.test(url.pathname) && (await serveFile(res, url.pathname))) return;

    // Страницы приложения. Без сессии — на вход с безопасным returnTo.
    if (url.pathname === '/login') return void (await serveFile(res, 'index.html'));
    if (!currentUser(req)) {
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createServer(handle).listen(PORT, () => {
    console.log(`http://localhost:${PORT}  ${DEMO ? '(тестовый стенд, демо-данные)' : ''}`);
  });
}

export { handle };
