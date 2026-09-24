// Задачи мероприятия: список с поиском/фильтрами/сортировкой, создание, редактирование,
// переходы статуса, назначение, блокировка, завершение и восстановление.
// Спецификация: docs/specs/03-tasks.md. Все функции получают ctx = { store, user, now (ms), timeZone }.

import { classifyTask } from './attention.js';
import { canSeeEvent } from './access.js';
import { isValidDate, localDate } from './time.js';
import { ServiceError } from './errors.js';

export { ServiceError };

export const TITLE_MAX = 200;
export const DESCRIPTION_MAX = 4000;
export const BLOCKED_REASON_MAX = 300;
export const WAITING_FROM_MAX = 100;
export const PAGE_SIZE = 20;

// Рабочие статусы задачи. Блокировка — отдельный признак (`isBlocked`/`blockedReason`), не
// значение статуса: задача может быть одновременно `in_progress`/`waiting` и заблокирована.
export const STATUSES = ['todo', 'in_progress', 'waiting', 'done', 'cancelled'];
const OPEN_STATUSES = new Set(['todo', 'in_progress', 'waiting']);

const notFound = (msg = 'Проект не найден или недоступен') => new ServiceError(404, 'not_found', msg);
const taskNotFound = () => new ServiceError(404, 'task_not_found', 'Задача не найдена или недоступна');

/** Значения по умолчанию для новой задачи — используются и здесь, и стартовым планом (plan.js). */
export function blankTaskFields() {
  return {
    description: null,
    dueAt: null,
    dueDate: null,
    isBlocked: false,
    blockedReason: null,
    waitingFrom: null,
    followUpAt: null,
    completedAt: null,
    completedBy: null,
    previousStatus: null,
    assigneeId: null,
  };
}

// ---------- доступ ----------

/** Мутировать задачи может любой, кто видит проект, пока проект активен (архив — история, read-only). */
function requireMutable(user, event) {
  if (!canSeeEvent(user, event)) throw notFound();
  if (event.lifecycle !== 'active') {
    throw new ServiceError(409, 'archived', 'Проект в архиве — задачи доступны только для просмотра');
  }
}

/** Ответственным можно назначить только пользователя с доступом к этому проекту (раздел 6). */
export function assignableUsers(store, event) {
  return store.listUsers().filter((u) => u.workspaceId === event.workspaceId
    && (u.role === 'owner' || (event.memberIds ?? []).includes(u.id)));
}

// ---------- представление ----------

export function publicTask(ctx, t) {
  const { store, timeZone, now } = ctx;
  return {
    id: t.id,
    title: t.title,
    description: t.description ?? null,
    section: t.section ?? null,
    status: t.status,
    isBlocked: Boolean(t.isBlocked),
    blockedReason: t.blockedReason ?? null,
    dueAt: t.dueAt ?? null,
    dueDate: t.dueDate ?? null,
    waitingFrom: t.waitingFrom ?? null,
    followUpAt: t.followUpAt ?? null,
    assigneeId: t.assigneeId ?? null,
    assigneeName: store.getUser(t.assigneeId)?.name ?? null,
    completedAt: t.completedAt ?? null,
    completedByName: store.getUser(t.completedBy)?.name ?? null,
    templateKey: t.templateKey ?? null,
    attentionKind: classifyTask(t, now, timeZone),
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

// ---------- список ----------

function normalize(s) {
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

function dueSortValue(t) {
  if (t.dueAt) return Date.parse(t.dueAt);
  if (t.dueDate) return Date.parse(`${t.dueDate}T23:59:59`);
  return null;
}

/**
 * «Сначала требующие внимания» (раздел 4): заблокированные, затем просроченные по давности
 * срока (старший срок — то есть меньшая метка времени — выше), затем срок сегодня по времени,
 * затем остальные по ближайшему сроку; без срока — в конце. Возрастание метки времени даёт
 * ровно этот порядок во всех группах разом, отдельная ветка не нужна.
 */
function byAttentionThenDue(a, b) {
  const rank = (t) => (t.isBlocked ? 0 : t.attentionKind === 'overdue' ? 1 : t.attentionKind === 'due_today' ? 2 : 3);
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  const da = dueSortValue(a);
  const db = dueSortValue(b);
  if (da !== db) {
    if (da === null) return 1;
    if (db === null) return -1;
    return da - db;
  }
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : (a.id < b.id ? -1 : 1);
}

function byDueDate(a, b) {
  const da = dueSortValue(a);
  const db = dueSortValue(b);
  if (da === db) return a.id < b.id ? -1 : 1;
  if (da === null) return 1;
  if (db === null) return -1;
  return da - db;
}

function byCreatedDesc(a, b) {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.id < b.id ? -1 : 1;
}

function byCompletedDesc(a, b) {
  const ca = a.completedAt ?? a.updatedAt;
  const cb = b.completedAt ?? b.updatedAt;
  if (ca !== cb) return ca < cb ? 1 : -1;
  return a.id < b.id ? -1 : 1;
}

/**
 * Список задач одного проекта: поиск (title/description, только внутри проекта), фильтры,
 * сортировка, пагинация. Числа найденного и общего — раздельно (раздел 4).
 */
export function listTasks(ctx, eventId, query = {}) {
  const { store, user, timeZone, now } = ctx;
  const event = store.getEvent(eventId);
  if (!canSeeEvent(user, event)) throw notFound();

  const rawTasks = store.tasksForEvents([eventId]).get(eventId) ?? [];
  const all = rawTasks.map((t) => publicTask(ctx, t));

  const tab = query.tab === 'done' ? 'done' : query.tab === 'cancelled' ? 'cancelled' : 'open';
  const openTotal = all.filter((t) => OPEN_STATUSES.has(t.status)).length;
  const doneTotal = all.filter((t) => t.status === 'done').length;
  const cancelledTotal = all.filter((t) => t.status === 'cancelled').length;

  let list = all.filter((t) => (tab === 'open' ? OPEN_STATUSES.has(t.status) : t.status === tab));

  const q = normalize(query.q);
  if (q) list = list.filter((t) => normalize(`${t.title}\n${t.description ?? ''}`).includes(q));

  if (query.assignee === 'unassigned') list = list.filter((t) => !t.assigneeId);
  else if (query.assignee) list = list.filter((t) => t.assigneeId === query.assignee);

  if (query.status && OPEN_STATUSES.has(query.status)) list = list.filter((t) => t.status === query.status);
  if (query.attention === '1') list = list.filter((t) => t.attentionKind !== null);
  if (query.noDue === '1') list = list.filter((t) => !t.dueAt && !t.dueDate);
  if (query.followup === '1') {
    const today = localDate(now, timeZone);
    list = list.filter((t) => t.status === 'waiting' && t.followUpAt
      && (t.followUpAt.length > 10 ? localDate(Date.parse(t.followUpAt), timeZone) : t.followUpAt) <= today);
  }

  const matchedTotal = list.length;

  const sort = tab === 'open'
    ? (query.sort === 'due' ? 'due' : query.sort === 'created' ? 'created' : 'attention')
    : 'completed';
  const comparator = { attention: byAttentionThenDue, due: byDueDate, created: byCreatedDesc, completed: byCompletedDesc }[sort];
  list.sort(comparator);

  const offset = decodeCursor(query.cursor);
  const limit = Math.min(Math.max(Number(query.limit) || PAGE_SIZE, 1), 50);
  const page = list.slice(offset, offset + limit);
  const nextOffset = offset + page.length;

  return {
    items: page,
    matchedTotal,
    openTotal,
    doneTotal,
    cancelledTotal,
    tab,
    sort,
    nextCursor: nextOffset < list.length ? encodeCursor(nextOffset) : null,
  };
}

// ---------- валидация ----------

function trimmedOrNull(v, max) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t) return null;
  return [...t].length > max ? undefined : t; // undefined — сигнал «слишком длинно», отличим от «пусто»
}

/**
 * Проверяет входные поля создания/редактирования. `partial` — при редактировании: поле,
 * отсутствующее в теле запроса, не проверяется и не меняется (кроме зависимых очисток).
 */
function validateFields(body, event, store, { partial }) {
  const fields = {};
  const patch = {};

  if (!partial || 'title' in body) {
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) fields.title = 'Укажите, что нужно сделать';
    else if ([...title].length > TITLE_MAX) fields.title = `Не более ${TITLE_MAX} символов`;
    else patch.title = title;
  }

  if ('description' in body) {
    const d = trimmedOrNull(body.description, DESCRIPTION_MAX);
    if (d === undefined) fields.description = `Не более ${DESCRIPTION_MAX} символов`;
    else patch.description = d;
  }

  if ('status' in body) {
    if (!STATUSES.includes(body.status)) fields.status = 'Неизвестный статус';
    else patch.status = body.status;
  }

  if ('assigneeId' in body) {
    if (body.assigneeId === null || body.assigneeId === '') patch.assigneeId = null;
    else if (!assignableUsers(store, event).some((u) => u.id === body.assigneeId)) {
      fields.assigneeId = 'Этот человек не имеет доступа к проекту';
    } else patch.assigneeId = body.assigneeId;
  }

  // Срок выполнения: дата и необязательное время. Раздельные поля — не путать с контролем ожидания.
  if ('dueDate' in body || 'dueTime' in body || 'hasDue' in body) {
    if (body.hasDue === false || (!body.dueDate && !body.hasDue)) {
      patch.dueAt = null;
      patch.dueDate = null;
    } else if (!isValidDate(body.dueDate)) {
      fields.dueDate = 'Укажите дату полностью';
    } else if (body.dueTime) {
      if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(body.dueTime)) {
        fields.dueDate = 'Неверное время';
      } else {
        patch.dueAt = new Date(`${body.dueDate}T${body.dueTime}:00`).toISOString();
        patch.dueDate = null;
      }
    } else {
      patch.dueDate = body.dueDate;
      patch.dueAt = null;
    }
  }

  if ('isBlocked' in body) {
    const isBlocked = Boolean(body.isBlocked);
    patch.isBlocked = isBlocked;
    if (isBlocked) {
      const reason = trimmedOrNull(body.blockedReason, BLOCKED_REASON_MAX);
      if (!reason) fields.blockedReason = 'Укажите причину блокировки';
      else patch.blockedReason = reason;
    } else {
      patch.blockedReason = null;
    }
  }

  const effectiveStatus = patch.status ?? undefined;
  if ('waitingFrom' in body) {
    const w = trimmedOrNull(body.waitingFrom, WAITING_FROM_MAX);
    if (w === undefined) fields.waitingFrom = `Не более ${WAITING_FROM_MAX} символов`;
    else patch.waitingFrom = w;
  }
  if ('followUpAt' in body) {
    if (!body.followUpAt) patch.followUpAt = null;
    else if (!isValidDate(body.followUpAt)) fields.followUpAt = 'Укажите дату полностью';
    else patch.followUpAt = body.followUpAt;
  }
  // Контроль ответа осмыслен только для waiting — вне его не показывается и не хранится «сиротой».
  if (effectiveStatus && effectiveStatus !== 'waiting' && !partial) {
    patch.waitingFrom = null;
    patch.followUpAt = null;
  }

  if (Object.keys(fields).length) throw new ServiceError(422, 'validation', 'Проверьте поля формы', fields);
  return patch;
}

export function createTask(ctx, eventId, body) {
  const { store, user, now } = ctx;
  const event = store.getEvent(eventId);
  requireMutable(user, event);

  const key = body?.idempotencyKey;
  if (typeof key !== 'string' || key.length < 8 || key.length > 100) {
    throw new ServiceError(400, 'bad_idempotency_key', 'Нужен idempotencyKey');
  }
  // Ключ выдаётся один на попытку сохранения формы: повтор с тем же ключом (двойное
  // нажатие «Сохранить», повтор после сетевого сбоя) возвращает уже созданную задачу.
  const previous = store.getIdempotent(user.id, key);
  if (previous) return publicTask(ctx, store.getTask(previous.taskId));

  const patch = validateFields({ status: 'todo', ...body }, event, store, { partial: false });
  const nowIso = new Date(now).toISOString();
  const task = {
    id: store.newId('task'),
    eventId,
    section: null,
    ...blankTaskFields(),
    ...patch,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  store.insertTask(task);
  store.setIdempotent(user.id, key, { taskId: task.id });
  return publicTask(ctx, task);
}

function getOwnedTask(store, user, eventId, taskId) {
  const event = store.getEvent(eventId);
  if (!canSeeEvent(user, event)) throw notFound();
  const task = store.getTask(taskId);
  if (!task || task.eventId !== eventId) throw taskNotFound();
  return { event, task };
}

export function getTask(ctx, eventId, taskId) {
  const { store, user } = ctx;
  const { task } = getOwnedTask(store, user, eventId, taskId);
  return publicTask(ctx, task);
}

/**
 * Частичное обновление, включая переходы статуса. Побочные эффекты (раздел 5.2):
 *  → done: фиксирует completedAt/completedBy и предыдущий статус, снимает активные
 *    блокировку и ожидание (аудита у них нет — иначе они читались бы как всё ещё активные);
 *  из done: возвращает предыдущий рабочий статус, если явно не указан другой;
 *  из waiting в другой статус: снимает адресата и контроль ожидания.
 * `expectedUpdatedAt` — защита от тихой перезаписи параллельной правки (раздел 6).
 */
export function updateTask(ctx, eventId, taskId, body) {
  const { store, user, now } = ctx;
  const { event, task } = getOwnedTask(store, user, eventId, taskId);
  requireMutable(user, event);

  if (body.expectedUpdatedAt && body.expectedUpdatedAt !== task.updatedAt) {
    throw new ServiceError(409, 'conflict', 'Задачу уже изменил другой участник', null);
  }

  const patch = validateFields(body, event, store, { partial: true });
  const prevStatus = task.status;

  if (patch.status === 'done' && prevStatus !== 'done') {
    patch.completedAt = new Date(now).toISOString();
    patch.completedBy = user.id;
    patch.previousStatus = prevStatus;
    patch.isBlocked = false;
    patch.blockedReason = null;
    patch.waitingFrom = null;
    patch.followUpAt = null;
  } else if (patch.status && patch.status !== 'done' && prevStatus === 'done') {
    patch.completedAt = null;
    patch.completedBy = null;
  }
  if (patch.status && patch.status !== 'waiting' && prevStatus === 'waiting' && patch.status !== 'done') {
    patch.waitingFrom = null;
    patch.followUpAt = null;
  }

  patch.updatedAt = new Date(now).toISOString();
  store.updateTask(taskId, patch);
  return publicTask(ctx, store.getTask(taskId));
}

/** Отметить выполненной — частный случай updateTask, сохранён отдельным действием карточки/списков. */
export function completeTask(ctx, eventId, taskId) {
  return updateTask(ctx, eventId, taskId, { status: 'done' });
}

/** Вернуть в работу: предыдущий рабочий статус, если он сохранён, иначе todo. */
export function restoreTask(ctx, eventId, taskId) {
  const { store, user } = ctx;
  const { task } = getOwnedTask(store, user, eventId, taskId);
  if (task.status !== 'done') throw new ServiceError(409, 'not_done', 'Задача не завершена');
  return updateTask(ctx, eventId, taskId, { status: task.previousStatus ?? 'todo' });
}
