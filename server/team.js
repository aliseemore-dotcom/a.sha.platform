// Страница «Команда» (docs/specs/08-foundation.md, §2.6): список пользователей пространства,
// приглашения, ссылки сброса пароля, роль и право создавать свадьбы. Только владельцу.

import { ServiceError } from './errors.js';
import { createInvite, INVITE_DAYS, RESET_HOURS } from './auth/invites.js';
import { revokeOtherSessions } from './auth/sessions.js';

const NAME_MAX = 60;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function requireOwner(user) {
  if (user.role !== 'owner') throw new ServiceError(403, 'forbidden', 'Только владелец видит команду');
}

function publicUser(u) {
  return {
    id: u.id, name: u.name, email: u.email, role: u.role,
    canCreateEvents: u.role === 'owner' || (u.permissions ?? []).includes('event:create'),
    status: u.status, lastLoginAt: u.lastLoginAt ?? null,
  };
}

export function listTeam(ctx) {
  requireOwner(ctx.user);
  return { items: ctx.store.listUsersByWorkspace(ctx.user.workspaceId).map(publicUser) };
}

export function inviteMember(ctx, body) {
  requireOwner(ctx.user);
  const { store, user, now } = ctx;

  const email = String(body?.email ?? '').trim().toLowerCase();
  const name = String(body?.name ?? '').trim();
  const role = body?.role === 'owner' ? 'owner' : 'member';
  const fields = {};
  if (!EMAIL_RE.test(email)) fields.email = 'Укажите email';
  else if (store.findUserByEmail(email)) fields.email = 'Этот email уже занят';
  if (!name) fields.name = 'Укажите имя';
  else if ([...name].length > NAME_MAX) fields.name = `Не более ${NAME_MAX} символов`;
  if (Object.keys(fields).length) throw new ServiceError(422, 'validation', 'Проверьте поля формы', fields);

  const permissions = role === 'member' && body?.canCreateEvents ? ['event:create'] : [];
  const token = createInvite(store, {
    workspaceId: user.workspaceId, email, name, role, permissions, kind: 'invite', createdBy: user.id, now,
  });
  return { token, expiresInDays: INVITE_DAYS };
}

function getManagedUser(ctx, userId) {
  const target = ctx.store.getUser(userId);
  if (!target || target.workspaceId !== ctx.user.workspaceId) {
    throw new ServiceError(404, 'not_found', 'Пользователь не найден');
  }
  return target;
}

export function resetLinkFor(ctx, userId) {
  requireOwner(ctx.user);
  const { store, user, now } = ctx;
  const target = getManagedUser(ctx, userId);
  const token = createInvite(store, {
    workspaceId: user.workspaceId, email: target.email, name: target.name, role: target.role,
    permissions: target.permissions, kind: 'reset', createdBy: user.id, now,
  });
  return { token, expiresInHours: RESET_HOURS };
}

/** Владелец не может отключить себя и не может снять роль с последнего владельца (§2.6). */
export function updateTeamMember(ctx, userId, body) {
  requireOwner(ctx.user);
  const { store, user, now } = ctx;
  const target = getManagedUser(ctx, userId);
  const patch = { updatedAt: new Date(now).toISOString() };

  const owners = () => store.listUsersByWorkspace(user.workspaceId).filter((u) => u.role === 'owner' && u.status === 'active');

  if ('status' in body) {
    const status = body.status === 'disabled' ? 'disabled' : 'active';
    if (status === 'disabled' && target.id === user.id) {
      throw new ServiceError(422, 'validation', 'Нельзя отключить себя', { status: 'Нельзя отключить себя' });
    }
    if (status === 'disabled' && target.role === 'owner' && owners().length <= 1) {
      throw new ServiceError(422, 'validation', 'Нельзя отключить последнего владельца', { status: 'Последний владелец' });
    }
    patch.status = status;
    if (status === 'disabled') revokeOtherSessions(store, target.id, null);
  }

  if ('role' in body) {
    const role = body.role === 'owner' ? 'owner' : 'member';
    if (role === 'member' && target.role === 'owner' && owners().length <= 1) {
      throw new ServiceError(422, 'validation', 'Нельзя снять роль с последнего владельца', { role: 'Последний владелец' });
    }
    patch.role = role;
  }

  if ('canCreateEvents' in body) {
    const perms = new Set(target.permissions ?? []);
    if (body.canCreateEvents) perms.add('event:create'); else perms.delete('event:create');
    patch.permissions = [...perms];
  }

  const updated = store.updateUser(userId, patch);
  return publicUser(updated);
}
