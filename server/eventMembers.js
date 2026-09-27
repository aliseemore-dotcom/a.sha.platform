// Участники свадьбы (docs/specs/08-foundation.md, §2.7): без этого приглашённый участник видит
// пустой список — добавить его в `memberIds` в интерфейсе было нельзя.

import { canSeeEvent } from './access.js';
import { ServiceError } from './errors.js';

const notFound = () => new ServiceError(404, 'not_found', 'Проект не найден или недоступен');

function requireOwner(user) {
  if (user.role !== 'owner') throw new ServiceError(403, 'forbidden', 'Только владелец может менять участников');
}

/** Пользователи пространства с ролью `member` — владельцы не показываются, они видят всё. */
export function listAssignableMembers(ctx) {
  requireOwner(ctx.user);
  return ctx.store.listUsersByWorkspace(ctx.user.workspaceId)
    .filter((u) => u.role === 'member')
    .map((u) => ({ id: u.id, name: u.name, email: u.email, status: u.status }));
}

/** Для диалога «Участники»: текущий список и все участники пространства, которых можно добавить. */
export function getEventMembersView(ctx, eventId) {
  const event = ctx.store.getEvent(eventId);
  if (!canSeeEvent(ctx.user, event)) throw notFound();
  requireOwner(ctx.user);
  return {
    eventId: event.id,
    memberIds: event.memberIds,
    updatedAt: event.updatedAt,
    candidates: listAssignableMembers(ctx),
  };
}

export function setEventMembers(ctx, eventId, body) {
  const { store, user, now } = ctx;
  const event = store.getEvent(eventId);
  if (!canSeeEvent(user, event)) throw notFound();
  requireOwner(user);

  if (typeof body?.expectedUpdatedAt !== 'string' || !body.expectedUpdatedAt) {
    throw new ServiceError(400, 'bad_request', 'Нужен expectedUpdatedAt');
  }
  if (body.expectedUpdatedAt !== event.updatedAt) {
    throw new ServiceError(409, 'conflict', 'Данные изменил кто-то другой. Обновите страницу.');
  }

  const requested = Array.isArray(body?.userIds) ? [...new Set(body.userIds)] : [];
  const membersById = new Map(
    store.listUsersByWorkspace(user.workspaceId).filter((u) => u.role === 'member').map((u) => [u.id, u]),
  );
  for (const id of requested) {
    const candidate = membersById.get(id);
    if (!candidate || candidate.status !== 'active') {
      throw new ServiceError(422, 'validation', 'Чужой или отключённый пользователь', { userIds: 'Проверьте список' });
    }
  }

  const nowIso = new Date(now).toISOString();
  const updated = store.updateEvent(eventId, { memberIds: requested, updatedAt: nowIso });
  return { id: updated.id, memberIds: updated.memberIds, updatedAt: updated.updatedAt };
}
