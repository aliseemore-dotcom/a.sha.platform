// Сервис экрана «Мои мероприятия»: список, агрегаты внимания, создание, архив.
// Все функции получают ctx = { store, user, now (ms), timeZone }.

import {
  buildAttention, publicAttentionItem, activePreview, nextChangeAt,
} from './attention.js';
import { visibleEvents, canSeeEvent, hasPermission } from './access.js';
import { applyWeddingPlan } from './plan.js';
import { isValidDate, localDate } from './time.js';
import { publicTask, assignableUsers } from './tasks.js';
import { ServiceError } from './errors.js';

export { ServiceError };

export const PAGE_SIZE = 20;
export const ATTENTION_PREVIEW = 5;
export const TITLE_MAX = 100;
export const LOCATION_MAX = 150;

const notFound = () => new ServiceError(404, 'not_found', 'Проект не найден или недоступен');

// ---------- вспомогательное ----------

export function normalizeSearch(s) {
  return String(s ?? '').trim().toLocaleLowerCase('ru').replaceAll('ё', 'е');
}

function encodeCursor(offset) {
  return Buffer.from(JSON.stringify({ o: offset })).toString('base64url');
}

function decodeCursor(cursor) {
  if (!cursor) return 0;
  try {
    const { o } = JSON.parse(Buffer.from(String(cursor), 'base64url').toString());
    if (Number.isInteger(o) && o >= 0) return o;
  } catch { /* неверный курсор */ }
  throw new ServiceError(400, 'bad_cursor', 'Неверный курсор страницы');
}

function parseLimit(limit) {
  if (limit === undefined || limit === null || limit === '') return PAGE_SIZE;
  const n = Number(limit);
  if (!Number.isInteger(n) || n < 1) throw new ServiceError(400, 'bad_limit', 'Неверный limit');
  return Math.min(n, 50);
}

const collator = new Intl.Collator('ru', { sensitivity: 'base', numeric: true });
const byTitleId = (a, b) => collator.compare(a.title, b.title) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * «По дате» во вкладке «Активные»: будущие (включая сегодня) по возрастанию даты,
 * затем с прошедшей датой — сначала недавние, затем без даты; внутри групп — название, id.
 */
function byDateActive(today) {
  const group = (e) => (e.eventDate === null ? 2 : e.eventDate >= today ? 0 : 1);
  return (a, b) => {
    const ga = group(a);
    const gb = group(b);
    if (ga !== gb) return ga - gb;
    if (a.eventDate !== b.eventDate) {
      const asc = a.eventDate < b.eventDate ? -1 : 1;
      return ga === 0 ? asc : -asc;
    }
    return byTitleId(a, b);
  };
}

/** Архив: по дате события, сначала поздние; без даты — в конце. */
function byDateArchive(a, b) {
  if (a.eventDate !== b.eventDate) {
    if (a.eventDate === null) return 1;
    if (b.eventDate === null) return -1;
    return a.eventDate < b.eventDate ? 1 : -1;
  }
  return byTitleId(a, b);
}

function byAttention(today) {
  const date = byDateActive(today);
  return (a, b) => b.urgentCount - a.urgentCount || date(a, b);
}

/**
 * Единый снимок: карточки и агрегаты внимания считаются из одного прохода по данным,
 * поэтому счётчики блока и карточек не расходятся.
 */
function snapshot(ctx) {
  const { store, user, now, timeZone } = ctx;
  const events = visibleEvents(store, user);
  const tasksByEvent = store.tasksForEvents(events.map((e) => e.id));
  const attention = buildAttention({
    events, tasksByEvent, usersById: store.usersById(), now, timeZone,
  });

  const perEvent = new Map();
  for (const item of attention) {
    if (!perEvent.has(item.eventId)) perEvent.set(item.eventId, []);
    perEvent.get(item.eventId).push(item);
  }

  const activeTasks = [];
  const cards = events.map((e) => {
    const own = e.lifecycle === 'active' ? perEvent.get(e.id) ?? [] : [];
    const tasks = tasksByEvent.get(e.id) ?? [];
    if (e.lifecycle === 'active') activeTasks.push(...tasks);
    return {
      id: e.id,
      title: e.title,
      kind: e.kind,
      eventDate: e.eventDate,
      locationName: e.locationName,
      lifecycle: e.lifecycle,
      coverUrl: e.coverUrl ?? null,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
      planStatus: e.planStatus,
      urgentCount: own.length,
      urgentPreview: own.length ? publicAttentionItem(own[0]) : null,
      activePreview: e.lifecycle === 'active'
        ? activePreview(tasks, new Set(own.map((i) => i.id)), timeZone)
        : [],
      _search: normalizeSearch(`${e.title}\n${e.locationName ?? ''}`),
    };
  });

  return { cards, attention, refreshAt: nextChangeAt(activeTasks, now, timeZone) };
}

function publicCard({ _search, ...card }) {
  return card;
}

// ---------- список ----------

export function listEvents(ctx, query = {}) {
  const lifecycle = query.lifecycle === 'archived' ? 'archived' : 'active';
  // В архиве срочных сигналов нет, поэтому один порядок: по дате события, сначала поздние.
  const sort = lifecycle === 'archived' ? 'date_desc' : query.sort === 'attention' ? 'attention' : 'date';
  const q = normalizeSearch(query.q);
  const offset = decodeCursor(query.cursor);
  const limit = parseLimit(query.limit);

  const { cards, attention, refreshAt } = snapshot(ctx);

  // Счётчики вкладок — до поискового фильтра.
  const activeTotal = cards.filter((c) => c.lifecycle === 'active').length;
  const archivedTotal = cards.length - activeTotal;

  let list = cards.filter((c) => c.lifecycle === lifecycle);
  if (q) list = list.filter((c) => c._search.includes(q));
  const today = localDate(ctx.now, ctx.timeZone);
  list.sort(sort === 'date_desc' ? byDateArchive : sort === 'attention' ? byAttention(today) : byDateActive(today));

  const page = list.slice(offset, offset + limit);
  const nextOffset = offset + page.length;

  return {
    items: page.map(publicCard),
    total: list.length,
    sort,
    activeTotal,
    archivedTotal,
    nextCursor: nextOffset < list.length ? encodeCursor(nextOffset) : null,
    attentionTotal: attention.length,
    attentionPreview: attention.slice(0, ATTENTION_PREVIEW).map(publicAttentionItem),
    attentionNextCursor: attention.length > ATTENTION_PREVIEW ? encodeCursor(ATTENTION_PREVIEW) : null,
    timeZone: ctx.timeZone,
    serverNow: new Date(ctx.now).toISOString(),
    refreshAt: new Date(refreshAt).toISOString(),
  };
}

export function listAttention(ctx, query = {}) {
  const offset = decodeCursor(query.cursor);
  const limit = parseLimit(query.limit);
  const { attention } = snapshot(ctx);
  const page = attention.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return {
    items: page.map(publicAttentionItem),
    attentionTotal: attention.length,
    nextCursor: nextOffset < attention.length ? encodeCursor(nextOffset) : null,
  };
}

// ---------- один проект (минимум для перехода в обзор) ----------

export function getEvent(ctx, eventId) {
  const event = ctx.store.getEvent(eventId);
  if (!canSeeEvent(ctx.user, event)) throw notFound();
  const { cards, attention } = snapshot(ctx);
  const card = cards.find((c) => c.id === eventId);
  const tasks = ctx.store.tasksForEvents([eventId]).get(eventId);
  return {
    event: publicCard(card),
    attention: attention.filter((i) => i.eventId === eventId).map(publicAttentionItem),
    tasks: tasks.map((t) => publicTask(ctx, t)),
    // Кому можно назначить задачу — раздел 6 «Задачи мероприятия»: только те, у кого есть
    // доступ к этому проекту.
    teamMembers: assignableUsers(ctx.store, event).map((u) => ({ id: u.id, name: u.name })),
    canArchive: hasPermission(ctx.user, 'event:archive'),
    timeZone: ctx.timeZone,
  };
}

// ---------- создание ----------

export function validateCreate(body) {
  const fields = {};
  const title = typeof body?.title === 'string' ? body.title.trim() : '';
  if (!title) fields.title = 'Укажите название проекта';
  else if ([...title].length > TITLE_MAX) fields.title = `Не более ${TITLE_MAX} символов`;

  let eventDate = body?.eventDate ?? null;
  if (eventDate === '') eventDate = null;
  if (eventDate !== null && !isValidDate(eventDate)) fields.eventDate = 'Укажите дату полностью';

  let locationName = typeof body?.locationName === 'string' ? body.locationName.trim() : null;
  if (!locationName) locationName = null;
  if (locationName && [...locationName].length > LOCATION_MAX) fields.locationName = `Не более ${LOCATION_MAX} символов`;

  const key = body?.idempotencyKey;
  if (typeof key !== 'string' || key.length < 8 || key.length > 100) {
    throw new ServiceError(400, 'bad_idempotency_key', 'Нужен idempotencyKey');
  }
  if (Object.keys(fields).length) {
    throw new ServiceError(422, 'validation', 'Проверьте поля формы', fields);
  }
  return { title, eventDate, locationName, idempotencyKey: key };
}

function runPlan(ctx, event, applyPlan) {
  try {
    applyPlan(ctx.store, event, new Date(ctx.now).toISOString());
    ctx.store.updateEvent(event.id, { planStatus: 'ready' });
  } catch (err) {
    ctx.store.updateEvent(event.id, { planStatus: 'failed' });
    ctx.log?.(`plan failed for ${event.id}: ${err.message}`);
  }
  return ctx.store.getEvent(event.id).planStatus;
}

export function createEvent(ctx, body, { applyPlan = applyWeddingPlan } = {}) {
  if (!hasPermission(ctx.user, 'event:create')) {
    throw new ServiceError(403, 'forbidden', 'Нет права создавать проекты');
  }
  const input = validateCreate(body);

  const previous = ctx.store.getIdempotent(ctx.user.id, input.idempotencyKey);
  if (previous) {
    const event = ctx.store.getEvent(previous.eventId);
    return { eventId: previous.eventId, planStatus: event.planStatus, replayed: true };
  }

  const nowIso = new Date(ctx.now).toISOString();
  const event = {
    id: ctx.store.newId('evt'),
    workspaceId: ctx.user.workspaceId,
    title: input.title,
    kind: 'wedding',
    eventDate: input.eventDate,
    locationName: input.locationName,
    lifecycle: 'active',
    coverUrl: null,
    memberIds: ctx.user.role === 'owner' ? [] : [ctx.user.id],
    planStatus: 'pending',
    createdAt: nowIso,
    updatedAt: nowIso,
    createdBy: ctx.user.id,
  };
  ctx.store.insertEvent(event);
  // Ключ фиксируется сразу после записи проекта: повтор с тем же ключом не создаст дубль,
  // даже если построение плана упадёт.
  ctx.store.setIdempotent(ctx.user.id, input.idempotencyKey, { eventId: event.id });

  const planStatus = runPlan(ctx, event, applyPlan);
  return { eventId: event.id, planStatus };
}

export function retryPlan(ctx, eventId, { applyPlan = applyWeddingPlan } = {}) {
  const event = ctx.store.getEvent(eventId);
  if (!canSeeEvent(ctx.user, event)) throw notFound();
  if (!hasPermission(ctx.user, 'event:create')) {
    throw new ServiceError(403, 'forbidden', 'Нет права изменять план');
  }
  return { eventId, planStatus: runPlan(ctx, event, applyPlan) };
}

// ---------- архив ----------

function setLifecycle(ctx, eventId, lifecycle) {
  const event = ctx.store.getEvent(eventId);
  if (!canSeeEvent(ctx.user, event)) throw notFound();
  if (!hasPermission(ctx.user, 'event:archive')) {
    throw new ServiceError(403, 'forbidden', 'Нет права менять архив');
  }
  ctx.store.updateEvent(eventId, { lifecycle, updatedAt: new Date(ctx.now).toISOString() });
  return { eventId, lifecycle };
}

export const archiveEvent = (ctx, id) => setLifecycle(ctx, id, 'archived');
export const restoreEvent = (ctx, id) => setLifecycle(ctx, id, 'active');
