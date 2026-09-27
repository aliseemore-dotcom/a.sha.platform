#!/usr/bin/env node
// Административная консоль (docs/specs/08-foundation.md, §2.5, §5): создание пространств,
// ссылки приглашения/сброса, отключение пользователей, резервные копии. Работает с той же базой
// (`DATABASE_PATH`), без запущенного сервера — на Render запускается через Shell сервиса.

import { createSqliteStore } from '../server/store/sqlite.js';
import { isValidTimeZone } from '../server/time.js';
import { createInvite, INVITE_DAYS, RESET_HOURS } from '../server/auth/invites.js';
import { runBackup, restoreFrom } from '../server/backup.js';

const DATABASE_PATH = process.env.DATABASE_PATH ?? './data/app.db';
const DATABASE_BACKUP_DIR = process.env.DATABASE_BACKUP_DIR ?? './data/backups';
const PUBLIC_URL = process.env.PUBLIC_URL ?? 'http://localhost:3000';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; } else out[key] = true;
    }
  }
  return out;
}

function fail(message) {
  console.error(`Ошибка: ${message}`);
  process.exit(1);
}

function inviteLink(token) {
  return `${PUBLIC_URL}/invite/${token}`;
}

async function main() {
  const [, , command, ...rest] = process.argv;
  const args = parseArgs(rest);

  if (command === 'create-workspace') {
    const { name, 'owner-email': ownerEmail, 'owner-name': ownerName, 'time-zone': timeZone } = args;
    if (!name) fail('нужен --name');
    if (!ownerEmail) fail('нужен --owner-email');
    if (!ownerName) fail('нужен --owner-name');
    if (!timeZone) fail('нужен --time-zone');
    if (!isValidTimeZone(timeZone)) fail(`неизвестный часовой пояс: ${timeZone}`);

    const store = createSqliteStore(DATABASE_PATH);
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const existing = store.findUserByEmail(ownerEmail);
    if (existing) fail(`email уже занят: ${ownerEmail}`);

    const workspaceId = store.newId('ws');
    store.insertWorkspace({ id: workspaceId, name, timeZone, createdAt: nowIso, updatedAt: nowIso });
    const token = createInvite(store, {
      workspaceId, email: ownerEmail, name: ownerName, role: 'owner', permissions: [],
      kind: 'invite', createdBy: null, now,
    });
    console.log(`Пространство создано: ${workspaceId} (${name}, ${timeZone})`);
    console.log(`Ссылка для владельца (действует ${INVITE_DAYS} дней, одноразовая):`);
    console.log(inviteLink(token));
    store.close();
    return;
  }

  if (command === 'list-workspaces') {
    const store = createSqliteStore(DATABASE_PATH);
    for (const ws of store.listWorkspaces()) {
      const count = store.listUsersByWorkspace(ws.id).length;
      console.log(`${ws.id}\t${ws.name}\t${ws.timeZone}\tпользователей: ${count}`);
    }
    store.close();
    return;
  }

  if (command === 'reset-link') {
    const { email } = args;
    if (!email) fail('нужен --email');
    const store = createSqliteStore(DATABASE_PATH);
    const user = store.findUserByEmail(email);
    if (!user) fail(`пользователь не найден: ${email}`);
    const token = createInvite(store, {
      workspaceId: user.workspaceId, email: user.email, name: user.name, role: user.role,
      permissions: user.permissions, kind: 'reset', createdBy: null, now: Date.now(),
    });
    console.log(`Ссылка сброса пароля (действует ${RESET_HOURS} часов, одноразовая):`);
    console.log(inviteLink(token));
    store.close();
    return;
  }

  if (command === 'disable-user') {
    const { email } = args;
    if (!email) fail('нужен --email');
    const store = createSqliteStore(DATABASE_PATH);
    const user = store.findUserByEmail(email);
    if (!user) fail(`пользователь не найден: ${email}`);
    if (user.role === 'owner') {
      const owners = store.listUsersByWorkspace(user.workspaceId).filter((u) => u.role === 'owner' && u.status === 'active');
      if (owners.length <= 1) fail('нельзя отключить последнего владельца пространства');
    }
    store.updateUser(user.id, { status: 'disabled', updatedAt: new Date().toISOString() });
    store.deleteSessionsForUser(user.id, null);
    console.log(`Отключён: ${email}`);
    store.close();
    return;
  }

  if (command === 'backup-now') {
    const store = createSqliteStore(DATABASE_PATH);
    const { path } = runBackup(store, DATABASE_BACKUP_DIR, Date.now(), console.log);
    console.log(`Готово: ${path}`);
    store.close();
    return;
  }

  if (command === 'restore') {
    const { file } = args;
    if (!file) fail('нужен --file');
    console.log('Останови сервер перед восстановлением (см. README) — иначе изменения могут быть перезаписаны.');
    restoreFrom(file, DATABASE_PATH);
    console.log(`Восстановлено из ${file} в ${DATABASE_PATH}`);
    return;
  }

  console.error('Команды: create-workspace, list-workspaces, reset-link, disable-user, backup-now, restore');
  process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
