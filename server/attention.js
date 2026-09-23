// Правила «Требует внимания» и «Сейчас в работе» (спецификация экрана 01, раздел 4).
// Чистые функции: время и часовой пояс передаются явно, чтобы правила можно было проверить тестами.

import { localDate, startOfLocalDay, addDays } from './time.js';

export const ATTENTION_PRIORITY = { overdue: 1, blocked: 2, due_today: 3, follow_up_due: 4 };

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

function followUpDate(task, timeZone) {
  if (!task.followUpAt) return null;
  return task.followUpAt.length > 10 ? localDate(Date.parse(task.followUpAt), timeZone) : task.followUpAt;
}

/** Вид внимания задачи или null. Один объект — один вид, с наивысшим приоритетом. */
export function classifyTask(task, now, timeZone) {
  if (CLOSED.has(task.status)) return null;
  const today = localDate(now, timeZone);

  const overdueAt = overdueFrom(task, timeZone);
  if (overdueAt !== null && now >= overdueAt) return 'overdue';

  if (task.status === 'blocked') return 'blocked';

  const dueDay = task.dueAt ? localDate(Date.parse(task.dueAt), timeZone) : task.dueDate;
  if (dueDay && dueDay === today) return 'due_today';

  if (task.status === 'waiting') {
    const follow = followUpDate(task, timeZone);
    if (follow && follow <= today) return 'follow_up_due';
  }
  return null;
}

function compareNullableLast(a, b) {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  return a < b ? -1 : 1;
}

/**
 * Сортировка списка внимания: приоритет вида → срок (у просроченных сначала более старый)
 * → дата свадьбы (неизвестная последней) → стабильный id.
 */
export function compareAttention(a, b) {
  return (
    ATTENTION_PRIORITY[a.kind] - ATTENTION_PRIORITY[b.kind] ||
    compareNullableLast(a.sortDue, b.sortDue) ||
    compareNullableLast(a.eventDate, b.eventDate) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

export function taskTargetUrl(task) {
  // Детальный маршрут задачи ещё не готов: открываем обзор проекта с фокусом на «Срочно решить».
  return `/events/${encodeURIComponent(task.eventId)}/overview?focus=attention&task=${encodeURIComponent(task.id)}`;
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
        followUpAt: task.followUpAt ?? null,
        ownerName: usersById.get(task.assigneeId)?.name ?? null,
        targetUrl: taskTargetUrl(task),
        sortDue: overdueFrom(task, timeZone),
        eventDate: event.eventDate,
      });
    }
  }
  items.sort(compareAttention);
  return items;
}

export function publicAttentionItem(item) {
  const { sortDue, eventDate, ...rest } = item;
  return rest;
}

/** «Сейчас в работе»: in_progress вне внимания, ближайший срок → updatedAt по убыванию, максимум 2. */
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
