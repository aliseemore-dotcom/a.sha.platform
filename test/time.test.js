// server/time.js — операции в поясе рабочего пространства, без внешних библиотек.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localDateTimeToMs, localDate } from '../server/time.js';

test('localDateTimeToMs: время в поясе без перехода на летнее (Europe/Moscow, UTC+3)', () => {
  const ms = localDateTimeToMs('2026-10-05', '09:52', 'Europe/Moscow');
  assert.equal(ms, Date.UTC(2026, 9, 5, 6, 52));
});

test('localDateTimeToMs: пояс с переходом на летнее время (America/New_York)', () => {
  // Январь — зима, UTC−5.
  const winter = localDateTimeToMs('2026-01-15', '09:00', 'America/New_York');
  assert.equal(winter, Date.UTC(2026, 0, 15, 14, 0));
  // Июль — лето, UTC−4.
  const summer = localDateTimeToMs('2026-07-15', '09:00', 'America/New_York');
  assert.equal(summer, Date.UTC(2026, 6, 15, 13, 0));
});

test('localDateTimeToMs и localDate — обратные друг другу для даты (без учёта времени)', () => {
  const ms = localDateTimeToMs('2026-10-05', '23:30', 'Asia/Dubai');
  assert.equal(localDate(ms, 'Asia/Dubai'), '2026-10-05');
});
