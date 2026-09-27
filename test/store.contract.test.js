// Контракт хранилища (docs/specs/08-foundation.md, §1.2–1.4): тот же набор проверок прогоняется
// на обеих реализациях, чтобы SQLite и память в тестах вели себя одинаково.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../server/store/memory.js';
import { createSqliteStore } from '../server/store/sqlite.js';

const IMPLS = {
  memory: () => createMemoryStore(),
  sqlite: () => createSqliteStore(':memory:'),
};

for (const [name, make] of Object.entries(IMPLS)) {
  test(`[${name}] вставка и чтение свадьбы`, () => {
    const store = make();
    store.insertWorkspace({ id: 'ws1', name: 'W', timeZone: 'UTC', createdAt: 'a', updatedAt: 'a' });
    store.insertEvent({
      id: 'e1', workspaceId: 'ws1', title: 'Свадьба', memberIds: ['u1'],
      createdAt: '2026-01-01', updatedAt: '2026-01-01',
    });
    const e = store.getEvent('e1');
    assert.equal(e.title, 'Свадьба');
    assert.deepEqual(e.memberIds, ['u1']);
  });

  test(`[${name}] обновление свадьбы`, () => {
    const store = make();
    store.insertEvent({ id: 'e1', workspaceId: 'ws1', title: 'A', createdAt: 'a', updatedAt: 'a' });
    const updated = store.updateEvent('e1', { title: 'B', updatedAt: 'b' });
    assert.equal(updated.title, 'B');
    assert.equal(store.getEvent('e1').title, 'B');
  });

  test(`[${name}] уникальность templateKey в пределах свадьбы`, () => {
    const store = make();
    store.insertTask({ id: 't1', eventId: 'e1', templateKey: 'checklist:x', title: 'A', createdAt: 'a', updatedAt: 'a' });
    assert.throws(() => store.insertTask({ id: 't2', eventId: 'e1', templateKey: 'checklist:x', title: 'B', createdAt: 'a', updatedAt: 'a' }));
    // другая свадьба — тот же templateKey разрешён
    store.insertTask({ id: 't3', eventId: 'e2', templateKey: 'checklist:x', title: 'C', createdAt: 'a', updatedAt: 'a' });
    assert.ok(store.getTask('t3'));
  });

  test(`[${name}] идемпотентность`, () => {
    const store = make();
    assert.equal(store.getIdempotent('u1', 'k1'), null);
    store.setIdempotent('u1', 'k1', { ok: true });
    assert.deepEqual(store.getIdempotent('u1', 'k1'), { ok: true });
  });

  test(`[${name}] удаление подрядчика свадьбы и строки сметы`, () => {
    const store = make();
    store.insertEventVendor({ id: 'ev1', eventId: 'e1', sourceVendorId: 'v1', name: 'Фотограф', createdAt: 'a', updatedAt: 'a' });
    store.insertBudgetLine({ id: 'bl1', eventId: 'e1', sourceEventVendorId: 'ev1', amount: 100, createdAt: 'a', updatedAt: 'a' });
    store.deleteEventVendor('ev1');
    store.deleteBudgetLine('bl1');
    assert.equal(store.getEventVendor('ev1'), null);
    assert.equal(store.getBudgetLine('bl1'), null);
    assert.deepEqual(store.eventVendorsForEvent('e1'), []);
    assert.deepEqual(store.budgetLinesForEvent('e1'), []);
  });

  test(`[${name}] возвращённый объект — копия, правка снаружи не меняет сохранённые данные`, () => {
    const store = make();
    store.insertEvent({ id: 'e1', workspaceId: 'ws1', title: 'A', tags: ['x'], createdAt: 'a', updatedAt: 'a' });
    const e = store.getEvent('e1');
    e.title = 'ИЗМЕНЕНО СНАРУЖИ';
    e.tags.push('y');
    const again = store.getEvent('e1');
    assert.equal(again.title, 'A');
    assert.deepEqual(again.tags, ['x']);
  });

  test(`[${name}] transaction: откат при исключении`, () => {
    const store = make();
    store.insertEvent({ id: 'e1', workspaceId: 'ws1', title: 'A', createdAt: 'a', updatedAt: 'a' });
    assert.throws(() => {
      store.transaction(() => {
        store.insertEventVendor({ id: 'ev1', eventId: 'e1', sourceVendorId: 'v1', name: 'X', createdAt: 'a', updatedAt: 'a' });
        store.insertBudgetLine({ id: 'bl1', eventId: 'e1', sourceEventVendorId: 'ev1', amount: 1, createdAt: 'a', updatedAt: 'a' });
        throw new Error('boom');
      });
    }, /boom/);
    assert.equal(store.getEventVendor('ev1'), null);
    assert.equal(store.getBudgetLine('bl1'), null);
    assert.deepEqual(store.eventVendorsForEvent('e1'), []);
  });

  test(`[${name}] transaction: успешная фиксирует все записи`, () => {
    const store = make();
    store.transaction(() => {
      store.insertEvent({ id: 'e1', workspaceId: 'ws1', title: 'A', createdAt: 'a', updatedAt: 'a' });
      store.insertEventVendor({ id: 'ev1', eventId: 'e1', sourceVendorId: 'v1', name: 'X', createdAt: 'a', updatedAt: 'a' });
    });
    assert.ok(store.getEvent('e1'));
    assert.ok(store.getEventVendor('ev1'));
  });

  test(`[${name}] пользователь по email, без учёта регистра`, () => {
    const store = make();
    store.insertUser({
      id: 'u1', workspaceId: 'ws1', email: 'Anna@Example.com', name: 'Анна', role: 'owner',
      permissions: [], passwordHash: null, status: 'active', createdAt: 'a', updatedAt: 'a',
    });
    const found = store.findUserByEmail('anna@example.com');
    assert.ok(found);
    assert.equal(found.id, 'u1');
  });

  test(`[${name}] сессии: вставка, чтение, продление, отзыв`, () => {
    const store = make();
    store.insertSession({
      idHash: 'h1', userId: 'u1', createdAt: 'a', lastSeenAt: 'a', expiresAt: 'b', userAgent: 'test',
    });
    assert.ok(store.getSessionByIdHash('h1'));
    store.touchSession('h1', { lastSeenAt: 'c', expiresAt: 'd' });
    assert.equal(store.getSessionByIdHash('h1').expiresAt, 'd');
    store.insertSession({ idHash: 'h2', userId: 'u1', createdAt: 'a', lastSeenAt: 'a', expiresAt: 'b' });
    store.deleteSessionsForUser('u1', 'h1');
    assert.ok(store.getSessionByIdHash('h1'));
    assert.equal(store.getSessionByIdHash('h2'), null);
    store.deleteSession('h1');
    assert.equal(store.getSessionByIdHash('h1'), null);
  });

  test(`[${name}] приглашения: одноразовость и замена активного`, () => {
    const store = make();
    store.insertInvite({
      tokenHash: 't1', workspaceId: 'ws1', email: 'a@b.com', name: 'A', role: 'member',
      permissions: [], kind: 'invite', expiresAt: 'z', usedAt: null, createdBy: 'u1', createdAt: 'a',
    });
    assert.ok(store.findActiveInviteByEmail('ws1', 'a@b.com'));
    store.markInviteUsed('t1', 'now');
    assert.equal(store.getInviteByTokenHash('t1').usedAt, 'now');
    assert.equal(store.findActiveInviteByEmail('ws1', 'a@b.com'), null);
  });

  test(`[${name}] попытки входа: подсчёт по ключу и по IP`, () => {
    const store = make();
    for (let i = 0; i < 3; i++) store.insertLoginAttempt({ key: 'a@b.com|1.2.3.4', ip: '1.2.3.4', at: 1000 + i });
    assert.equal(store.countLoginAttempts('a@b.com|1.2.3.4', 0), 3);
    assert.equal(store.countLoginAttemptsByIp('1.2.3.4', 0), 3);
    store.pruneLoginAttempts(1002);
    assert.equal(store.countLoginAttempts('a@b.com|1.2.3.4', 0), 1);
  });

  test(`[${name}] участники свадьбы через отдельную таблицу`, () => {
    const store = make();
    store.insertEvent({ id: 'e1', workspaceId: 'ws1', title: 'A', createdAt: 'a', updatedAt: 'a' });
    store.setEventMembers('e1', ['u1', 'u2']);
    assert.deepEqual(store.getEvent('e1').memberIds, ['u1', 'u2']);
    store.setEventMembers('e1', ['u2']);
    assert.deepEqual(store.getEvent('e1').memberIds, ['u2']);
  });
}
