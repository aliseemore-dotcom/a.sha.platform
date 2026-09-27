// Вход, сессии, приглашения (docs/specs/08-foundation.md, разделы 1.6, 2). Хранилище в памяти —
// поведение одинаково с SQLite (см. test/store.contract.test.js), логике авторизации отдельная
// реализация хранилища не важна.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../server/store/memory.js';
import { hashPassword, verifyPassword, validatePassword, PASSWORD_MIN_LENGTH } from '../server/auth/passwords.js';
import { createSession, resolveSession, revokeSession, revokeOtherSessions } from '../server/auth/sessions.js';
import { isLoginLocked, recordFailedLogin } from '../server/auth/loginAttempts.js';
import { attemptLogin, GENERIC_ERROR, LOCKED_ERROR } from '../server/auth/login.js';
import { createInvite, inspectInvite, acceptInvite } from '../server/auth/invites.js';
import { isValidTimeZone } from '../server/time.js';
import { listTeam, inviteMember, resetLinkFor, updateTeamMember } from '../server/team.js';
import { getWorkspace, updateWorkspace, exportWorkspaceData } from '../server/workspace.js';
import { getEventMembersView, setEventMembers, listAssignableMembers } from '../server/eventMembers.js';

const NOW = Date.parse('2026-09-23T09:00:00Z');

function makeWorkspace(store) {
  const nowIso = new Date(NOW).toISOString();
  store.insertWorkspace({ id: 'ws1', name: 'Агентство', timeZone: 'Europe/Moscow', createdAt: nowIso, updatedAt: nowIso });
  return 'ws1';
}
function makeOwner(store, workspaceId, over = {}) {
  const nowIso = new Date(NOW).toISOString();
  const owner = {
    id: 'u_owner', workspaceId, email: 'owner@test.local', name: 'Елена', role: 'owner',
    permissions: [], passwordHash: hashPassword('correct-horse-battery'), status: 'active',
    createdAt: nowIso, updatedAt: nowIso, lastLoginAt: null, ...over,
  };
  store.insertUser(owner);
  return owner;
}

// ---------- пароли ----------

test('пароли: хэш и проверка', () => {
  const hash = hashPassword('correct-horse-battery');
  assert.ok(verifyPassword('correct-horse-battery', hash));
  assert.ok(!verifyPassword('wrong-password', hash));
});

test('пароли: требование к длине', () => {
  assert.equal(validatePassword('short'), `Пароль должен быть не короче ${PASSWORD_MIN_LENGTH} символов`);
  assert.equal(validatePassword('a'.repeat(PASSWORD_MIN_LENGTH)), null);
});

test('пароли: разные хэши для одного пароля (случайная соль)', () => {
  assert.notEqual(hashPassword('correct-horse-battery'), hashPassword('correct-horse-battery'));
});

// ---------- сессии ----------

test('сессии: создание, чтение, отзыв', () => {
  const store = createMemoryStore();
  const workspaceId = makeWorkspace(store);
  const owner = makeOwner(store, workspaceId);
  const { token } = createSession(store, owner.id, 'test-agent', NOW);
  const resolved = resolveSession(store, token, NOW);
  assert.equal(resolved.id, owner.id);
  revokeSession(store, token);
  assert.equal(resolveSession(store, token, NOW), null);
});

test('сессии: истёкшая сессия не резолвится', () => {
  const store = createMemoryStore();
  const workspaceId = makeWorkspace(store);
  const owner = makeOwner(store, workspaceId);
  const { token } = createSession(store, owner.id, 'test-agent', NOW);
  const farFuture = NOW + 31 * 86400_000;
  assert.equal(resolveSession(store, token, farFuture), null);
});

test('сессии: отключённый пользователь теряет доступ по существующей сессии', () => {
  const store = createMemoryStore();
  const workspaceId = makeWorkspace(store);
  const owner = makeOwner(store, workspaceId);
  const { token } = createSession(store, owner.id, 'test-agent', NOW);
  store.updateUser(owner.id, { status: 'disabled' });
  assert.equal(resolveSession(store, token, NOW), null);
});

test('сессии: смена пароля отзывает остальные сессии, кроме текущей', () => {
  const store = createMemoryStore();
  const workspaceId = makeWorkspace(store);
  const owner = makeOwner(store, workspaceId);
  const s1 = createSession(store, owner.id, 'a', NOW);
  const s2 = createSession(store, owner.id, 'b', NOW);
  revokeOtherSessions(store, owner.id, s1.token);
  assert.ok(resolveSession(store, s1.token, NOW));
  assert.equal(resolveSession(store, s2.token, NOW), null);
});

// ---------- вход и ограничение попыток ----------

test('вход: верный и неверный пароль', () => {
  const store = createMemoryStore();
  const workspaceId = makeWorkspace(store);
  makeOwner(store, workspaceId);
  const ok = attemptLogin(store, 'owner@test.local', 'correct-horse-battery', '1.2.3.4', 'ua', NOW);
  assert.ok(ok.ok);
  const bad = attemptLogin(store, 'owner@test.local', 'wrong', '1.2.3.4', 'ua', NOW + 1000);
  assert.equal(bad.ok, false);
  assert.equal(bad.message, GENERIC_ERROR);
});

test('вход: несуществующий email даёт тот же текст ошибки', () => {
  const store = createMemoryStore();
  const result = attemptLogin(store, 'nobody@test.local', 'whatever12', '1.2.3.4', 'ua', NOW);
  assert.equal(result.message, GENERIC_ERROR);
});

test('вход: блокировка после 5 неудачных на пару email+IP', () => {
  const store = createMemoryStore();
  const workspaceId = makeWorkspace(store);
  makeOwner(store, workspaceId);
  for (let i = 0; i < 5; i++) attemptLogin(store, 'owner@test.local', 'wrong', '1.2.3.4', 'ua', NOW + i);
  const locked = attemptLogin(store, 'owner@test.local', 'correct-horse-battery', '1.2.3.4', 'ua', NOW + 10);
  assert.equal(locked.ok, false);
  assert.equal(locked.message, LOCKED_ERROR);
});

test('вход: блокировка не действует на другой IP', () => {
  const store = createMemoryStore();
  const workspaceId = makeWorkspace(store);
  makeOwner(store, workspaceId);
  for (let i = 0; i < 5; i++) attemptLogin(store, 'owner@test.local', 'wrong', '1.2.3.4', 'ua', NOW + i);
  const ok = attemptLogin(store, 'owner@test.local', 'correct-horse-battery', '9.9.9.9', 'ua', NOW + 10);
  assert.ok(ok.ok);
});

test('вход: 30 попыток на IP блокируют, даже с разными email', () => {
  const store = createMemoryStore();
  for (let i = 0; i < 30; i++) attemptLogin(store, `nobody${i}@test.local`, 'wrong', '1.2.3.4', 'ua', NOW + i);
  const workspaceId = makeWorkspace(store);
  makeOwner(store, workspaceId);
  const locked = attemptLogin(store, 'owner@test.local', 'correct-horse-battery', '1.2.3.4', 'ua', NOW + 40);
  assert.equal(locked.ok, false);
  assert.ok(locked.locked);
});

test('login-attempts: isLoginLocked / recordFailedLogin напрямую', () => {
  const store = createMemoryStore();
  assert.equal(isLoginLocked(store, 'a@b.com', '1.1.1.1', NOW), false);
  for (let i = 0; i < 5; i++) recordFailedLogin(store, 'a@b.com', '1.1.1.1', NOW + i);
  assert.equal(isLoginLocked(store, 'a@b.com', '1.1.1.1', NOW + 10), true);
  assert.equal(isLoginLocked(store, 'a@b.com', '1.1.1.1', NOW + 16 * 60_000), false); // окно истекло
});

// ---------- приглашения ----------

test('приглашения: принять создаёт пользователя и логинит', () => {
  const store = createMemoryStore();
  const workspaceId = makeWorkspace(store);
  const token = createInvite(store, {
    workspaceId, email: 'ivan@example.com', name: 'Иван', role: 'member', permissions: [],
    kind: 'invite', createdBy: 'u_owner', now: NOW,
  });
  const check = inspectInvite(store, token, NOW);
  assert.ok(check.ok);
  const result = acceptInvite(store, token, { name: 'Иван', password: 'correct-horse-battery' }, NOW);
  assert.ok(result.ok);
  assert.equal(result.user.role, 'member');
  assert.ok(store.findUserByEmail('ivan@example.com'));
});

test('приглашения: одноразовость — повторное принятие недействительно', () => {
  const store = createMemoryStore();
  const workspaceId = makeWorkspace(store);
  const token = createInvite(store, {
    workspaceId, email: 'ivan@example.com', name: 'Иван', role: 'member', permissions: [],
    kind: 'invite', createdBy: 'u_owner', now: NOW,
  });
  acceptInvite(store, token, { name: 'Иван', password: 'correct-horse-battery' }, NOW);
  const second = acceptInvite(store, token, { name: 'Иван', password: 'correct-horse-battery' }, NOW + 1000);
  assert.equal(second.ok, false);
});

test('приглашения: просроченная ссылка недействительна', () => {
  const store = createMemoryStore();
  const workspaceId = makeWorkspace(store);
  const token = createInvite(store, {
    workspaceId, email: 'ivan@example.com', name: 'Иван', role: 'member', permissions: [],
    kind: 'invite', createdBy: 'u_owner', now: NOW,
  });
  const eightDaysLater = NOW + 8 * 86400_000;
  const check = inspectInvite(store, token, eightDaysLater);
  assert.equal(check.ok, false);
});

test('приглашения: новое приглашение на тот же email заменяет активное', () => {
  const store = createMemoryStore();
  const workspaceId = makeWorkspace(store);
  const first = createInvite(store, {
    workspaceId, email: 'ivan@example.com', name: 'Иван', role: 'member', permissions: [],
    kind: 'invite', createdBy: 'u_owner', now: NOW,
  });
  const second = createInvite(store, {
    workspaceId, email: 'ivan@example.com', name: 'Иван', role: 'member', permissions: [],
    kind: 'invite', createdBy: 'u_owner', now: NOW + 1000,
  });
  assert.equal(inspectInvite(store, first, NOW + 2000).ok, false);
  assert.ok(inspectInvite(store, second, NOW + 2000).ok);
});

test('приглашения: email занят другим пользователем — та же ошибка, без подробностей', () => {
  const store = createMemoryStore();
  const workspaceId = makeWorkspace(store);
  makeOwner(store, workspaceId, { email: 'ivan@example.com', id: 'u_taken' });
  const token = createInvite(store, {
    workspaceId, email: 'ivan@example.com', name: 'Иван', role: 'member', permissions: [],
    kind: 'invite', createdBy: 'u_owner', now: NOW,
  });
  const result = acceptInvite(store, token, { name: 'Иван', password: 'correct-horse-battery' }, NOW);
  assert.equal(result.ok, false);
  assert.ok(!result.field); // не «422 validation», а тот же общий текст, что и для недействительной ссылки
});

test('сброс пароля: принятие меняет пароль и отзывает старые сессии', () => {
  const store = createMemoryStore();
  const workspaceId = makeWorkspace(store);
  const owner = makeOwner(store, workspaceId);
  const oldSession = createSession(store, owner.id, 'ua', NOW);
  const token = createInvite(store, {
    workspaceId, email: owner.email, name: owner.name, role: owner.role, permissions: owner.permissions,
    kind: 'reset', createdBy: owner.id, now: NOW,
  });
  const result = acceptInvite(store, token, { password: 'new-correct-horse' }, NOW + 1000);
  assert.ok(result.ok);
  assert.equal(resolveSession(store, oldSession.token, NOW + 1000), null);
  assert.ok(verifyPassword('new-correct-horse', store.getUser(owner.id).passwordHash));
});

// ---------- часовой пояс ----------

test('isValidTimeZone: принимает валидные IANA-имена, отклоняет мусор', () => {
  assert.ok(isValidTimeZone('Europe/Moscow'));
  assert.ok(isValidTimeZone('Asia/Dubai'));
  assert.equal(isValidTimeZone('Not/AZone'), false);
  assert.equal(isValidTimeZone(''), false);
  assert.equal(isValidTimeZone(undefined), false);
});

// ---------- команда ----------

test('команда: список, приглашение, право «может создавать»', () => {
  const store = createMemoryStore();
  const workspaceId = makeWorkspace(store);
  const owner = makeOwner(store, workspaceId);
  const ctx = { store, user: owner, now: NOW };
  const { token } = inviteMember(ctx, { email: 'ivan@example.com', name: 'Иван', role: 'member', canCreateEvents: true });
  assert.ok(token);
  const check = inspectInvite(store, token, NOW);
  assert.deepEqual(check.invite.permissions, ['event:create']);
  assert.equal(listTeam(ctx).items.length, 1); // приглашённый ещё не принял — пока не пользователь
});

test('команда: участник не может видеть команду', () => {
  const store = createMemoryStore();
  const workspaceId = makeWorkspace(store);
  makeOwner(store, workspaceId);
  const member = { id: 'u_m', workspaceId, email: 'm@test.local', name: 'М', role: 'member', permissions: [], status: 'active' };
  store.insertUser(member);
  assert.throws(() => listTeam({ store, user: member, now: NOW }), /403|forbidden|Только владелец/);
});

test('команда: владелец не может отключить себя', () => {
  const store = createMemoryStore();
  const workspaceId = makeWorkspace(store);
  const owner = makeOwner(store, workspaceId);
  const ctx = { store, user: owner, now: NOW };
  assert.throws(() => updateTeamMember(ctx, owner.id, { status: 'disabled' }));
});

test('команда: нельзя снять роль с последнего владельца', () => {
  const store = createMemoryStore();
  const workspaceId = makeWorkspace(store);
  const owner = makeOwner(store, workspaceId);
  const ctx = { store, user: owner, now: NOW };
  assert.throws(() => updateTeamMember(ctx, owner.id, { role: 'member' }));
});

test('команда: ссылка сброса для участника создаётся владельцем', () => {
  const store = createMemoryStore();
  const workspaceId = makeWorkspace(store);
  const owner = makeOwner(store, workspaceId);
  const member = { id: 'u_m', workspaceId, email: 'm@test.local', name: 'М', role: 'member', permissions: [], status: 'active', passwordHash: hashPassword('old-password1') };
  store.insertUser(member);
  const { token } = resetLinkFor({ store, user: owner, now: NOW }, member.id);
  const check = inspectInvite(store, token, NOW);
  assert.ok(check.ok);
  assert.equal(check.invite.kind, 'reset');
});

// ---------- настройки пространства ----------

test('пространство: смена часового пояса требует expectedUpdatedAt', () => {
  const store = createMemoryStore();
  const workspaceId = makeWorkspace(store);
  const owner = makeOwner(store, workspaceId);
  const ctx = { store, user: owner, now: NOW };
  assert.throws(() => updateWorkspace(ctx, { timeZone: 'Asia/Dubai' }));
  const ws = getWorkspace(ctx);
  const updated = updateWorkspace(ctx, { timeZone: 'Asia/Dubai', expectedUpdatedAt: ws.updatedAt });
  assert.equal(updated.timeZone, 'Asia/Dubai');
});

test('пространство: конфликт при устаревшем expectedUpdatedAt', () => {
  const store = createMemoryStore();
  const workspaceId = makeWorkspace(store);
  const owner = makeOwner(store, workspaceId);
  const ctx = { store, user: owner, now: NOW };
  assert.throws(() => updateWorkspace(ctx, { timeZone: 'Asia/Dubai', expectedUpdatedAt: 'старое' }), (err) => err.status === 409);
});

test('пространство: неверный часовой пояс — 422', () => {
  const store = createMemoryStore();
  const workspaceId = makeWorkspace(store);
  const owner = makeOwner(store, workspaceId);
  const ctx = { store, user: owner, now: NOW };
  const ws = getWorkspace(ctx);
  assert.throws(() => updateWorkspace(ctx, { timeZone: 'Мусор', expectedUpdatedAt: ws.updatedAt }), (err) => err.status === 422);
});

// ---------- участники свадьбы ----------

test('участники свадьбы: только member попадают в кандидаты, owner — нет', () => {
  const store = createMemoryStore();
  const workspaceId = makeWorkspace(store);
  const owner = makeOwner(store, workspaceId);
  const member = { id: 'u_m', workspaceId, email: 'm@test.local', name: 'М', role: 'member', permissions: [], status: 'active' };
  store.insertUser(member);
  const candidates = listAssignableMembers({ store, user: owner, now: NOW });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].id, 'u_m');
});

test('участники свадьбы: назначение сохраняется и видно в getEventMembersView', () => {
  const store = createMemoryStore();
  const workspaceId = makeWorkspace(store);
  const owner = makeOwner(store, workspaceId);
  const member = { id: 'u_m', workspaceId, email: 'm@test.local', name: 'М', role: 'member', permissions: [], status: 'active' };
  store.insertUser(member);
  const nowIso = new Date(NOW).toISOString();
  store.insertEvent({ id: 'e1', workspaceId, title: 'Свадьба', memberIds: [], createdAt: nowIso, updatedAt: nowIso });

  const ctx = { store, user: owner, now: NOW };
  const view = getEventMembersView(ctx, 'e1');
  setEventMembers(ctx, 'e1', { userIds: [member.id], expectedUpdatedAt: view.updatedAt });
  assert.deepEqual(getEventMembersView(ctx, 'e1').memberIds, [member.id]);
});

test('участники свадьбы: чужой или отключённый пользователь — 422', () => {
  const store = createMemoryStore();
  const workspaceId = makeWorkspace(store);
  const owner = makeOwner(store, workspaceId);
  const nowIso = new Date(NOW).toISOString();
  store.insertEvent({ id: 'e1', workspaceId, title: 'Свадьба', memberIds: [], createdAt: nowIso, updatedAt: nowIso });
  const ctx = { store, user: owner, now: NOW };
  const view = getEventMembersView(ctx, 'e1');
  assert.throws(() => setEventMembers(ctx, 'e1', { userIds: ['u_nobody'], expectedUpdatedAt: view.updatedAt }), (err) => err.status === 422);
});

// ---------- экспорт данных пространства ----------

test('экспорт: только владелец, без хэшей паролей, с чужим пространством не путается', () => {
  const store = createMemoryStore();
  const workspaceId = makeWorkspace(store);
  const owner = makeOwner(store, workspaceId);
  const nowIso = new Date(NOW).toISOString();
  store.insertEvent({ id: 'e1', workspaceId, title: 'Свадьба', memberIds: [], createdAt: nowIso, updatedAt: nowIso });
  store.insertTask({ id: 't1', eventId: 'e1', title: 'Задача', status: 'todo', createdAt: nowIso, updatedAt: nowIso });

  const otherWorkspaceId = 'ws2';
  store.insertWorkspace({ id: otherWorkspaceId, name: 'Чужое', timeZone: 'UTC', createdAt: nowIso, updatedAt: nowIso });
  store.insertEvent({ id: 'e2', workspaceId: otherWorkspaceId, title: 'Чужая свадьба', memberIds: [], createdAt: nowIso, updatedAt: nowIso });

  const member = { id: 'u_m', workspaceId, email: 'm@test.local', name: 'М', role: 'member', permissions: [], status: 'active' };
  store.insertUser(member);

  const dump = exportWorkspaceData({ store, user: owner, now: NOW });
  assert.equal(dump.events.length, 1);
  assert.equal(dump.events[0].id, 'e1');
  assert.equal(dump.tasks.length, 1);
  assert.ok(dump.users.every((u) => !('passwordHash' in u)));

  const memberCtx = { store, user: member, now: NOW };
  assert.throws(() => exportWorkspaceData(memberCtx));
});
