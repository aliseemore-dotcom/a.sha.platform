import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTask, compareAttention, nextChangeAt } from '../server/attention.js';
import { TZ, NOON } from './helpers.js';

const base = { id: 't', eventId: 'e', title: 'x', status: 'in_progress', dueAt: null, dueDate: null, followUpAt: null };
const at = (iso) => Date.parse(iso);

test('срок со временем: сегодня до наступления, просрочено ровно в момент срока', () => {
  const t = { ...base, dueAt: '2026-09-23T15:00:00Z' }; // 18:00 МСК
  assert.equal(classifyTask(t, NOON, TZ), 'due_today');
  assert.equal(classifyTask(t, at('2026-09-23T14:59:59Z'), TZ), 'due_today');
  assert.equal(classifyTask(t, at('2026-09-23T15:00:00Z'), TZ), 'overdue');
});

test('срок-дата без времени остаётся «Сегодня» весь день и просрочен со следующего дня в поясе пространства', () => {
  const t = { ...base, dueDate: '2026-09-23' };
  assert.equal(classifyTask(t, at('2026-09-22T21:00:00Z'), TZ), 'due_today'); // 00:00 МСК 23-го
  assert.equal(classifyTask(t, at('2026-09-23T20:59:59Z'), TZ), 'due_today'); // 23:59:59 МСК
  assert.equal(classifyTask(t, at('2026-09-23T21:00:00Z'), TZ), 'overdue');   // 00:00 МСК 24-го
  // Тот же момент в другом поясе — ещё сегодня
  assert.equal(classifyTask(t, at('2026-09-23T21:00:00Z'), 'Europe/Amsterdam'), 'due_today');
});

test('blocked, но срок прошёл → overdue (показывается один раз по высшему приоритету)', () => {
  const t = { ...base, status: 'blocked', dueDate: '2026-09-20' };
  assert.equal(classifyTask(t, NOON, TZ), 'overdue');
  assert.equal(classifyTask({ ...base, status: 'blocked' }, NOON, TZ), 'blocked');
});

test('waiting: не срочно до followUpAt, «Нужно напомнить» в день повторного контакта и позже', () => {
  const t = { ...base, status: 'waiting', followUpAt: '2026-09-24' };
  assert.equal(classifyTask(t, NOON, TZ), null);
  assert.equal(classifyTask({ ...t, followUpAt: '2026-09-23' }, NOON, TZ), 'follow_up_due');
  assert.equal(classifyTask({ ...t, followUpAt: '2026-09-01' }, NOON, TZ), 'follow_up_due');
});

test('done и cancelled не попадают во внимание; planned без срока — тоже', () => {
  assert.equal(classifyTask({ ...base, status: 'done', dueDate: '2026-09-01' }, NOON, TZ), null);
  assert.equal(classifyTask({ ...base, status: 'cancelled', dueDate: '2026-09-01' }, NOON, TZ), null);
  assert.equal(classifyTask({ ...base, status: 'planned' }, NOON, TZ), null);
});

test('сортировка внимания: приоритет → более старый срок → дата свадьбы → id', () => {
  const items = [
    { id: 'c', kind: 'blocked', sortDue: null, eventDate: '2027-01-01' },
    { id: 'b', kind: 'overdue', sortDue: 200, eventDate: null },
    { id: 'a', kind: 'overdue', sortDue: 100, eventDate: null },
    { id: 'e', kind: 'blocked', sortDue: null, eventDate: null },
    { id: 'd', kind: 'blocked', sortDue: null, eventDate: '2026-12-01' },
  ].sort(compareAttention);
  assert.deepEqual(items.map((i) => i.id), ['a', 'b', 'd', 'c', 'e']);
});

test('nextChangeAt: ближайший dueAt или полночь пространства', () => {
  assert.equal(nextChangeAt([], NOON, TZ), at('2026-09-23T21:00:00Z'));
  assert.equal(nextChangeAt([{ ...base, dueAt: '2026-09-23T15:00:00Z' }], NOON, TZ), at('2026-09-23T15:00:00Z'));
});
