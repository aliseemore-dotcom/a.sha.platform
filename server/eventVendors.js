// Подрядчики внутри конкретной свадьбы (docs/specs/05-vendors.md, раздел 2). Организатор выбирает
// кандидатов из своей личной базы (server/vendors.js); в проект попадает копия данных на момент
// выбора — правка личной записи позже не меняет уже сохранённую карточку в свадьбе.

import { canSeeEvent } from './access.js';
import { requireMutable } from './tasks.js';
import { publicVendor } from './vendors.js';
import { ServiceError } from './errors.js';

const notFound = () => new ServiceError(404, 'not_found', 'Проект не найден или недоступен');
const linkNotFound = () => new ServiceError(404, 'not_found', 'Подрядчик не найден в этой свадьбе');

function publicEventVendor(ev) {
  return {
    id: ev.id, vendorId: ev.sourceVendorId, category: ev.category, name: ev.name,
    phone: ev.phone, link: ev.link, note: ev.note, status: ev.status,
    createdAt: ev.createdAt, updatedAt: ev.updatedAt,
  };
}

/** Подрядчики свадьбы, сгруппированные по категориям на клиенте — здесь просто плоский список. */
export function listEventVendors(ctx, eventId) {
  const event = ctx.store.getEvent(eventId);
  if (!canSeeEvent(ctx.user, event)) throw notFound();
  const items = ctx.store.eventVendorsForEvent(eventId).map(publicEventVendor);
  return { items, canEdit: event.lifecycle === 'active' };
}

/**
 * Добавляет выбранных личных подрядчиков в свадьбу копией их данных. Проверка принадлежности —
 * на сервере: чужой или несуществующий `vendorId` молча пропускается, а не создаёт запись.
 * Уже добавленный (по `sourceVendorId`) — тоже пропускается, повторный клик не дублирует.
 */
export function addEventVendors(ctx, eventId, body) {
  const { store, user, now } = ctx;
  const event = store.getEvent(eventId);
  requireMutable(user, event);

  const key = body?.idempotencyKey;
  if (typeof key !== 'string' || key.length < 8 || key.length > 100) {
    throw new ServiceError(400, 'bad_idempotency_key', 'Нужен idempotencyKey');
  }
  const previous = store.getIdempotent(user.id, key);
  if (previous) return { added: previous.ids.length, items: previous.ids.map((id) => publicEventVendor(store.getEventVendor(id))) };

  const requested = Array.isArray(body?.vendorIds) ? body.vendorIds : [];
  const nowIso = new Date(now).toISOString();
  const created = [];
  for (const vendorId of requested) {
    const source = store.getVendor(vendorId);
    if (!source || source.userId !== user.id) continue; // чужая или несуществующая запись — не добавляем
    if (store.findEventVendorBySource(eventId, vendorId)) continue; // уже добавлен

    const ev = {
      id: store.newId('evnd'),
      eventId,
      sourceVendorId: vendorId,
      category: source.category,
      name: source.name,
      phone: source.phone ?? null,
      link: source.link ?? null,
      note: source.note ?? null,
      status: 'candidate',
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    store.insertEventVendor(ev);
    created.push(ev);
  }

  store.setIdempotent(user.id, key, { ids: created.map((e) => e.id) });
  return { added: created.length, items: created.map(publicEventVendor) };
}

function getOwnedLink(store, user, eventId, linkId) {
  const event = store.getEvent(eventId);
  if (!canSeeEvent(user, event)) throw notFound();
  const link = store.getEventVendor(linkId);
  if (!link || link.eventId !== eventId) throw linkNotFound();
  return { event, link };
}

/** «Подтверждён» / «Вернуть в кандидаты» — единственное изменяемое поле копии. */
export function updateEventVendorStatus(ctx, eventId, linkId, status) {
  const { store, user, now } = ctx;
  const { event, link } = getOwnedLink(store, user, eventId, linkId);
  requireMutable(user, event);
  if (!['candidate', 'confirmed'].includes(status)) {
    throw new ServiceError(422, 'validation', 'Неверный статус', { status: 'candidate или confirmed' });
  }
  store.updateEventVendor(link.id, { status, updatedAt: new Date(now).toISOString() });
  return publicEventVendor(store.getEventVendor(link.id));
}

/** Убрать из свадьбы — не трогает личную запись пользователя. */
export function removeEventVendor(ctx, eventId, linkId) {
  const { store, user } = ctx;
  const { event, link } = getOwnedLink(store, user, eventId, linkId);
  requireMutable(user, event);
  store.deleteEventVendor(link.id);
  return { id: link.id };
}
