// Личная база подрядчиков пользователя («Мои подрядчики», docs/specs/05-vendors.md).
// Не общая база сервиса и не общая база агентства: каждый пользователь видит и меняет только
// свои записи. Все функции получают ctx = { store, user, now }.

import { ServiceError } from './errors.js';

export const CATEGORIES = [
  'Ведущий', 'Декоратор', 'Фотограф', 'Видеограф', 'Флорист',
  'Стилист', 'Визажист', 'Кейтеринг', 'Музыка/DJ', 'Кондитер', 'Другое',
];

export const NAME_MAX = 150;
export const PHONE_MAX = 40;
export const LINK_MAX = 300;
export const NOTE_MAX = 1000;

const notFound = () => new ServiceError(404, 'not_found', 'Подрядчик не найден или недоступен');

function trimmedOrNull(v, max) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t) return null;
  return [...t].length > max ? undefined : t;
}

function validateFields(body, { partial }) {
  const fields = {};
  const patch = {};

  if (!partial || 'category' in body) {
    if (!CATEGORIES.includes(body.category)) fields.category = 'Выберите категорию';
    else patch.category = body.category;
  }
  if (!partial || 'name' in body) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) fields.name = 'Укажите имя или название';
    else if ([...name].length > NAME_MAX) fields.name = `Не более ${NAME_MAX} символов`;
    else patch.name = name;
  }
  if ('phone' in body) {
    const v = trimmedOrNull(body.phone, PHONE_MAX);
    if (v === undefined) fields.phone = `Не более ${PHONE_MAX} символов`;
    else patch.phone = v;
  }
  if ('link' in body) {
    const v = trimmedOrNull(body.link, LINK_MAX);
    if (v === undefined) fields.link = `Не более ${LINK_MAX} символов`;
    else patch.link = v;
  }
  if ('note' in body) {
    const v = trimmedOrNull(body.note, NOTE_MAX);
    if (v === undefined) fields.note = `Не более ${NOTE_MAX} символов`;
    else patch.note = v;
  }

  if (Object.keys(fields).length) throw new ServiceError(422, 'validation', 'Проверьте поля формы', fields);
  return patch;
}

export function publicVendor(v) {
  return {
    id: v.id, category: v.category, name: v.name,
    phone: v.phone ?? null, link: v.link ?? null, note: v.note ?? null,
    createdAt: v.createdAt, updatedAt: v.updatedAt,
  };
}

function normalize(s) {
  return String(s ?? '').trim().toLocaleLowerCase('ru').replaceAll('ё', 'е');
}

/** Поиск по имени и категории — только среди записей текущего пользователя. */
export function listVendors(ctx, query = {}) {
  const all = ctx.store.listVendorsByUser(ctx.user.id);
  const q = normalize(query.q);
  const list = all.filter((v) => {
    if (query.category && v.category !== query.category) return false;
    if (q && !normalize(`${v.name}\n${v.category}`).includes(q)) return false;
    return true;
  });
  list.sort((a, b) => a.category.localeCompare(b.category, 'ru') || a.name.localeCompare(b.name, 'ru'));
  return { items: list.map(publicVendor), total: all.length, categories: CATEGORIES };
}

export function createVendor(ctx, body) {
  const patch = validateFields(body, { partial: false });
  const nowIso = new Date(ctx.now).toISOString();
  const vendor = {
    id: ctx.store.newId('vnd'),
    userId: ctx.user.id,
    phone: null, link: null, note: null,
    ...patch,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  ctx.store.insertVendor(vendor);
  return publicVendor(vendor);
}

function getOwnVendor(ctx, vendorId) {
  const v = ctx.store.getVendor(vendorId);
  if (!v || v.userId !== ctx.user.id) throw notFound();
  return v;
}

export function updateVendor(ctx, vendorId, body) {
  const v = getOwnVendor(ctx, vendorId);
  const patch = validateFields(body, { partial: true });
  patch.updatedAt = new Date(ctx.now).toISOString();
  ctx.store.updateVendor(v.id, patch);
  return publicVendor(ctx.store.getVendor(v.id));
}

export function deleteVendor(ctx, vendorId) {
  const v = getOwnVendor(ctx, vendorId);
  ctx.store.deleteVendor(v.id);
  return { id: v.id };
}
