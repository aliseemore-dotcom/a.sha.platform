// Правила «Требует внимания» и «В работе» (экран 01, итерация 2, раздел 2).
// Чистые функции: время и часовой пояс передаются явно, чтобы правила можно было проверить тестами.

import { localDate, startOfLocalDay, addDays } from './time.js';

/**
 * Причина строки внимания (какой чип показать) определяется по приоритету
 * blocked → overdue → due_today: заблокированная и одновременно просроченная задача — одна
 * строка «Заблокировано», не две. Это про ярлык одной задачи, не про порядок списка ниже.
 *
 * Порядок списка (точечное ТЗ, п. 1) — предсказуемый приоритет без отдельной новой модели,
 * тем же полем `kind`, что и ярлык: 1) просроченные, 2) с ближайшим сроком («Сегодня»),
 * 3) заблокированные (и не просроченные, и не сегодня — иначе см. абзац выше).
 *
 * «Нужно напомнить» (ожидание ответа) сознательно не считается сигналом внимания: у него ещё
 * нет подтверждённого источника данных и правила наступления/снятия напоминания (итерация 3,
 * уточнение). Статус `waiting` при этом продолжает существовать и виден в списке задач проекта.
 */
export const ATTENTION_GROUP = { overdue: 1, due_today: 2, blocked: 3 };

const CLOSED = new Set(['done', 'cancelled']);

/**
 * Срок задачи хранится с точностью:
 *   dueAt   — ISO timestamp, срок со временем;
 *   dueDate — YYYY-MM-DD, срок на весь день.
 * Заполнено не более одного из полей.
 */

/** Момент, когда задача становится просроченной; null — срока нет. */
export function overdueFrom(task, timeZone) {
  if (task.dueAt) return Date.parse(task.dueAt);
  if (task.dueDate) return startOfLocalDay(addDays(task.dueDate, 1), timeZone);
  return null;
}

/** Вид внимания задачи или null. Одна задача — один вид, с наивысшим приоритетом. */
export function classifyTask(task, now, timeZone) {
  if (CLOSED.has(task.status)) return null;
  // Блокировка — отдельный признак задачи (не значение status), из просрочки не выводится.
  // Задача может быть одновременно in_progress/waiting и заблокированной (задачи «Мои
  // мероприятия» и обзора, раздел «Задачи мероприятия» v1, §2).
  if (task.isBlocked) return 'blocked';

  const overdueAt = overdueFrom(task, timeZone);
  if (overdueAt !== null && now >= overdueAt) return 'overdue';

  const dueDay = task.dueAt ? localDate(Date.parse(task.dueAt), timeZone) : task.dueDate;
  if (dueDay && dueDay === localDate(now, timeZone)) return 'due_today';

  return null;
}

function compareNullableLast(a, b) {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  return a < b ? -1 : 1;
}

const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Сортировка списка внимания: группа → более старый срок выше (без срока — в конце группы)
 * → стабильно по id проекта и id задачи.
 */
export function compareAttention(a, b) {
  return (
    ATTENTION_GROUP[a.kind] - ATTENTION_GROUP[b.kind] ||
    compareNullableLast(a.sortDue, b.sortDue) ||
    byString(a.eventId, b.eventId) ||
    byString(a.id, b.id)
  );
}

/** Прямой маршрут конкретной задачи в проекте; работает после обновления страницы. */
export function taskTargetUrl(task) {
  return `/events/${encodeURIComponent(task.eventId)}/tasks/${encodeURIComponent(task.id)}`;
}

/** Элементы внимания по набору активных проектов, отсортированные. */
export function buildAttention({ events, tasksByEvent, usersById, now, timeZone }) {
  const items = [];
  for (const event of events) {
    if (event.lifecycle !== 'active') continue;
    for (const task of tasksByEvent.get(event.id) ?? []) {
      const kind = classifyTask(task, now, timeZone);
      if (!kind) continue;
      items.push({
        id: task.id,
        eventId: event.id,
        eventTitle: event.title,
        title: task.title,
        kind,
        dueAt: task.dueAt ?? null,
        dueDate: task.dueDate ?? null,
        ownerName: usersById.get(task.assigneeId)?.name ?? null,
        targetUrl: taskTargetUrl(task),
        sortDue: overdueFrom(task, timeZone),
      });
    }
  }
  items.sort(compareAttention);
  return items;
}

export function publicAttentionItem(item) {
  const { sortDue, ...rest } = item;
  return rest;
}

/** «В работе»: in_progress вне внимания, ближайший срок → updatedAt по убыванию, максимум 2. */
export function activePreview(tasks, attentionIds, timeZone) {
  return tasks
    .filter((t) => t.status === 'in_progress' && !attentionIds.has(t.id))
    .sort((a, b) =>
      compareNullableLast(overdueFrom(a, timeZone), overdueFrom(b, timeZone)) ||
      (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
    .slice(0, 2)
    .map((t) => ({ id: t.id, title: t.title }));
}

/**
 * «Дальше» (ТЗ 07, §5.1): открытые `todo`-задачи со сроком в ближайшие `horizonDays` дней
 * (с завтрашнего дня включительно), не показанные в «Требует внимания». `in_progress`/`waiting`
 * туда не попадают никогда — они уже показаны в «В работе»/«Ждём ответа». Считается на сервере,
 * а не только на клиенте, чтобы число на обзоре и на карточке списка не расходилось.
 */
export function upcomingTasks(tasks, attentionIds, usersById, timeZone, now, horizonDays = 14) {
  const today = localDate(now, timeZone);
  const tomorrow = addDays(today, 1);
  const horizon = addDays(today, horizonDays);
  const dueDay = (t) => (t.dueAt ? localDate(Date.parse(t.dueAt), timeZone) : t.dueDate);
  const sortValue = (t) => (t.dueAt ? Date.parse(t.dueAt) : Date.parse(`${t.dueDate}T23:59:59`));

  const withDue = tasks.filter((t) => t.status === 'todo' && !attentionIds.has(t.id) && dueDay(t));
  const inWindow = withDue.filter((t) => dueDay(t) >= tomorrow && dueDay(t) <= horizon);
  inWindow.sort((a, b) =>
    sortValue(a) - sortValue(b)
    || (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0)
    || (a.id < b.id ? -1 : 1));

  let nearestBeyond = null;
  if (!inWindow.length) {
    const beyond = withDue.filter((t) => dueDay(t) > horizon).sort((a, b) => sortValue(a) - sortValue(b));
    nearestBeyond = beyond[0] ?? null;
  }

  const toPublic = (t) => ({
    id: t.id, title: t.title, dueAt: t.dueAt ?? null, dueDate: t.dueDate ?? null,
    ownerName: usersById.get(t.assigneeId)?.name ?? null, targetUrl: taskTargetUrl(t),
  });
  return {
    items: inWindow.map(toPublic),
    nearestBeyond: nearestBeyond ? toPublic(nearestBeyond) : null,
    hasAnyDue: withDue.length > 0,
  };
}

/**
 * Ближайший момент, когда классификация может измениться сама по себе:
 * наступление dueAt или начало следующего календарного дня.
 */
export function nextChangeAt(tasks, now, timeZone) {
  let next = startOfLocalDay(addDays(localDate(now, timeZone), 1), timeZone);
  for (const t of tasks) {
    if (CLOSED.has(t.status) || !t.dueAt) continue;
    const at = Date.parse(t.dueAt);
    if (at > now && at < next) next = at;
  }
  return next;
}
