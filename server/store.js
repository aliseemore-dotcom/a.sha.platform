// Хранилище в памяти процесса. Интерфейс — то, что нужно сервисам; при переходе на базу данных
// заменяется этот модуль, сервисы и UI не меняются. Данные теряются при перезапуске.

import { randomBytes } from 'node:crypto';

export function createStore() {
  const workspaces = new Map();
  const users = new Map();
  const events = new Map();
  const tasks = new Map();
  const tasksByEvent = new Map();
  const templateIndex = new Map(); // `${eventId}|${templateKey}` → taskId
  const idempotency = new Map();   // `${userId}|${key}` → ответ создания
  const vendors = new Map();          // личная база подрядчиков пользователя
  const eventVendors = new Map();     // подрядчики, добавленные в конкретную свадьбу (копия данных)
  const eventVendorsByEvent = new Map();

  return {
    newId(prefix) {
      return `${prefix}_${randomBytes(9).toString('base64url')}`;
    },

    insertWorkspace(ws) { workspaces.set(ws.id, ws); },
    getWorkspace(id) { return workspaces.get(id) ?? null; },

    insertUser(user) { users.set(user.id, user); },
    getUser(id) { return users.get(id) ?? null; },
    listUsers() { return [...users.values()]; },
    usersById() { return users; },

    insertEvent(event) { events.set(event.id, event); },
    getEvent(id) { return events.get(id) ?? null; },
    updateEvent(id, patch) {
      const e = events.get(id);
      if (!e) return null;
      Object.assign(e, patch);
      return e;
    },
    listEventsInWorkspace(workspaceId) {
      const out = [];
      for (const e of events.values()) if (e.workspaceId === workspaceId) out.push(e);
      return out;
    },

    insertTask(task) {
      if (task.templateKey) {
        const k = `${task.eventId}|${task.templateKey}`;
        if (templateIndex.has(k)) throw new Error(`duplicate templateKey ${k}`);
        templateIndex.set(k, task.id);
      }
      tasks.set(task.id, task);
      if (!tasksByEvent.has(task.eventId)) tasksByEvent.set(task.eventId, []);
      tasksByEvent.get(task.eventId).push(task);
    },
    getTask(id) { return tasks.get(id) ?? null; },
    updateTask(id, patch) {
      const t = tasks.get(id);
      if (!t) return null;
      Object.assign(t, patch);
      return t;
    },
    findTaskByTemplateKey(eventId, templateKey) {
      const id = templateIndex.get(`${eventId}|${templateKey}`);
      return id ? tasks.get(id) : null;
    },
    /** Задачи набора проектов одним проходом (без N+1). */
    tasksForEvents(eventIds) {
      const map = new Map();
      for (const id of eventIds) map.set(id, tasksByEvent.get(id) ?? []);
      return map;
    },

    getIdempotent(userId, key) { return idempotency.get(`${userId}|${key}`) ?? null; },
    setIdempotent(userId, key, value) { idempotency.set(`${userId}|${key}`, value); },

    insertVendor(v) { vendors.set(v.id, v); },
    getVendor(id) { return vendors.get(id) ?? null; },
    listVendorsByUser(userId) {
      const out = [];
      for (const v of vendors.values()) if (v.userId === userId) out.push(v);
      return out;
    },
    updateVendor(id, patch) {
      const v = vendors.get(id);
      if (!v) return null;
      Object.assign(v, patch);
      return v;
    },
    deleteVendor(id) { vendors.delete(id); },

    insertEventVendor(ev) {
      eventVendors.set(ev.id, ev);
      if (!eventVendorsByEvent.has(ev.eventId)) eventVendorsByEvent.set(ev.eventId, []);
      eventVendorsByEvent.get(ev.eventId).push(ev);
    },
    getEventVendor(id) { return eventVendors.get(id) ?? null; },
    updateEventVendor(id, patch) {
      const ev = eventVendors.get(id);
      if (!ev) return null;
      Object.assign(ev, patch);
      return ev;
    },
    deleteEventVendor(id) {
      const ev = eventVendors.get(id);
      if (!ev) return;
      eventVendors.delete(id);
      const list = eventVendorsByEvent.get(ev.eventId);
      if (list) {
        const i = list.findIndex((x) => x.id === id);
        if (i >= 0) list.splice(i, 1);
      }
    },
    eventVendorsForEvent(eventId) { return eventVendorsByEvent.get(eventId) ?? []; },
    findEventVendorBySource(eventId, sourceVendorId) {
      return (eventVendorsByEvent.get(eventId) ?? []).find((ev) => ev.sourceVendorId === sourceVendorId) ?? null;
    },
  };
}
