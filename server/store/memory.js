// Хранилище в памяти процесса. Используется тестами и демо-стендом (DEMO=1). Данные теряются
// при перезапуске. Тот же интерфейс, что и у `sqlite.js` (docs/specs/08-foundation.md, §1.2) —
// прогоняется теми же контрактными тестами (test/store.contract.test.js).

import { randomBytes } from 'node:crypto';

const clone = (v) => (v === null || v === undefined ? v : structuredClone(v));
const cloneList = (arr) => arr.map(clone);

export function createMemoryStore() {
  // Всё состояние — в одном реассайнящемся объекте, чтобы `transaction()` могла целиком
  // откатить его на снимок при исключении (§1.4).
  let s = {
    workspaces: new Map(),
    users: new Map(),
    usersByEmail: new Map(), // email в нижнем регистре → userId
    events: new Map(),
    eventMembers: new Map(), // eventId → Set<userId>
    tasks: new Map(),
    tasksByEvent: new Map(), // eventId → task[]
    templateIndex: new Map(), // `${eventId}|${templateKey}` → taskId
    idempotency: new Map(), // `${userId}|${key}` → { value, createdAt }
    vendors: new Map(),
    eventVendors: new Map(),
    eventVendorsByEvent: new Map(),
    budgets: new Map(),
    budgetLines: new Map(),
    budgetLinesByEvent: new Map(),
    sessions: new Map(), // idHash → session
    invites: new Map(), // tokenHash → invite
    loginAttempts: [], // { key, ip, at (мс) }
  };

  function snapshot() {
    return {
      workspaces: new Map(s.workspaces),
      users: new Map(s.users),
      usersByEmail: new Map(s.usersByEmail),
      events: new Map(s.events),
      eventMembers: new Map([...s.eventMembers].map(([k, v]) => [k, new Set(v)])),
      tasks: new Map(s.tasks),
      tasksByEvent: new Map([...s.tasksByEvent].map(([k, v]) => [k, v.slice()])),
      templateIndex: new Map(s.templateIndex),
      idempotency: new Map(s.idempotency),
      vendors: new Map(s.vendors),
      eventVendors: new Map(s.eventVendors),
      eventVendorsByEvent: new Map([...s.eventVendorsByEvent].map(([k, v]) => [k, v.slice()])),
      budgets: new Map(s.budgets),
      budgetLines: new Map(s.budgetLines),
      budgetLinesByEvent: new Map([...s.budgetLinesByEvent].map(([k, v]) => [k, v.slice()])),
      sessions: new Map(s.sessions),
      invites: new Map(s.invites),
      loginAttempts: s.loginAttempts.slice(),
    };
  }

  function memberIdsOf(eventId) {
    return [...(s.eventMembers.get(eventId) ?? [])].sort();
  }

  function withMembers(e) {
    if (!e) return null;
    return clone({ ...e, memberIds: memberIdsOf(e.id) });
  }

  return {
    newId(prefix) {
      return `${prefix}_${randomBytes(9).toString('base64url')}`;
    },

    transaction(fn) {
      const backup = snapshot();
      try {
        return fn();
      } catch (err) {
        s = backup;
        throw err;
      }
    },

    // ---------- пространства ----------

    insertWorkspace(ws) { s.workspaces.set(ws.id, clone(ws)); },
    getWorkspace(id) { return clone(s.workspaces.get(id) ?? null); },
    listWorkspaces() { return cloneList([...s.workspaces.values()]); },
    updateWorkspace(id, patch) {
      const w = s.workspaces.get(id);
      if (!w) return null;
      const next = { ...w, ...patch };
      s.workspaces.set(id, next);
      return clone(next);
    },

    // ---------- пользователи ----------

    insertUser(user) {
      s.users.set(user.id, clone(user));
      if (user.email) s.usersByEmail.set(user.email.toLowerCase(), user.id);
    },
    getUser(id) { return clone(s.users.get(id) ?? null); },
    findUserByEmail(email) {
      const id = s.usersByEmail.get(String(email ?? '').toLowerCase());
      return id ? clone(s.users.get(id)) : null;
    },
    listUsers() { return cloneList([...s.users.values()]); },
    listUsersByWorkspace(workspaceId) {
      return cloneList([...s.users.values()].filter((u) => u.workspaceId === workspaceId));
    },
    usersById() {
      const map = new Map();
      for (const [id, u] of s.users) map.set(id, clone(u));
      return map;
    },
    updateUser(id, patch) {
      const u = s.users.get(id);
      if (!u) return null;
      const next = { ...u, ...patch };
      s.users.set(id, next);
      if (patch.email && patch.email.toLowerCase() !== u.email?.toLowerCase()) {
        s.usersByEmail.delete(u.email?.toLowerCase());
        s.usersByEmail.set(next.email.toLowerCase(), id);
      }
      return clone(next);
    },

    // ---------- свадьбы ----------

    insertEvent(event) {
      const { memberIds, ...rest } = event;
      s.events.set(event.id, clone(rest));
      s.eventMembers.set(event.id, new Set(memberIds ?? []));
    },
    getEvent(id) { return withMembers(s.events.get(id)); },
    updateEvent(id, patch) {
      const e = s.events.get(id);
      if (!e) return null;
      const { memberIds, ...rest } = patch;
      const next = { ...e, ...rest };
      s.events.set(id, next);
      if (memberIds !== undefined) s.eventMembers.set(id, new Set(memberIds));
      return withMembers(next);
    },
    listEventsInWorkspace(workspaceId) {
      const out = [];
      for (const e of s.events.values()) if (e.workspaceId === workspaceId) out.push(withMembers(e));
      return out;
    },
    setEventMembers(eventId, userIds) {
      s.eventMembers.set(eventId, new Set(userIds));
    },

    // ---------- задачи ----------

    insertTask(task) {
      if (task.templateKey) {
        const k = `${task.eventId}|${task.templateKey}`;
        if (s.templateIndex.has(k)) throw new Error(`duplicate templateKey ${k}`);
        s.templateIndex.set(k, task.id);
      }
      const t = clone(task);
      s.tasks.set(task.id, t);
      if (!s.tasksByEvent.has(task.eventId)) s.tasksByEvent.set(task.eventId, []);
      s.tasksByEvent.get(task.eventId).push(t);
    },
    getTask(id) { return clone(s.tasks.get(id) ?? null); },
    updateTask(id, patch) {
      const t = s.tasks.get(id);
      if (!t) return null;
      const next = { ...t, ...patch };
      s.tasks.set(id, next);
      const list = s.tasksByEvent.get(t.eventId);
      if (list) {
        const i = list.findIndex((x) => x.id === id);
        if (i >= 0) list[i] = next;
      }
      return clone(next);
    },
    findTaskByTemplateKey(eventId, templateKey) {
      const id = s.templateIndex.get(`${eventId}|${templateKey}`);
      return id ? clone(s.tasks.get(id)) : null;
    },
    /** Задачи набора проектов одним проходом (без N+1). */
    tasksForEvents(eventIds) {
      const map = new Map();
      for (const id of eventIds) map.set(id, cloneList(s.tasksByEvent.get(id) ?? []));
      return map;
    },

    // ---------- идемпотентность ----------

    getIdempotent(userId, key) {
      const rec = s.idempotency.get(`${userId}|${key}`);
      return rec ? clone(rec.value) : null;
    },
    setIdempotent(userId, key, value) {
      s.idempotency.set(`${userId}|${key}`, { value: clone(value), createdAt: Date.now() });
    },
    pruneIdempotency(beforeMs) {
      for (const [k, rec] of s.idempotency) if (rec.createdAt < beforeMs) s.idempotency.delete(k);
    },

    // ---------- личная база подрядчиков ----------

    insertVendor(v) { s.vendors.set(v.id, clone(v)); },
    getVendor(id) { return clone(s.vendors.get(id) ?? null); },
    listVendorsByUser(userId) {
      return cloneList([...s.vendors.values()].filter((v) => v.userId === userId));
    },
    updateVendor(id, patch) {
      const v = s.vendors.get(id);
      if (!v) return null;
      const next = { ...v, ...patch };
      s.vendors.set(id, next);
      return clone(next);
    },
    deleteVendor(id) { s.vendors.delete(id); },

    // ---------- подрядчики свадьбы ----------

    insertEventVendor(ev) {
      const v = clone(ev);
      s.eventVendors.set(ev.id, v);
      if (!s.eventVendorsByEvent.has(ev.eventId)) s.eventVendorsByEvent.set(ev.eventId, []);
      s.eventVendorsByEvent.get(ev.eventId).push(v);
    },
    getEventVendor(id) { return clone(s.eventVendors.get(id) ?? null); },
    updateEventVendor(id, patch) {
      const ev = s.eventVendors.get(id);
      if (!ev) return null;
      const next = { ...ev, ...patch };
      s.eventVendors.set(id, next);
      const list = s.eventVendorsByEvent.get(ev.eventId);
      if (list) {
        const i = list.findIndex((x) => x.id === id);
        if (i >= 0) list[i] = next;
      }
      return clone(next);
    },
    deleteEventVendor(id) {
      const ev = s.eventVendors.get(id);
      if (!ev) return;
      s.eventVendors.delete(id);
      const list = s.eventVendorsByEvent.get(ev.eventId);
      if (list) {
        const i = list.findIndex((x) => x.id === id);
        if (i >= 0) list.splice(i, 1);
      }
    },
    eventVendorsForEvent(eventId) { return cloneList(s.eventVendorsByEvent.get(eventId) ?? []); },
    findEventVendorBySource(eventId, sourceVendorId) {
      const found = (s.eventVendorsByEvent.get(eventId) ?? []).find((ev) => ev.sourceVendorId === sourceVendorId);
      return clone(found ?? null);
    },

    // ---------- смета ----------

    insertBudget(b) { s.budgets.set(b.eventId, clone(b)); },
    getBudget(eventId) { return clone(s.budgets.get(eventId) ?? null); },
    updateBudget(eventId, patch) {
      const b = s.budgets.get(eventId);
      if (!b) return null;
      const next = { ...b, ...patch };
      s.budgets.set(eventId, next);
      return clone(next);
    },

    insertBudgetLine(l) {
      const line = clone(l);
      s.budgetLines.set(l.id, line);
      if (!s.budgetLinesByEvent.has(l.eventId)) s.budgetLinesByEvent.set(l.eventId, []);
      s.budgetLinesByEvent.get(l.eventId).push(line);
    },
    getBudgetLine(id) { return clone(s.budgetLines.get(id) ?? null); },
    updateBudgetLine(id, patch) {
      const l = s.budgetLines.get(id);
      if (!l) return null;
      const next = { ...l, ...patch };
      s.budgetLines.set(id, next);
      const list = s.budgetLinesByEvent.get(l.eventId);
      if (list) {
        const i = list.findIndex((x) => x.id === id);
        if (i >= 0) list[i] = next;
      }
      return clone(next);
    },
    deleteBudgetLine(id) {
      const l = s.budgetLines.get(id);
      if (!l) return;
      s.budgetLines.delete(id);
      const list = s.budgetLinesByEvent.get(l.eventId);
      if (list) {
        const i = list.findIndex((x) => x.id === id);
        if (i >= 0) list.splice(i, 1);
      }
    },
    budgetLinesForEvent(eventId) { return cloneList(s.budgetLinesByEvent.get(eventId) ?? []); },
    findBudgetLineByEventVendor(eventId, eventVendorId) {
      const found = (s.budgetLinesByEvent.get(eventId) ?? []).find((l) => l.sourceEventVendorId === eventVendorId);
      return clone(found ?? null);
    },

    // ---------- сессии ----------

    insertSession(session) { s.sessions.set(session.idHash, clone(session)); },
    getSessionByIdHash(idHash) { return clone(s.sessions.get(idHash) ?? null); },
    touchSession(idHash, patch) {
      const sess = s.sessions.get(idHash);
      if (!sess) return null;
      const next = { ...sess, ...patch };
      s.sessions.set(idHash, next);
      return clone(next);
    },
    deleteSession(idHash) { s.sessions.delete(idHash); },
    deleteSessionsForUser(userId, exceptIdHash = null) {
      for (const [idHash, sess] of s.sessions) {
        if (sess.userId === userId && idHash !== exceptIdHash) s.sessions.delete(idHash);
      }
    },

    // ---------- приглашения ----------

    insertInvite(invite) { s.invites.set(invite.tokenHash, clone(invite)); },
    getInviteByTokenHash(tokenHash) { return clone(s.invites.get(tokenHash) ?? null); },
    markInviteUsed(tokenHash, usedAt) {
      const inv = s.invites.get(tokenHash);
      if (!inv) return null;
      const next = { ...inv, usedAt };
      s.invites.set(tokenHash, next);
      return clone(next);
    },
    findActiveInviteByEmail(workspaceId, email) {
      const lower = email.toLowerCase();
      const found = [...s.invites.values()].find((i) => i.workspaceId === workspaceId
        && i.email.toLowerCase() === lower && !i.usedAt && i.kind === 'invite');
      return clone(found ?? null);
    },
    invalidateInvite(tokenHash) { s.invites.delete(tokenHash); },

    // ---------- попытки входа ----------

    insertLoginAttempt(attempt) { s.loginAttempts.push({ ...attempt }); },
    countLoginAttempts(key, sinceMs) {
      return s.loginAttempts.filter((a) => a.key === key && a.at >= sinceMs).length;
    },
    countLoginAttemptsByIp(ip, sinceMs) {
      return s.loginAttempts.filter((a) => a.ip === ip && a.at >= sinceMs).length;
    },
    pruneLoginAttempts(beforeMs) {
      s.loginAttempts = s.loginAttempts.filter((a) => a.at >= beforeMs);
    },

    // ---------- эксплуатация ----------

    ping() { return true; },
  };
}
