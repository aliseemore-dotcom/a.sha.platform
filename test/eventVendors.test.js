// Критерии приёмки «Подрядчики» внутри свадьбы (docs/specs/05-vendors.md, раздел 2 и «Проверка»).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVendor, updateVendor, deleteVendor, listVendors } from '../server/vendors.js';
import {
  listEventVendors, addEventVendors, updateEventVendorStatus, removeEventVendor,
} from '../server/eventVendors.js';
import { ServiceError } from '../server/errors.js';
import { setup, NOON } from './helpers.js';

test('сценарий из ТЗ: А выбирает двух своих подрядчиков в свадьбу, Б их не видит', () => {
  const { event, owner, member, stranger, store } = setup();
  const ctxA = { store, user: owner, now: NOON };
  const ctxB = { store, user: member, now: NOON };
  const e = event({ memberIds: [member.id] });

  const host1 = createVendor(ctxA, { category: 'Ведущий', name: 'Ведущий 1' });
  const host2 = createVendor(ctxA, { category: 'Ведущий', name: 'Ведущий 2' });
  createVendor(ctxA, { category: 'Декоратор', name: 'Декоратор А' });
  createVendor(ctxB, { category: 'Ведущий', name: 'Ведущий Б' });

  const res = addEventVendors(ctxA, e.id, { vendorIds: [host1.id, host2.id], idempotencyKey: 'pick-key-0001' });
  assert.equal(res.added, 2);

  const seenByA = listEventVendors(ctxA, e.id).items;
  assert.equal(seenByA.length, 2);
  assert.ok(seenByA.every((v) => v.status === 'candidate'));

  // Б видит те же две записи в свадьбе (доступ к проекту), но не остальную личную базу А.
  const seenByB = listEventVendors(ctxB, e.id).items;
  assert.equal(seenByB.length, 2);
  assert.ok(!seenByB.some((v) => v.name === 'Декоратор А'));
});

test('повторное добавление не создаёт копий', () => {
  const { event, owner, store } = setup();
  const ctx = { store, user: owner, now: NOON };
  const e = event();
  const v = createVendor(ctx, { category: 'Флорист', name: 'Цветочная студия' });
  addEventVendors(ctx, e.id, { vendorIds: [v.id], idempotencyKey: 'key-00001' });
  const second = addEventVendors(ctx, e.id, { vendorIds: [v.id], idempotencyKey: 'key-00002' });
  assert.equal(second.added, 0);
  assert.equal(listEventVendors(ctx, e.id).items.length, 1);
});

test('удаление подрядчика из свадьбы сохраняет его в личной базе; удаление из базы не убирает из свадьбы', () => {
  const { event, owner, store } = setup();
  const ctx = { store, user: owner, now: NOON };
  const e = event();
  const v = createVendor(ctx, { category: 'Фотограф', name: 'Фотограф А' });
  const { items: [added] } = addEventVendors(ctx, e.id, { vendorIds: [v.id], idempotencyKey: 'key-00001' });

  removeEventVendor(ctx, e.id, added.id);
  assert.equal(listEventVendors(ctx, e.id).items.length, 0);
  assert.equal(listVendors(ctx).items.some((x) => x.id === v.id), true);
});

test('удаление из личной базы не убирает уже добавленного подрядчика из свадьбы', () => {
  const { event, owner, store } = setup();
  const ctx = { store, user: owner, now: NOON };
  const e = event();
  const v = createVendor(ctx, { category: 'Кейтеринг', name: 'Кейтеринг А' });
  addEventVendors(ctx, e.id, { vendorIds: [v.id], idempotencyKey: 'key-00001' });
  deleteVendor(ctx, v.id);
  const items = listEventVendors(ctx, e.id).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].name, 'Кейтеринг А');
});

test('изменение личной записи позже не меняет уже сохранённую копию в свадьбе', () => {
  const { event, owner, store } = setup();
  const ctx = { store, user: owner, now: NOON };
  const e = event();
  const v = createVendor(ctx, { category: 'Кондитер', name: 'Кондитер А', phone: '111' });
  addEventVendors(ctx, e.id, { vendorIds: [v.id], idempotencyKey: 'key-00001' });
  updateVendor(ctx, v.id, { name: 'Кондитер А (переименован)', phone: '222' });
  const items = listEventVendors(ctx, e.id).items;
  assert.equal(items[0].name, 'Кондитер А');
  assert.equal(items[0].phone, '111');
});

test('подтверждение и возврат в кандидаты', () => {
  const { event, owner, store } = setup();
  const ctx = { store, user: owner, now: NOON };
  const e = event();
  const v = createVendor(ctx, { category: 'Стилист', name: 'Стилист А' });
  const { items: [added] } = addEventVendors(ctx, e.id, { vendorIds: [v.id], idempotencyKey: 'key-00001' });
  const confirmed = updateEventVendorStatus(ctx, e.id, added.id, 'confirmed');
  assert.equal(confirmed.status, 'confirmed');
  const back = updateEventVendorStatus(ctx, e.id, added.id, 'candidate');
  assert.equal(back.status, 'candidate');
});

test('чужой vendorId молча пропускается — не добавляется и не 500-ит', () => {
  const { event, owner, member, store } = setup();
  const ctxA = { store, user: owner, now: NOON };
  const ctxB = { store, user: member, now: NOON };
  const e = event({ memberIds: [member.id] });
  const bsVendor = createVendor(ctxB, { category: 'Ведущий', name: 'Чужой ведущий' });
  const res = addEventVendors(ctxA, e.id, { vendorIds: [bsVendor.id], idempotencyKey: 'key-00001' });
  assert.equal(res.added, 0);
  assert.equal(listEventVendors(ctxA, e.id).items.length, 0);
});

test('доступ к чужому проекту закрыт', () => {
  const { event, owner, stranger, store } = setup();
  const ctx = { store, user: owner, now: NOON };
  const ctxStranger = { store, user: stranger, now: NOON };
  const e = event();
  assert.throws(() => listEventVendors(ctxStranger, e.id), (err) => err instanceof ServiceError && err.status === 404);
  assert.throws(() => addEventVendors(ctxStranger, e.id, { vendorIds: [], idempotencyKey: 'key-00001' }),
    (err) => err instanceof ServiceError && err.status === 404);
});

test('архивный проект — только чтение', () => {
  const { event, owner, store } = setup();
  const ctx = { store, user: owner, now: NOON };
  const e = event({ lifecycle: 'archived' });
  const v = createVendor(ctx, { category: 'Ведущий', name: 'Ведущий А' });
  assert.throws(() => addEventVendors(ctx, e.id, { vendorIds: [v.id], idempotencyKey: 'key-00001' }),
    (err) => err instanceof ServiceError && err.status === 409);
});
