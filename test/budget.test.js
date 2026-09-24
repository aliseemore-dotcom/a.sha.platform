// Критерии приёмки «Смета свадьбы» (docs/specs/06-budget.md).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVendor, updateVendor } from '../server/vendors.js';
import { addEventVendors, updateEventVendorStatus, removeEventVendor } from '../server/eventVendors.js';
import {
  getBudget, setCurrency, addManualLine, updateBudgetLine, removeBudgetLine,
} from '../server/budget.js';
import { ServiceError } from '../server/errors.js';
import { setup, NOON } from './helpers.js';

function ctxOf(store, user) {
  return { store, user, now: NOON };
}

test('сценарий из ТЗ: ведущий с ценой и декоратор без цены — оба в смете, итог учитывает только известную цену', () => {
  const { event, owner, store } = setup();
  const ctx = ctxOf(store, owner);
  const e = event();
  const host = createVendor(ctx, { category: 'Ведущий', name: 'Ведущий А', price: 50000, currency: 'RUB' });
  const decorator = createVendor(ctx, { category: 'Декоратор', name: 'Декоратор А' });
  addEventVendors(ctx, e.id, { vendorIds: [host.id, decorator.id], idempotencyKey: 'add-key-0001' });

  const budget = getBudget(ctx, e.id);
  assert.equal(budget.lines.length, 2);
  const hostLine = budget.lines.find((l) => l.title === 'Ведущий А');
  const decoLine = budget.lines.find((l) => l.title === 'Декоратор А');
  assert.equal(hostLine.amount, 50000);
  assert.equal(decoLine.amount, null);

  // Кандидаты по умолчанию не входят в итог — организатор их ещё не подтвердил и не включил.
  assert.equal(budget.total, 0);
  assert.equal(budget.missingCount, 0);
});

test('подтверждение подрядчика включает его строку в итог автоматически', () => {
  const { event, owner, store } = setup();
  const ctx = ctxOf(store, owner);
  const e = event();
  const host = createVendor(ctx, { category: 'Ведущий', name: 'Ведущий А', price: 50000, currency: 'RUB' });
  const { items: [link] } = addEventVendors(ctx, e.id, { vendorIds: [host.id], idempotencyKey: 'add-key-0001' });
  updateEventVendorStatus(ctx, e.id, link.id, 'confirmed');

  const budget = getBudget(ctx, e.id);
  assert.equal(budget.total, 50000);
});

test('изменение цены в смете не меняет цену в личной базе; изменение в базе не меняет уже созданную строку', () => {
  const { event, owner, store } = setup();
  const ctx = ctxOf(store, owner);
  const e = event();
  const host = createVendor(ctx, { category: 'Ведущий', name: 'Ведущий А', price: 50000, currency: 'RUB' });
  const { items: [link] } = addEventVendors(ctx, e.id, { vendorIds: [host.id], idempotencyKey: 'add-key-0001' });
  const line = getBudget(ctx, e.id).lines[0];

  const updatedLine = updateBudgetLine(ctx, e.id, line.id, { amount: 60000 });
  assert.equal(updatedLine.amount, 60000);
  assert.equal(updatedLine.manuallyEdited, true);

  const personalVendorAfter = updateVendor(ctx, host.id, {}); // touch to fetch current state via update no-op patch
  assert.equal(personalVendorAfter.price, 50000); // цена в личной базе не изменилась

  updateVendor(ctx, host.id, { price: 70000 });
  const lineAfterBaseEdit = getBudget(ctx, e.id).lines[0];
  assert.equal(lineAfterBaseEdit.amount, 60000); // уже созданная строка не перезаписывается
});

test('ручной расход добавляется, второй кандидат той же роли не складывается автоматически', () => {
  const { event, owner, store } = setup();
  const ctx = ctxOf(store, owner);
  const e = event();
  const host1 = createVendor(ctx, { category: 'Ведущий', name: 'Ведущий 1', price: 50000, currency: 'RUB' });
  const host2 = createVendor(ctx, { category: 'Ведущий', name: 'Ведущий 2', price: 45000, currency: 'RUB' });
  const { items: [link1] } = addEventVendors(ctx, e.id, { vendorIds: [host1.id], idempotencyKey: 'add-key-0001' });
  addEventVendors(ctx, e.id, { vendorIds: [host2.id], idempotencyKey: 'add-key-0002' });
  updateEventVendorStatus(ctx, e.id, link1.id, 'confirmed');

  addManualLine(ctx, e.id, { category: 'Транспорт', title: 'Трансфер гостей', amount: 15000 });

  const budget = getBudget(ctx, e.id);
  assert.equal(budget.total, 65000); // 50000 (подтверждён) + 15000 (ручной), НЕ 45000 второго ведущего
});

test('несовпадение валюты: сумма не конвертируется молча, остаётся неизвестной до ручного ввода', () => {
  const { event, owner, store } = setup();
  const ctx = ctxOf(store, owner);
  const e = event();
  const host = createVendor(ctx, { category: 'Ведущий', name: 'Ведущий USD', price: 500, currency: 'USD' });
  addEventVendors(ctx, e.id, { vendorIds: [host.id], idempotencyKey: 'add-key-0001' });

  const budget = getBudget(ctx, e.id); // валюта проекта по умолчанию RUB
  const line = budget.lines[0];
  assert.equal(line.amount, null);
  assert.equal(line.originalPrice, 500);
  assert.equal(line.originalCurrency, 'USD');
  assert.equal(line.needsCurrencyMatch, true);

  const updated = updateBudgetLine(ctx, e.id, line.id, { amount: 47000 });
  assert.equal(updated.amount, 47000);
  assert.equal(updated.originalCurrency, 'USD'); // исходное значение сохранено для справки
});

test('удаление подрядчика: «удалить строку» убирает её, «оставить как расход» сохраняет отдельно', () => {
  const { event, owner, store } = setup();
  const ctx = ctxOf(store, owner);
  const e = event();
  const host1 = createVendor(ctx, { category: 'Ведущий', name: 'Ведущий 1', price: 50000, currency: 'RUB' });
  const host2 = createVendor(ctx, { category: 'Ведущий', name: 'Ведущий 2', price: 45000, currency: 'RUB' });
  const { items: [link1] } = addEventVendors(ctx, e.id, { vendorIds: [host1.id], idempotencyKey: 'add-key-0001' });
  const { items: [link2] } = addEventVendors(ctx, e.id, { vendorIds: [host2.id], idempotencyKey: 'add-key-0002' });

  removeEventVendor(ctx, e.id, link1.id, 'delete');
  let budget = getBudget(ctx, e.id);
  assert.equal(budget.lines.length, 1);

  removeEventVendor(ctx, e.id, link2.id, 'keep');
  budget = getBudget(ctx, e.id);
  assert.equal(budget.lines.length, 1);
  assert.equal(budget.lines[0].source, 'manual');
  assert.equal(budget.lines[0].vendorLinkId, null);
  assert.equal(budget.lines[0].amount, 45000);
});

test('повторное добавление того же подрядчика не создаёт вторую строку сметы', () => {
  const { event, owner, store } = setup();
  const ctx = ctxOf(store, owner);
  const e = event();
  const host = createVendor(ctx, { category: 'Ведущий', name: 'Ведущий А', price: 50000, currency: 'RUB' });
  addEventVendors(ctx, e.id, { vendorIds: [host.id], idempotencyKey: 'add-key-0001' });
  addEventVendors(ctx, e.id, { vendorIds: [host.id], idempotencyKey: 'add-key-0002' });
  assert.equal(getBudget(ctx, e.id).lines.length, 1);
});

test('ручной расход: категория и название обязательны', () => {
  const { event, owner, store } = setup();
  const ctx = ctxOf(store, owner);
  const e = event();
  assert.throws(() => addManualLine(ctx, e.id, { category: '', title: 'Что-то' }),
    (err) => err instanceof ServiceError && err.status === 422 && Boolean(err.fields.category));
  assert.throws(() => addManualLine(ctx, e.id, { category: 'Площадка', title: '' }),
    (err) => err instanceof ServiceError && err.status === 422 && Boolean(err.fields.title));
});

test('исключение строки из итога', () => {
  const { event, owner, store } = setup();
  const ctx = ctxOf(store, owner);
  const e = event();
  const line = addManualLine(ctx, e.id, { category: 'Площадка', title: 'Аренда зала', amount: 100000 });
  assert.equal(getBudget(ctx, e.id).total, 100000);
  updateBudgetLine(ctx, e.id, line.id, { included: false });
  assert.equal(getBudget(ctx, e.id).total, 0);
});

test('missingCount считает только включённые строки без цены', () => {
  const { event, owner, store } = setup();
  const ctx = ctxOf(store, owner);
  const e = event();
  const decorator = createVendor(ctx, { category: 'Декоратор', name: 'Декоратор А' });
  const { items: [link] } = addEventVendors(ctx, e.id, { vendorIds: [decorator.id], idempotencyKey: 'add-key-0001' });
  assert.equal(getBudget(ctx, e.id).missingCount, 0); // кандидат не включён — не считается неполным
  updateEventVendorStatus(ctx, e.id, link.id, 'confirmed');
  assert.equal(getBudget(ctx, e.id).missingCount, 1); // теперь включён и без цены
});

test('удаление ручной строки', () => {
  const { event, owner, store } = setup();
  const ctx = ctxOf(store, owner);
  const e = event();
  const line = addManualLine(ctx, e.id, { category: 'Площадка', title: 'Аренда зала', amount: 100000 });
  removeBudgetLine(ctx, e.id, line.id);
  assert.equal(getBudget(ctx, e.id).lines.length, 0);
});

test('валюта проекта: неверное значение отклоняется, корректное сохраняется', () => {
  const { event, owner, store } = setup();
  const ctx = ctxOf(store, owner);
  const e = event();
  assert.throws(() => setCurrency(ctx, e.id, 'XXX'), (err) => err instanceof ServiceError && err.status === 422);
  const res = setCurrency(ctx, e.id, 'USD');
  assert.equal(res.currency, 'USD');
});

test('доступ к чужому проекту закрыт', () => {
  const { event, owner, stranger, store } = setup();
  const ctx = ctxOf(store, owner);
  const ctxStranger = ctxOf(store, stranger);
  const e = event();
  assert.throws(() => getBudget(ctxStranger, e.id), (err) => err instanceof ServiceError && err.status === 404);
});

test('архивный проект — только чтение', () => {
  const { event, owner, store } = setup();
  const ctx = ctxOf(store, owner);
  const e = event({ lifecycle: 'archived' });
  assert.throws(() => addManualLine(ctx, e.id, { category: 'Площадка', title: 'Аренда' }),
    (err) => err instanceof ServiceError && err.status === 409);
});
