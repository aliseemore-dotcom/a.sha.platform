// Настройки рабочего пространства (docs/specs/08-foundation.md, §3): название и часовой пояс.
// Только владельцу.

import { ServiceError } from './errors.js';
import { isValidTimeZone } from './time.js';

const NAME_MAX = 80;

function requireOwner(user) {
  if (user.role !== 'owner') throw new ServiceError(403, 'forbidden', 'Только владелец может менять настройки пространства');
}

export function getWorkspace(ctx) {
  requireOwner(ctx.user);
  const ws = ctx.store.getWorkspace(ctx.user.workspaceId);
  return { id: ws.id, name: ws.name, timeZone: ws.timeZone, updatedAt: ws.updatedAt };
}

export function updateWorkspace(ctx, body) {
  requireOwner(ctx.user);
  const ws = ctx.store.getWorkspace(ctx.user.workspaceId);

  if (typeof body?.expectedUpdatedAt !== 'string' || !body.expectedUpdatedAt) {
    throw new ServiceError(400, 'bad_request', 'Нужен expectedUpdatedAt');
  }
  if (body.expectedUpdatedAt !== ws.updatedAt) {
    throw new ServiceError(409, 'conflict', 'Данные изменил кто-то другой. Обновите страницу.');
  }

  const fields = {};
  const patch = {};
  if ('name' in body) {
    const name = String(body.name ?? '').trim();
    if (!name) fields.name = 'Укажите название пространства';
    else if ([...name].length > NAME_MAX) fields.name = `Не более ${NAME_MAX} символов`;
    else patch.name = name;
  }
  if ('timeZone' in body) {
    if (!isValidTimeZone(body.timeZone)) fields.timeZone = 'Выберите часовой пояс из списка';
    else patch.timeZone = body.timeZone;
  }
  if (Object.keys(fields).length) throw new ServiceError(422, 'validation', 'Проверьте поля формы', fields);

  patch.updatedAt = new Date(ctx.now).toISOString();
  const updated = ctx.store.updateWorkspace(ctx.user.workspaceId, patch);
  return { id: updated.id, name: updated.name, timeZone: updated.timeZone, updatedAt: updated.updatedAt };
}

/**
 * «Скачать данные пространства» (docs/specs/08-foundation.md, §4) — единый JSON-файл, нужен и
 * для доверия пилотных пользователей, и как ручная резервная копия. Пароли — никогда.
 */
export function exportWorkspaceData(ctx) {
  requireOwner(ctx.user);
  const { store, user } = ctx;
  const workspaceId = user.workspaceId;

  const workspace = store.getWorkspace(workspaceId);
  const users = store.listUsersByWorkspace(workspaceId)
    .map(({ passwordHash, ...u }) => u);
  const events = store.listEventsInWorkspace(workspaceId);
  const tasksByEvent = store.tasksForEvents(events.map((e) => e.id));
  const tasks = events.flatMap((e) => tasksByEvent.get(e.id) ?? []);
  const eventVendors = events.flatMap((e) => store.eventVendorsForEvent(e.id));
  const budgets = events.map((e) => store.getBudget(e.id)).filter(Boolean);
  const budgetLines = events.flatMap((e) => store.budgetLinesForEvent(e.id));
  const vendors = users.flatMap((u) => store.listVendorsByUser(u.id));

  return {
    exportedAt: new Date(ctx.now).toISOString(),
    workspace: { id: workspace.id, name: workspace.name, timeZone: workspace.timeZone },
    users, events, tasks, vendors, eventVendors, budgets, budgetLines,
  };
}
