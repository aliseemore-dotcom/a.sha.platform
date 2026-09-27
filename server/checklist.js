// Панель «Добавить задачи» и стартовый план свадьбы: готовый черновой набор из 13 задач
// (docs/specs/04-checklist.md, docs/specs/07-wedding-setup.md §3). Сроки — детерминированные
// (раздел «Сроки стартового плана» ТЗ 07): без даты свадьбы срока нет, короткий срок подготовки
// сжимает интервалы пропорционально, но не меняет порядок задач.

import { canSeeEvent } from './access.js';
import {
  isValidDate, addDays, daysBetween, localDate,
} from './time.js';
import { publicTask, blankTaskFields, requireMutable } from './tasks.js';
import { ServiceError } from './errors.js';

const notFound = () => new ServiceError(404, 'not_found', 'Проект не найден или недоступен');

// afterStartDays — от сегодняшнего дня («Начало»); beforeEventDays — от даты свадьбы (или от
// первого числа месяца, если известен только месяц). Значения временные (см. ТЗ 07, раздел 3.1).
export const TASK_CHECKLIST = [
  { key: 'start-brief', section: 'Начало', title: 'Заполнить бриф пары', afterStartDays: 7, label: 'в первую неделю' },
  { key: 'start-format', section: 'Начало', title: 'Согласовать формат свадьбы', afterStartDays: 14, label: 'в первые 2 недели' },
  { key: 'start-budget', section: 'Начало', title: 'Определить ориентир бюджета', afterStartDays: 14, label: 'в первые 2 недели' },
  { key: 'venue-shortlist', section: 'Площадка', title: 'Подобрать площадки', beforeEventDays: 300, label: 'за 10 мес. до свадьбы' },
  { key: 'venue-confirm', section: 'Площадка', title: 'Подтвердить площадку', beforeEventDays: 270, label: 'за 9 мес.' },
  { key: 'vendors-define', section: 'Подрядчики', title: 'Определить нужных подрядчиков', beforeEventDays: 270, label: 'за 9 мес.' },
  { key: 'vendors-confirm', section: 'Подрядчики', title: 'Согласовать подрядчиков', beforeEventDays: 180, label: 'за 6 мес.' },
  { key: 'guests-list', section: 'Гости', title: 'Составить список гостей', beforeEventDays: 180, label: 'за 6 мес.' },
  { key: 'guests-invites', section: 'Гости', title: 'Отправить приглашения', beforeEventDays: 90, label: 'за 3 мес.' },
  { key: 'day-menu', section: 'Подготовка дня', title: 'Согласовать меню', beforeEventDays: 60, label: 'за 2 мес.' },
  { key: 'day-timing', section: 'Подготовка дня', title: 'Подготовить тайминг', beforeEventDays: 30, label: 'за месяц' },
  { key: 'guests-seating', section: 'Гости', title: 'Подготовить рассадку', beforeEventDays: 21, label: 'за 3 недели' },
  { key: 'day-final', section: 'Подготовка дня', title: 'Подтвердить финальный тайминг и договорённости', beforeEventDays: 7, label: 'за неделю' },
];

const BY_KEY = new Map(TASK_CHECKLIST.map((item) => [item.key, item]));
const MAX_BEFORE = Math.max(...TASK_CHECKLIST.filter((i) => i.beforeEventDays != null).map((i) => i.beforeEventDays));
const templateKeyOf = (key) => `checklist:${key}`;
export const keyFromTemplateKey = (templateKey) => (templateKey?.startsWith('checklist:') ? templateKey.slice('checklist:'.length) : null);

/**
 * Сроки всех 13 пунктов разом (раздел «Короткий срок подготовки», ТЗ 07 §3.2) — чистая функция,
 * одинаковые входные данные всегда дают одинаковые даты. `eventDate` — дата свадьбы или первое
 * число месяца при `eventDatePrecision === 'month'`; `null`/дата в прошлом — сроков нет вовсе.
 * @returns {Map<string, string|null>} key → YYYY-MM-DD | null
 */
export function computeChecklistDueDates(eventDate, todayDate) {
  const result = new Map();
  if (!eventDate || eventDate <= todayDate) {
    for (const item of TASK_CHECKLIST) result.set(item.key, null);
    return result;
  }

  const daysLeft = daysBetween(todayDate, eventDate);
  const compressed = daysLeft < MAX_BEFORE + 14;
  const floor = addDays(todayDate, 14);

  let minOtherDue = null;
  for (const item of TASK_CHECKLIST) {
    if (item.beforeEventDays == null) continue;
    let due;
    if (!compressed) {
      due = addDays(eventDate, -item.beforeEventDays);
    } else {
      const shifted = Math.round((item.beforeEventDays * (daysLeft - 14)) / MAX_BEFORE);
      due = addDays(eventDate, -shifted);
      if (due < floor) due = floor;
      if (due > eventDate) due = eventDate;
    }
    result.set(item.key, due);
    if (minOtherDue === null || due < minOtherDue) minOtherDue = due;
  }

  // «Начало» — не позже чем за день до самой ранней задачи из других разделов.
  const startCap = minOtherDue !== null ? addDays(minOtherDue, -1) : eventDate;
  for (const item of TASK_CHECKLIST) {
    if (item.afterStartDays == null) continue;
    let due = addDays(todayDate, item.afterStartDays);
    if (due > startCap) due = startCap;
    result.set(item.key, due);
  }
  return result;
}

/** Список пунктов панели: уже добавленные помечены, для остальных — предложенный срок и подпись правила. */
export function getChecklist(ctx, eventId) {
  const { store, user, now, timeZone } = ctx;
  const event = store.getEvent(eventId);
  if (!canSeeEvent(user, event)) throw notFound();
  const todayDate = localDate(now, timeZone);
  const dueDates = computeChecklistDueDates(event.eventDate, todayDate);

  const items = TASK_CHECKLIST.map((item) => {
    const existing = store.findTaskByTemplateKey(eventId, templateKeyOf(item.key));
    return {
      key: item.key,
      section: item.section,
      title: item.title,
      ruleLabel: item.label,
      added: Boolean(existing),
      suggestedDueDate: existing ? null : dueDates.get(item.key),
    };
  });
  return { items, eventDate: event.eventDate, canEdit: event.lifecycle === 'active' };
}

/**
 * Добавляет выбранные пункты. Уже добавленные (по `templateKey`) молча пропускаются — повторное
 * открытие панели и повторный клик не создают копий. `dueDate` — то, что выбрал/поправил
 * организатор в панели; сервер только проверяет формат, не пересчитывает срок заново. `edited` —
 * тронул ли организатор предложенную дату: определяет `dueDateSource` (ТЗ 07, §3.3).
 */
export function addChecklistItems(ctx, eventId, body) {
  const { store, user, now } = ctx;
  const event = store.getEvent(eventId);
  requireMutable(user, event);

  const key = body?.idempotencyKey;
  if (typeof key !== 'string' || key.length < 8 || key.length > 100) {
    throw new ServiceError(400, 'bad_idempotency_key', 'Нужен idempotencyKey');
  }
  const previous = store.getIdempotent(user.id, key);
  if (previous) return { added: previous.taskIds.length, tasks: previous.taskIds.map((id) => publicTask(ctx, store.getTask(id))) };

  const requested = Array.isArray(body?.items) ? body.items : [];
  const nowIso = new Date(now).toISOString();
  // Несколько задач добавляются как одна операция (docs/specs/08-foundation.md, §1.4) — сбой
  // посреди списка не должен оставить часть пунктов добавленной, а часть — нет.
  const created = store.transaction(() => {
    const out = [];
    for (const raw of requested) {
      const item = BY_KEY.get(raw?.key);
      if (!item) continue;
      const templateKey = templateKeyOf(item.key);
      if (store.findTaskByTemplateKey(eventId, templateKey)) continue; // уже добавлена — пропускаем, не дублируем

      let dueDate = null;
      if (raw.dueDate) {
        if (!isValidDate(raw.dueDate)) throw new ServiceError(422, 'validation', 'Неверная дата', { dueDate: 'Укажите дату полностью' });
        dueDate = raw.dueDate;
      }

      const task = {
        id: store.newId('task'),
        eventId,
        templateKey,
        section: item.section,
        title: item.title,
        status: 'todo',
        ...blankTaskFields(),
        dueDate,
        dueDateSource: 'template', // ставится всегда, даже без срока — «срок придёт из плана»
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      if (raw.edited) task.dueDateSource = 'manual';
      store.insertTask(task);
      out.push(task);
    }
    return out;
  });

  store.setIdempotent(user.id, key, { taskIds: created.map((t) => t.id) });
  return { added: created.length, tasks: created.map((t) => publicTask(ctx, t)) };
}

/**
 * Стартовый план при создании свадьбы (ТЗ 07, §2.2) — те же 13 пунктов, тот же принцип
 * идемпотентности по `templateKey`, что и у ручного добавления через панель. Используется как
 * `applyPlan` в `createEvent`/`retryPlan` (server/events.js), поэтому подпись как у них:
 * `(store, event, nowIso, timeZone)`.
 */
export function applyChecklistPlan(store, event, nowIso, timeZone) {
  const todayDate = localDate(Date.parse(nowIso), timeZone);
  const dueDates = computeChecklistDueDates(event.eventDate, todayDate);
  for (const item of TASK_CHECKLIST) {
    const templateKey = templateKeyOf(item.key);
    if (store.findTaskByTemplateKey(event.id, templateKey)) continue;
    store.insertTask({
      id: store.newId('task'),
      eventId: event.id,
      templateKey,
      section: item.section,
      title: item.title,
      status: 'todo',
      ...blankTaskFields(),
      dueDate: dueDates.get(item.key),
      dueDateSource: 'template',
      createdAt: nowIso,
      updatedAt: nowIso,
    });
  }
}

/**
 * Пересчёт сроков после смены даты свадьбы (ТЗ 07, §1.3): только перечисленные задачи, только
 * открытые (закрытые уже не в `dueDateReview`, но проверяем и здесь на случай гонки), только из
 * стартового плана. `dueDateSource` становится `template` — организатор явно попросил применить
 * правило заново, в том числе для задач, где срок раньше меняли вручную.
 */
export function rescheduleTasks(ctx, eventId, body) {
  const { store, user, now, timeZone } = ctx;
  const event = store.getEvent(eventId);
  requireMutable(user, event);

  const key = body?.idempotencyKey;
  if (typeof key !== 'string' || key.length < 8 || key.length > 100) {
    throw new ServiceError(400, 'bad_idempotency_key', 'Нужен idempotencyKey');
  }
  const previous = store.getIdempotent(user.id, key);
  if (previous) return { updated: previous.taskIds.length, tasks: previous.taskIds.map((id) => publicTask(ctx, store.getTask(id))) };

  const todayDate = localDate(now, timeZone);
  const dueDates = computeChecklistDueDates(event.eventDate, todayDate);
  const nowIso = new Date(now).toISOString();
  const requestedIds = Array.isArray(body?.taskIds) ? body.taskIds : [];
  const updated = store.transaction(() => {
    const out = [];
    for (const taskId of requestedIds) {
      const task = store.getTask(taskId);
      if (!task || task.eventId !== eventId) continue;
      if (task.status === 'done' || task.status === 'cancelled') continue;
      const itemKey = keyFromTemplateKey(task.templateKey);
      if (!itemKey || !BY_KEY.has(itemKey)) continue;
      store.updateTask(task.id, {
        dueDate: dueDates.get(itemKey), dueAt: null, dueDateSource: 'template', updatedAt: nowIso,
      });
      out.push(task.id);
    }
    return out;
  });

  store.setIdempotent(user.id, key, { taskIds: updated });
  return { updated: updated.length, tasks: updated.map((id) => publicTask(ctx, store.getTask(id))) };
}

/**
 * Задачи стартового плана для диалога «Дата свадьбы изменилась» (ТЗ 07, §1.3): открытые задачи с
 * `templateKey` вида `checklist:*`, у которых уже стоит `dueDateSource` (`template` или `manual`).
 * `proposedDueDate` считается по новой дате свадьбы, сервер сам ничего не пересчитывает.
 */
export function buildDueDateReview(store, event, timeZone, now) {
  const todayDate = localDate(now, timeZone);
  const dueDates = computeChecklistDueDates(event.eventDate, todayDate);
  const tasks = store.tasksForEvents([event.id]).get(event.id) ?? [];
  const review = [];
  for (const task of tasks) {
    if (task.status === 'done' || task.status === 'cancelled') continue;
    const itemKey = keyFromTemplateKey(task.templateKey);
    if (!itemKey || !BY_KEY.has(itemKey) || !task.dueDateSource) continue;
    review.push({
      taskId: task.id,
      title: task.title,
      currentDueDate: task.dueDate ?? null,
      proposedDueDate: dueDates.get(itemKey),
      isManual: task.dueDateSource === 'manual',
    });
  }
  return review;
}
