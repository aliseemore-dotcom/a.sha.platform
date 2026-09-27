// Сервис экрана «Мои мероприятия»: список, агрегаты внимания, создание, архив, редактирование.
// Все функции получают ctx = { store, user, now (ms), timeZone }.

import {
  buildAttention, publicAttentionItem, activePreview, upcomingTasks, nextChangeAt,
} from './attention.js';
import { visibleEvents, canSeeEvent, hasPermission } from './access.js';
import { isValidDate, localDate } from './time.js';
import { publicTask, assignableUsers } from './tasks.js';
import { applyChecklistPlan, buildDueDateReview } from './checklist.js';
import { CURRENCIES } from './currencies.js';
import { ServiceError } from './errors.js';

export { ServiceError };

export const PAGE_SIZE = 20;
export const ATTENTION_PREVIEW = 5;
export const UPCOMING_HORIZON_DAYS = 14;
export const TITLE_MAX = 100;
export const NAME_MAX = 60;
export const LOCATION_MAX = 150;
export const GUESTS_MIN = 1;
export const GUESTS_MAX = 2000;
export const FORMAT_NOTES_MAX = 500;
export const WISHES_NOTES_MAX = 2000;
export const CONTACT_NAME_MAX = 100;
export const CONTACT_PHONE_MAX = 40;
export const CONTACT_EMAIL_MAX = 150;
export const CONTACTS_MAX = 4;
export const BUDGET_AMOUNT_MAX = 100_000_000;
export const CONTACT_RELATIONS = ['partner', 'parent', 'planner_side', 'other'];

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

// ---------- модель: значения по умолчанию для полей, которых не было до этого ТЗ ----------

/**
 * Свадьбы, созданные до этого ТЗ, не переписываются молча — недостающие поля подставляются
 * только при чтении (docs/specs/07-wedding-setup.md, §1.1). `eventDatePrecision` по умолчанию —
 * `day`, если дата уже была, иначе `null`.
 */
function withDefaults(e) {
  return {
    partner1Name: null,
    partner2Name: null,
    titleIsCustom: true,
    eventDatePrecision: e.eventDate ? 'day' : null,
    guestsCount: null,
    budgetTarget: null,
    contacts: [],
    formatNotes: null,
    wishesNotes: null,
    ...e,
  };
}

/** Шаги настройки свадьбы (§4.1) — из того же снимка, что и остальные счётчики. */
export function computeSetupSteps(store, event, tasks) {
  const hasContact = (event.contacts ?? []).some((c) => c.phone || c.email);
  const steps = [
    { key: 'date', done: event.eventDatePrecision === 'day' },
    { key: 'couple', done: Boolean(event.partner1Name) && Boolean(event.partner2Name) && hasContact },
    { key: 'plan', done: tasks.length > 0 },
    { key: 'vendors', done: store.eventVendorsForEvent(event.id).length > 0 },
    { key: 'budget', done: Boolean(event.budgetTarget) || store.budgetLinesForEvent(event.id).length > 0 },
  ];
  return { done: steps.filter((s) => s.done).length, total: steps.length, steps };
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
  const cards = events.map((rawEvent) => {
    const e = withDefaults(rawEvent);
    const own = e.lifecycle === 'active' ? perEvent.get(e.id) ?? [] : [];
    const tasks = tasksByEvent.get(e.id) ?? [];
    if (e.lifecycle === 'active') activeTasks.push(...tasks);
    const ownIds = new Set(own.map((i) => i.id));
    const upcoming = e.lifecycle === 'active'
      ? upcomingTasks(tasks, ownIds, store.usersById(), timeZone, now, UPCOMING_HORIZON_DAYS)
      : { items: [], nearestBeyond: null, hasAnyDue: false };
    return {
      id: e.id,
      title: e.title,
      titleIsCustom: e.titleIsCustom,
      partner1Name: e.partner1Name,
      partner2Name: e.partner2Name,
      kind: e.kind,
      eventDate: e.eventDate,
      eventDatePrecision: e.eventDatePrecision,
      locationName: e.locationName,
      guestsCount: e.guestsCount,
      budgetTarget: e.budgetTarget,
      contacts: e.contacts,
      formatNotes: e.formatNotes,
      wishesNotes: e.wishesNotes,
      lifecycle: e.lifecycle,
      coverUrl: e.coverUrl ?? null,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
      planStatus: e.planStatus,
      urgentCount: own.length,
      urgentPreview: own.length ? publicAttentionItem(own[0]) : null,
      activePreview: e.lifecycle === 'active'
        ? activePreview(tasks, ownIds, timeZone)
        : [],
      upcomingCount: upcoming.items.length,
      upcomingPreview: upcoming.items[0] ?? null,
      setup: computeSetupSteps(store, e, tasks),
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

// ---------- один проект (обзор) ----------

export function getEvent(ctx, eventId) {
  const event = ctx.store.getEvent(eventId);
  if (!canSeeEvent(ctx.user, event)) throw notFound();
  const { cards, attention } = snapshot(ctx);
  const card = cards.find((c) => c.id === eventId);
  const tasks = ctx.store.tasksForEvents([eventId]).get(eventId);
  const ownIds = new Set(attention.filter((i) => i.eventId === eventId).map((i) => i.id));
  const upcoming = card.lifecycle === 'active'
    ? upcomingTasks(tasks, ownIds, ctx.store.usersById(), ctx.timeZone, ctx.now, UPCOMING_HORIZON_DAYS)
    : { items: [], nearestBeyond: null, hasAnyDue: false };
  return {
    event: publicCard(card),
    attention: attention.filter((i) => i.eventId === eventId).map(publicAttentionItem),
    tasks: tasks.map((t) => publicTask(ctx, t)),
    upcoming,
    // Кому можно назначить задачу — раздел 6 «Задачи мероприятия»: только те, у кого есть
    // доступ к этому проекту.
    teamMembers: assignableUsers(ctx.store, event).map((u) => ({ id: u.id, name: u.name })),
    canArchive: hasPermission(ctx.user, 'event:archive'),
    timeZone: ctx.timeZone,
  };
}

// ---------- валидация полей (создание и правка) ----------

function trimmedOrNull(v, max) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t) return null;
  return [...t].length > max ? undefined : t; // undefined — сигнал «слишком длинно»
}

const composeTitle = (p1, p2) => [p1, p2].filter(Boolean).join(' + ');

/** Поля, общие для создания и правки: место, дата+точность, гости, бюджет, контакты, заметки. */
function validateCommonFields(body, { partial }, fields, patch) {
  if (!partial || 'locationName' in body) {
    const locationName = trimmedOrNull(body.locationName, LOCATION_MAX);
    if (locationName === undefined) fields.locationName = `Не более ${LOCATION_MAX} символов`;
    else patch.locationName = locationName;
  }

  if (!partial || 'eventDate' in body || 'eventDatePrecision' in body) {
    let precision = body.eventDatePrecision === 'month' ? 'month' : 'day';
    let eventDate = body.eventDate ?? null;
    if (eventDate === '') eventDate = null;
    if (eventDate !== null && !isValidDate(eventDate)) {
      fields.eventDate = 'Укажите дату полностью';
    } else {
      if (eventDate === null) precision = null;
      else if (precision === 'month') eventDate = `${eventDate.slice(0, 7)}-01`;
      patch.eventDate = eventDate;
      patch.eventDatePrecision = precision;
    }
  }

  if (!partial || 'guestsCount' in body) {
    if (body.guestsCount === null || body.guestsCount === '' || body.guestsCount === undefined) {
      patch.guestsCount = null;
    } else {
      const n = Number(body.guestsCount);
      if (!Number.isInteger(n) || n < GUESTS_MIN || n > GUESTS_MAX) fields.guestsCount = `Число от ${GUESTS_MIN} до ${GUESTS_MAX}`;
      else patch.guestsCount = n;
    }
  }

  if (!partial || 'budgetTarget' in body) {
    if (body.budgetTarget === null || body.budgetTarget === undefined) {
      patch.budgetTarget = null;
    } else {
      const amount = Number(body.budgetTarget.amount);
      if (!Number.isFinite(amount) || amount <= 0 || amount > BUDGET_AMOUNT_MAX) fields.budgetTarget = 'Укажите сумму числом';
      else if (!CURRENCIES.includes(body.budgetTarget.currency)) fields.budgetTarget = 'Выберите валюту';
      else patch.budgetTarget = { amount, currency: body.budgetTarget.currency };
    }
  }

  if (!partial || 'contacts' in body) {
    const raw = body.contacts ?? [];
    if (!Array.isArray(raw) || raw.length > CONTACTS_MAX) {
      fields.contacts = `Не более ${CONTACTS_MAX} контактов`;
    } else {
      const out = [];
      let bad = false;
      raw.forEach((c, i) => {
        const name = trimmedOrNull(c?.name, CONTACT_NAME_MAX);
        const phone = trimmedOrNull(c?.phone, CONTACT_PHONE_MAX);
        const email = trimmedOrNull(c?.email, CONTACT_EMAIL_MAX);
        const relation = CONTACT_RELATIONS.includes(c?.relation) ? c.relation : 'other';
        if (name === undefined || phone === undefined || email === undefined || !name || (!phone && !email)) { bad = true; return; }
        out.push({ id: typeof c?.id === 'string' && c.id ? c.id : `contact_${Date.now().toString(36)}_${i}`, name, relation, phone, email });
      });
      if (bad) fields.contacts = 'У каждого контакта — имя и телефон или email';
      else patch.contacts = out;
    }
  }

  if (!partial || 'formatNotes' in body) {
    const v = trimmedOrNull(body.formatNotes, FORMAT_NOTES_MAX);
    if (v === undefined) fields.formatNotes = `Не более ${FORMAT_NOTES_MAX} символов`;
    else patch.formatNotes = v;
  }
  if (!partial || 'wishesNotes' in body) {
    const v = trimmedOrNull(body.wishesNotes, WISHES_NOTES_MAX);
    if (v === undefined) fields.wishesNotes = `Не более ${WISHES_NOTES_MAX} символов`;
    else patch.wishesNotes = v;
  }
}

export function validateCreate(body) {
  const fields = {};
  const patch = {};
  validateCommonFields(body, { partial: false }, fields, patch);

  const p1 = trimmedOrNull(body.partner1Name, NAME_MAX);
  const p2 = trimmedOrNull(body.partner2Name, NAME_MAX);
  if (p1 === undefined) fields.partner1Name = `Не более ${NAME_MAX} символов`;
  if (p2 === undefined) fields.partner2Name = `Не более ${NAME_MAX} символов`;

  const providedTitle = trimmedOrNull(body.title, TITLE_MAX);
  if (providedTitle === undefined) fields.title = `Не более ${TITLE_MAX} символов`;

  let title;
  let titleIsCustom;
  if (!fields.partner1Name && !fields.partner2Name && !fields.title) {
    const hasName = Boolean(p1 || p2);
    if (providedTitle) { title = providedTitle; titleIsCustom = true; }
    else if (hasName) { title = composeTitle(p1, p2); titleIsCustom = false; }
    else fields.title = 'Укажите название проекта';
  }

  const key = body?.idempotencyKey;
  if (typeof key !== 'string' || key.length < 8 || key.length > 100) {
    throw new ServiceError(400, 'bad_idempotency_key', 'Нужен idempotencyKey');
  }
  if (Object.keys(fields).length) {
    throw new ServiceError(422, 'validation', 'Проверьте поля формы', fields);
  }
  return {
    ...patch, partner1Name: p1, partner2Name: p2, title, titleIsCustom, idempotencyKey: key,
    applyPlan: body?.applyPlan === true,
  };
}

// ---------- создание ----------

// Раньше сюда автоматически подставлялся стартовый план wedding_v1 (server/plan.js). Теперь
// набор задач — либо чек-лист при `applyPlan: true` (docs/specs/07-wedding-setup.md §2.2), либо
// организатор выбирает сам в панели «Добавить задачи» (server/checklist.js).
const noPlan = () => {};

function runPlan(ctx, event, applyPlan) {
  // Плана не оборачивается в транзакцию целиком (отступление от буквы §1.4 ТЗ 08 — см.
  // docs/HANDOFF.md): уже существующий и обязательный к сохранению тест «сбой плана не удаляет
  // проект» проверяет именно частичное применение — задачи, вставленные до сбоя, остаются,
  // повторный «Повторить создание плана» достраивает недостающее по тому же принципу
  // идемпотентности `templateKey`, что и ручное добавление. Откат всего плана целиком стёр бы
  // это поведение.
  try {
    applyPlan(ctx.store, event, new Date(ctx.now).toISOString(), ctx.timeZone);
    ctx.store.updateEvent(event.id, { planStatus: 'ready' });
  } catch (err) {
    ctx.store.updateEvent(event.id, { planStatus: 'failed' });
    ctx.log?.(`plan failed for ${event.id}: ${err.message}`);
  }
  return ctx.store.getEvent(event.id).planStatus;
}

export function createEvent(ctx, body, { applyPlan } = {}) {
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
    titleIsCustom: input.titleIsCustom,
    partner1Name: input.partner1Name,
    partner2Name: input.partner2Name,
    kind: 'wedding',
    eventDate: input.eventDate,
    eventDatePrecision: input.eventDatePrecision,
    locationName: input.locationName,
    guestsCount: input.guestsCount,
    budgetTarget: input.budgetTarget,
    contacts: input.contacts,
    formatNotes: input.formatNotes,
    wishesNotes: input.wishesNotes,
    lifecycle: 'active',
    coverUrl: null,
    memberIds: ctx.user.role === 'owner' ? [] : [ctx.user.id],
    planStatus: 'pending',
    createdAt: nowIso,
    updatedAt: nowIso,
    createdBy: ctx.user.id,
  };
  // Создание проекта и запись ключа идемпотентности — вместе (docs/specs/08-foundation.md, §1.4):
  // повтор с тем же ключом не должен увидеть проект без сохранённого ключа или наоборот.
  ctx.store.transaction(() => {
    ctx.store.insertEvent(event);
    ctx.store.setIdempotent(ctx.user.id, input.idempotencyKey, { eventId: event.id });
  });

  const effectiveApplyPlan = applyPlan ?? (input.applyPlan ? applyChecklistPlan : noPlan);
  const planStatus = runPlan(ctx, event, effectiveApplyPlan);
  return { eventId: event.id, planStatus };
}

export function retryPlan(ctx, eventId, { applyPlan = applyChecklistPlan } = {}) {
  const event = ctx.store.getEvent(eventId);
  if (!canSeeEvent(ctx.user, event)) throw notFound();
  if (!hasPermission(ctx.user, 'event:create')) {
    throw new ServiceError(403, 'forbidden', 'Нет права изменять план');
  }
  return { eventId, planStatus: runPlan(ctx, event, applyPlan) };
}

// ---------- редактирование ----------

function publicEventFields(e) {
  const d = withDefaults(e);
  return {
    id: d.id, title: d.title, titleIsCustom: d.titleIsCustom,
    partner1Name: d.partner1Name, partner2Name: d.partner2Name,
    kind: d.kind, eventDate: d.eventDate, eventDatePrecision: d.eventDatePrecision,
    locationName: d.locationName, guestsCount: d.guestsCount, budgetTarget: d.budgetTarget,
    contacts: d.contacts, formatNotes: d.formatNotes, wishesNotes: d.wishesNotes,
    lifecycle: d.lifecycle, coverUrl: d.coverUrl ?? null, planStatus: d.planStatus,
    createdAt: d.createdAt, updatedAt: d.updatedAt,
  };
}

/**
 * Пересобирает `title`, если он не кастомный (докс/specs/07-wedding-setup.md, §1.2):
 * `titleIsCustom: false` в запросе всегда пересобирает; явный `title` в запросе делает его
 * кастомным; смена имён при не-кастомном названии пересобирает его автоматически.
 */
function applyTitleLogic(body, patch, current) {
  const effectiveP1 = 'partner1Name' in patch ? patch.partner1Name : current.partner1Name ?? null;
  const effectiveP2 = 'partner2Name' in patch ? patch.partner2Name : current.partner2Name ?? null;
  const namesChanged = 'partner1Name' in patch || 'partner2Name' in patch;
  const currentCustom = current.titleIsCustom ?? true;

  if (body.titleIsCustom === false) {
    patch.title = composeTitle(effectiveP1, effectiveP2) || current.title;
    patch.titleIsCustom = false;
    return;
  }
  if ('title' in body) {
    const t = trimmedOrNull(body.title, TITLE_MAX);
    if (t) {
      patch.title = t;
      patch.titleIsCustom = true;
      return;
    }
  }
  if (namesChanged && !currentCustom) {
    patch.title = composeTitle(effectiveP1, effectiveP2) || current.title;
  }
}

/**
 * `PATCH /api/events/:id`: правит любое подмножество полей (докс/specs/07-wedding-setup.md, §1.2).
 * `expectedUpdatedAt` обязателен — расхождение с сохранённым значением означает, что данные уже
 * изменил кто-то другой; запись не перезаписывается. Архивная свадьба — только чтение.
 */
export function updateEvent(ctx, eventId, body) {
  const event = ctx.store.getEvent(eventId);
  if (!canSeeEvent(ctx.user, event)) throw notFound();
  if (event.lifecycle !== 'active') {
    throw new ServiceError(409, 'archived', 'Проект в архиве — доступен только для просмотра');
  }
  if (typeof body?.expectedUpdatedAt !== 'string' || !body.expectedUpdatedAt) {
    throw new ServiceError(400, 'bad_request', 'Нужен expectedUpdatedAt');
  }
  if (body.expectedUpdatedAt !== event.updatedAt) {
    throw new ServiceError(409, 'conflict', 'Данные изменил кто-то другой. Обновите страницу.');
  }

  const current = withDefaults(event);
  const fields = {};
  const patch = {};
  validateCommonFields(body, { partial: true }, fields, patch);

  if ('partner1Name' in body) {
    const p1 = trimmedOrNull(body.partner1Name, NAME_MAX);
    if (p1 === undefined) fields.partner1Name = `Не более ${NAME_MAX} символов`;
    else patch.partner1Name = p1;
  }
  if ('partner2Name' in body) {
    const p2 = trimmedOrNull(body.partner2Name, NAME_MAX);
    if (p2 === undefined) fields.partner2Name = `Не более ${NAME_MAX} символов`;
    else patch.partner2Name = p2;
  }
  if ('title' in body) {
    const t = trimmedOrNull(body.title, TITLE_MAX);
    if (t === undefined) fields.title = `Не более ${TITLE_MAX} символов`;
  }

  if (Object.keys(fields).length) throw new ServiceError(422, 'validation', 'Проверьте поля формы', fields);

  applyTitleLogic(body, patch, current);

  const dateTouched = 'eventDate' in patch;
  const dateChanged = dateTouched
    && (patch.eventDate !== current.eventDate || patch.eventDatePrecision !== current.eventDatePrecision);

  patch.updatedAt = new Date(ctx.now).toISOString();
  ctx.store.updateEvent(eventId, patch);
  const updated = ctx.store.getEvent(eventId);

  const result = publicEventFields(updated);
  // Дату убрали совсем — пересчитывать нечего и диалог не нужен (докс/specs/07-wedding-setup.md,
  // §1.3): существующие сроки остаются как есть.
  if (dateChanged && updated.eventDate !== null) {
    result.dueDateReview = buildDueDateReview(ctx.store, updated, ctx.timeZone, ctx.now);
  }
  return result;
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
