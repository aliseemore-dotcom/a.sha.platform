// Критерии приёмки «Мои подрядчики» (личная база, docs/specs/05-vendors.md).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listVendors, createVendor, updateVendor, deleteVendor } from '../server/vendors.js';
import { ServiceError } from '../server/errors.js';
import { setup, NOON } from './helpers.js';

test('каждый пользователь видит только свои записи', () => {
  const { owner, member, store } = setup();
  const ctxOwner = { store, user: owner, now: NOON };
  const ctxMember = { store, user: member, now: NOON };
  createVendor(ctxOwner, { category: 'Ведущий', name: 'Ведущий А' });
  createVendor(ctxOwner, { category: 'Ведущий', name: 'Ведущий Б' });
  createVendor(ctxOwner, { category: 'Декоратор', name: 'Декоратор А' });
  createVendor(ctxMember, { category: 'Ведущий', name: 'Ведущий участника' });

  const ownerList = listVendors(ctxOwner);
  const memberList = listVendors(ctxMember);
  assert.equal(ownerList.total, 3);
  assert.equal(memberList.total, 1);
  assert.ok(ownerList.items.every((v) => v.name !== 'Ведущий участника'));
});

test('обязательны категория и имя; телефон/ссылка/заметка необязательны', () => {
  const { owner, store } = setup();
  const ctx = { store, user: owner, now: NOON };
  assert.throws(() => createVendor(ctx, { category: 'Ведущий', name: '' }),
    (err) => err instanceof ServiceError && err.status === 422 && Boolean(err.fields.name));
  assert.throws(() => createVendor(ctx, { category: 'Неизвестная', name: 'Кто-то' }),
    (err) => err instanceof ServiceError && err.status === 422 && Boolean(err.fields.category));
  const v = createVendor(ctx, { category: 'Флорист', name: 'Цветочная студия' });
  assert.equal(v.phone, null);
  assert.equal(v.link, null);
  assert.equal(v.note, null);
});

test('поиск по имени и категории', () => {
  const { owner, store } = setup();
  const ctx = { store, user: owner, now: NOON };
  createVendor(ctx, { category: 'Фотограф', name: 'Иван Петров' });
  createVendor(ctx, { category: 'Видеограф', name: 'Иван Сидоров' });
  createVendor(ctx, { category: 'Флорист', name: 'Анна' });
  assert.equal(listVendors(ctx, { q: 'иван' }).items.length, 2);
  assert.equal(listVendors(ctx, { category: 'Флорист' }).items.length, 1);
  assert.equal(listVendors(ctx, { q: 'иван', category: 'Видеограф' }).items.length, 1);
});

test('изменить и удалить можно только свою запись', () => {
  const { owner, member, store } = setup();
  const ctxOwner = { store, user: owner, now: NOON };
  const ctxMember = { store, user: member, now: NOON };
  const v = createVendor(ctxOwner, { category: 'Ведущий', name: 'Ведущий А' });

  assert.throws(() => updateVendor(ctxMember, v.id, { name: 'Взлом' }),
    (err) => err instanceof ServiceError && err.status === 404);
  assert.throws(() => deleteVendor(ctxMember, v.id),
    (err) => err instanceof ServiceError && err.status === 404);

  const updated = updateVendor(ctxOwner, v.id, { name: 'Ведущий А (обновлено)', phone: '+7 900 000-00-00' });
  assert.equal(updated.name, 'Ведущий А (обновлено)');
  assert.equal(updated.phone, '+7 900 000-00-00');

  deleteVendor(ctxOwner, v.id);
  assert.equal(listVendors(ctxOwner).total, 0);
});

test('пустая база — total 0, без выдуманных контактов', () => {
  const { owner, store } = setup();
  const ctx = { store, user: owner, now: NOON };
  const res = listVendors(ctx);
  assert.equal(res.total, 0);
  assert.deepEqual(res.items, []);
});
