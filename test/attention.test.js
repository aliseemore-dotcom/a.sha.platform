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

test('заблокированная и просроченная задача — одна строка «blocked»; блокировка не выводится из просрочки', () => {
  const t = { ...base, isBlocked: true, dueDate: '2026-09-20' };
  assert.equal(classifyTask(t, NOON, TZ), 'blocked');
  assert.equal(classifyTask({ ...base, isBlocked: true }, NOON, TZ), 'blocked');
  assert.equal(classifyTask({ ...base, dueDate: '2026-09-20' }, NOON, TZ), 'overdue');
});

test('isBlocked — отдельный признак: задача может быть in_progress и заблокирована одновременно', () => {
  assert.equal(classifyTask({ ...base, status: 'in_progress', isBlocked: true }, NOON, TZ), 'blocked');
  assert.equal(classifyTask({ ...base, status: 'waiting', isBlocked: true }, NOON, TZ), 'blocked');
});

test('завтрашний срок и сегодняшний будущий срок не просрочены', () => {
  assert.equal(classifyTask({ ...base, dueDate: '2026-09-24' }, NOON, TZ), null);
  assert.equal(classifyTask({ ...base, dueAt: '2026-09-24T06:00:00Z' }, NOON, TZ), null);
  // 19:20 МСК: в 17:00 — «сегодня», после 19:20 — просрочено
  const t = { ...base, dueAt: '2026-09-23T16:20:00Z' };
  assert.equal(classifyTask(t, at('2026-09-23T14:00:00Z'), TZ), 'due_today');
  assert.equal(classifyTask(t, at('2026-09-23T16:20:01Z'), TZ), 'overdue');
});

test('waiting без наступившего срока — не сигнал внимания; «Нужно напомнить» сознательно не считается без подтверждённого источника (итерация 3)', () => {
  const t = { ...base, status: 'waiting', followUpAt: '2026-09-01' };
  assert.equal(classifyTask(t, NOON, TZ), null);
  // Просрочка по dueAt/dueDate у waiting-задачи по-прежнему работает — followUpAt тут ни при чём.
  assert.equal(classifyTask({ ...t, dueDate: '2026-09-01' }, NOON, TZ), 'overdue');
});

test('done и cancelled не попадают во внимание, даже заблокированные; todo без срока — тоже', () => {
  assert.equal(classifyTask({ ...base, status: 'done', dueDate: '2026-09-01' }, NOON, TZ), null);
  assert.equal(classifyTask({ ...base, status: 'cancelled', dueDate: '2026-09-01' }, NOON, TZ), null);
  assert.equal(classifyTask({ ...base, status: 'done', isBlocked: true }, NOON, TZ), null);
  assert.equal(classifyTask({ ...base, status: 'todo' }, NOON, TZ), null);
});

test('сортировка внимания: заблокированные и просроченные вместе выше «Сегодня», старший срок выше, затем проект и id', () => {
  const items = [
    { id: 't1', eventId: 'e2', kind: 'due_today', sortDue: 50 },
    { id: 't2', eventId: 'e1', kind: 'blocked', sortDue: null },
    { id: 't3', eventId: 'e1', kind: 'overdue', sortDue: 200 },
    { id: 't4', eventId: 'e2', kind: 'blocked', sortDue: 100 },
    { id: 't0', eventId: 'e2', kind: 'blocked', sortDue: null },
  ].sort(compareAttention);
  assert.deepEqual(items.map((i) => i.id), ['t4', 't3', 't2', 't0', 't1']);
});

test('nextChangeAt: ближайший dueAt или полночь пространства', () => {
  assert.equal(nextChangeAt([], NOON, TZ), at('2026-09-23T21:00:00Z'));
  assert.equal(nextChangeAt([{ ...base, dueAt: '2026-09-23T15:00:00Z' }], NOON, TZ), at('2026-09-23T15:00:00Z'));
});
