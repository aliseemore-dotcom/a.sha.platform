import { createStore } from '../server/store.js';

export const TZ = 'Europe/Moscow';
// 23 сентября 2026, 12:00 по Москве
export const NOON = Date.parse('2026-09-23T09:00:00Z');

export function setup() {
  const store = createStore();
  store.insertWorkspace({ id: 'ws1', name: 'Агентство', timeZone: TZ });
  store.insertWorkspace({ id: 'ws2', name: 'Чужое', timeZone: TZ });
  const owner = { id: 'u_owner', name: 'Елена', role: 'owner', workspaceId: 'ws1', permissions: [] };
  const member = { id: 'u_member', name: 'Ольга', role: 'member', workspaceId: 'ws1', permissions: [] };
  const creator = { id: 'u_creator', name: 'Иван', role: 'member', workspaceId: 'ws1', permissions: ['event:create'] };
  const stranger = { id: 'u_stranger', name: 'Сергей', role: 'owner', workspaceId: 'ws2', permissions: [] };
  [owner, member, creator, stranger].forEach((u) => store.insertUser(u));

  let seq = 0;
  const event = (over = {}) => {
    const e = {
      id: over.id ?? `evt_${++seq}`, workspaceId: 'ws1', title: 'Свадьба', kind: 'wedding',
      eventDate: null, locationName: null, lifecycle: 'active', coverUrl: null, memberIds: [],
      planStatus: 'ready', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', ...over,
    };
    store.insertEvent(e);
    return e;
  };
  const task = (eventId, over = {}) => {
    const t = {
      id: over.id ?? `task_${++seq}`, eventId, title: 'Задача', status: 'planned',
      dueAt: null, dueDate: null, followUpAt: null, assigneeId: null,
      createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', ...over,
    };
    store.insertTask(t);
    return t;
  };
  const ctx = (user, now = NOON) => ({ store, user, now, timeZone: TZ });
  return { store, owner, member, creator, stranger, event, task, ctx };
}
