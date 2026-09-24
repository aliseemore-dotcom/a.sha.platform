// Панель «Добавить задачи»: готовый черновой набор задач свадьбы с выбором чекбоксами и
// примерными сроками (docs/specs/04-checklist.md). Переиспользует модель и идемпотентность
// задач (`server/tasks.js`) — тот же принцип уникальности по `templateKey`, что и у бывшего
// автоматического стартового плана (`server/plan.js`), просто без автозапуска при создании.

import { canSeeEvent } from './access.js';
import { isValidDate, addDays, localDate } from './time.js';
import { publicTask, blankTaskFields, requireMutable } from './tasks.js';
import { ServiceError } from './errors.js';

const notFound = () => new ServiceError(404, 'not_found', 'Проект не найден или недоступен');

// pctFrom/pctTo — доля оставшегося времени до свадьбы, в которую попадает срок (раздел
// «Примерные сроки» ТЗ «Выбор задач свадьбы»).
export const TASK_CHECKLIST = [
  { key: 'start-brief', section: 'Начало', title: 'Заполнить бриф пары', pctFrom: 0.10, pctTo: 0.20 },
  { key: 'start-format', section: 'Начало', title: 'Согласовать формат свадьбы', pctFrom: 0.10, pctTo: 0.20 },
  { key: 'start-budget', section: 'Начало', title: 'Определить ориентир бюджета', pctFrom: 0.10, pctTo: 0.20 },
  { key: 'venue-shortlist', section: 'Площадка', title: 'Подобрать площадки', pctFrom: 0.20, pctTo: 0.50 },
  { key: 'venue-confirm', section: 'Площадка', title: 'Подтвердить площадку', pctFrom: 0.20, pctTo: 0.50 },
  { key: 'vendors-define', section: 'Подрядчики', title: 'Определить нужных подрядчиков', pctFrom: 0.20, pctTo: 0.50 },
  { key: 'vendors-confirm', section: 'Подрядчики', title: 'Согласовать подрядчиков', pctFrom: 0.20, pctTo: 0.50 },
  { key: 'guests-list', section: 'Гости', title: 'Составить список гостей', pctFrom: 0.30, pctTo: 0.85 },
  { key: 'guests-invites', section: 'Гости', title: 'Отправить приглашения', pctFrom: 0.30, pctTo: 0.85 },
  { key: 'guests-seating', section: 'Гости', title: 'Подготовить рассадку', pctFrom: 0.30, pctTo: 0.85 },
  { key: 'day-menu', section: 'Подготовка дня', title: 'Согласовать меню', pctFrom: 0.50, pctTo: 0.95 },
  { key: 'day-timing', section: 'Подготовка дня', title: 'Подготовить тайминг', pctFrom: 0.50, pctTo: 0.95 },
  { key: 'day-final', section: 'Подготовка дня', title: 'Подтвердить финальный тайминг и договорённости', pctFrom: 0.50, pctTo: 0.95 },
];

const BY_KEY = new Map(TASK_CHECKLIST.map((item) => [item.key, item]));
const templateKeyOf = (key) => `checklist:${key}`;

function daysBetweenDates(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

/**
 * Случайный день внутри доли [pctFrom, pctTo] оставшегося времени до свадьбы; не раньше
 * сегодня и не позже даты свадьбы. `null`, если дата свадьбы неизвестна или уже прошла.
 */
function suggestDueDate(eventDate, today, pctFrom, pctTo) {
  if (!eventDate || eventDate <= today) return null;
  const totalDays = daysBetweenDates(today, eventDate);
  const from = Math.min(Math.floor(totalDays * pctFrom), totalDays);
  const to = Math.max(from, Math.min(Math.floor(totalDays * pctTo), totalDays));
  const offset = from + Math.floor(Math.random() * (to - from + 1));
  return addDays(today, offset);
}

/** Список пунктов панели: уже добавленные помечены, для остальных — предложенный срок. */
export function getChecklist(ctx, eventId) {
  const { store, user, now, timeZone } = ctx;
  const event = store.getEvent(eventId);
  if (!canSeeEvent(user, event)) throw notFound();
  const todayDate = localDate(now, timeZone);

  const items = TASK_CHECKLIST.map((item) => {
    const existing = store.findTaskByTemplateKey(eventId, templateKeyOf(item.key));
    return {
      key: item.key,
      section: item.section,
      title: item.title,
      added: Boolean(existing),
      suggestedDueDate: existing ? null : suggestDueDate(event.eventDate, todayDate, item.pctFrom, item.pctTo),
    };
  });
  return { items, eventDate: event.eventDate, canEdit: event.lifecycle === 'active' };
}

/**
 * Добавляет выбранные пункты. Уже добавленные (по `templateKey`) молча пропускаются — повторное
 * открытие панели и повторный клик не создают копий. `dueDate` — то, что выбрал/поправил
 * организатор в панели; сервер только проверяет формат, не пересчитывает срок заново.
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
  const created = [];
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
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    store.insertTask(task);
    created.push(task);
  }

  store.setIdempotent(user.id, key, { taskIds: created.map((t) => t.id) });
  return { added: created.length, tasks: created.map((t) => publicTask(ctx, t)) };
}
