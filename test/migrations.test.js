// Миграции (docs/specs/08-foundation.md, §1.6): применяются один раз, повторный старт не падает
// и не переприменяет их.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../server/db/migrate.js';
import { createSqliteStore } from '../server/store/sqlite.js';

test('миграции применяются на пустой базе и создают все таблицы', () => {
  const db = new DatabaseSync(':memory:');
  runMigrations(db);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  for (const t of [
    'workspaces', 'users', 'events', 'event_members', 'tasks', 'vendors', 'event_vendors',
    'budgets', 'budget_lines', 'idempotency', 'sessions', 'invites', 'login_attempts', 'schema_migrations',
  ]) assert.ok(tables.includes(t), `нет таблицы ${t}`);
});

test('повторный запуск миграций не падает и не дублирует запись в schema_migrations', () => {
  const db = new DatabaseSync(':memory:');
  runMigrations(db);
  runMigrations(db);
  const rows = db.prepare('SELECT name FROM schema_migrations').all();
  const names = rows.map((r) => r.name);
  assert.equal(new Set(names).size, names.length);
});

test('повторный старт сервера (новый store на тот же файл на диске) видит прежние данные', () => {
  const dir = mkdtempSync(join(tmpdir(), 'asha-db-'));
  const dbPath = join(dir, 'app.db');
  try {
    const store1 = createSqliteStore(dbPath);
    store1.insertWorkspace({ id: 'w1', name: 'Агентство', timeZone: 'Europe/Moscow', createdAt: 'a', updatedAt: 'a' });
    store1.close();

    const store2 = createSqliteStore(dbPath);
    const ws = store2.getWorkspace('w1');
    assert.equal(ws.name, 'Агентство');
    store2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
