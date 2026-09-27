// Хранилище на SQLite (`node:sqlite`, синхронный `DatabaseSync`) — тот же интерфейс, что у
// `memory.js` (docs/specs/08-foundation.md, §1.1–1.4). Используется, когда `DEMO=0`.
//
// Каждая строка хранит основной объект целиком в столбце `data` (JSON); несколько полей
// дублируются в обычные столбцы для внешних ключей, уникальности и индексов. Каждый метод
// возвращает свежий объект, разобранный из JSON — не общую ссылку с тем, что лежит в базе,
// поэтому правка возвращённого объекта извне не меняет сохранённые данные (§1.3), как и в
// хранилище в памяти.

import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { runMigrations } from '../db/migrate.js';

function parseRow(row) {
  if (!row) return null;
  return JSON.parse(row.data);
}

export function createSqliteStore(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  runMigrations(db);

  let inTransaction = false;

  const store = {
    _db: db,

    newId(prefix) {
      return `${prefix}_${randomBytes(9).toString('base64url')}`;
    },

    transaction(fn) {
      if (inTransaction) return fn(); // на всякий случай — вложенных транзакций в сервисах нет
      db.exec('BEGIN IMMEDIATE');
      inTransaction = true;
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      } finally {
        inTransaction = false;
      }
    },

    // ---------- пространства ----------

    insertWorkspace(ws) {
      db.prepare('INSERT INTO workspaces (id, data, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run(ws.id, JSON.stringify(ws), ws.createdAt ?? '', ws.updatedAt ?? '');
    },
    getWorkspace(id) {
      return parseRow(db.prepare('SELECT data FROM workspaces WHERE id = ?').get(id));
    },
    listWorkspaces() {
      return db.prepare('SELECT data FROM workspaces').all().map(parseRow);
    },
    updateWorkspace(id, patch) {
      const cur = store.getWorkspace(id);
      if (!cur) return null;
      const next = { ...cur, ...patch };
      db.prepare('UPDATE workspaces SET data = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(next), next.updatedAt ?? cur.updatedAt ?? '', id);
      return next;
    },

    // ---------- пользователи ----------

    insertUser(user) {
      db.prepare('INSERT INTO users (id, workspace_id, email, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(user.id, user.workspaceId, user.email.toLowerCase(), JSON.stringify(user), user.createdAt ?? '', user.updatedAt ?? '');
    },
    getUser(id) {
      return parseRow(db.prepare('SELECT data FROM users WHERE id = ?').get(id));
    },
    findUserByEmail(email) {
      return parseRow(db.prepare('SELECT data FROM users WHERE email = ?').get(String(email ?? '').toLowerCase()));
    },
    listUsers() {
      return db.prepare('SELECT data FROM users').all().map(parseRow);
    },
    listUsersByWorkspace(workspaceId) {
      return db.prepare('SELECT data FROM users WHERE workspace_id = ?').all(workspaceId).map(parseRow);
    },
    usersById() {
      const map = new Map();
      for (const row of db.prepare('SELECT data FROM users').all()) {
        const u = parseRow(row);
        map.set(u.id, u);
      }
      return map;
    },
    updateUser(id, patch) {
      const cur = store.getUser(id);
      if (!cur) return null;
      const next = { ...cur, ...patch };
      db.prepare('UPDATE users SET email = ?, data = ?, updated_at = ? WHERE id = ?')
        .run(next.email.toLowerCase(), JSON.stringify(next), next.updatedAt ?? cur.updatedAt ?? '', id);
      return next;
    },

    // ---------- свадьбы ----------

    insertEvent(event) {
      const { memberIds, ...rest } = event;
      db.prepare('INSERT INTO events (id, workspace_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(event.id, event.workspaceId, JSON.stringify(rest), event.createdAt ?? '', event.updatedAt ?? '');
      store.setEventMembers(event.id, memberIds ?? []);
    },
    getEvent(id) {
      const e = parseRow(db.prepare('SELECT data FROM events WHERE id = ?').get(id));
      if (!e) return null;
      return { ...e, memberIds: store._memberIdsOf(id) };
    },
    updateEvent(id, patch) {
      const cur = parseRow(db.prepare('SELECT data FROM events WHERE id = ?').get(id));
      if (!cur) return null;
      const { memberIds, ...rest } = patch;
      const next = { ...cur, ...rest };
      db.prepare('UPDATE events SET data = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(next), next.updatedAt ?? cur.updatedAt ?? '', id);
      if (memberIds !== undefined) store.setEventMembers(id, memberIds);
      return { ...next, memberIds: store._memberIdsOf(id) };
    },
    listEventsInWorkspace(workspaceId) {
      return db.prepare('SELECT id, data FROM events WHERE workspace_id = ?').all(workspaceId)
        .map((row) => ({ ...JSON.parse(row.data), memberIds: store._memberIdsOf(row.id) }));
    },
    setEventMembers(eventId, userIds) {
      db.prepare('DELETE FROM event_members WHERE event_id = ?').run(eventId);
      const insert = db.prepare('INSERT INTO event_members (event_id, user_id) VALUES (?, ?)');
      for (const userId of userIds) insert.run(eventId, userId);
    },
    _memberIdsOf(eventId) {
      return db.prepare('SELECT user_id FROM event_members WHERE event_id = ? ORDER BY user_id').all(eventId)
        .map((r) => r.user_id);
    },

    // ---------- задачи ----------

    insertTask(task) {
      try {
        db.prepare('INSERT INTO tasks (id, event_id, template_key, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(task.id, task.eventId, task.templateKey ?? null, JSON.stringify(task), task.createdAt ?? '', task.updatedAt ?? '');
      } catch (err) {
        if (String(err.message).includes('UNIQUE')) throw new Error(`duplicate templateKey ${task.eventId}|${task.templateKey}`);
        throw err;
      }
    },
    getTask(id) {
      return parseRow(db.prepare('SELECT data FROM tasks WHERE id = ?').get(id));
    },
    updateTask(id, patch) {
      const cur = store.getTask(id);
      if (!cur) return null;
      const next = { ...cur, ...patch };
      db.prepare('UPDATE tasks SET data = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(next), next.updatedAt ?? cur.updatedAt ?? '', id);
      return next;
    },
    findTaskByTemplateKey(eventId, templateKey) {
      return parseRow(db.prepare('SELECT data FROM tasks WHERE event_id = ? AND template_key = ?').get(eventId, templateKey));
    },
    tasksForEvents(eventIds) {
      const map = new Map();
      for (const id of eventIds) {
        map.set(id, db.prepare('SELECT data FROM tasks WHERE event_id = ?').all(id).map(parseRow));
      }
      return map;
    },

    // ---------- идемпотентность ----------

    getIdempotent(userId, key) {
      const row = db.prepare('SELECT value FROM idempotency WHERE user_id = ? AND key = ?').get(userId, key);
      return row ? JSON.parse(row.value) : null;
    },
    setIdempotent(userId, key, value) {
      db.prepare('INSERT OR REPLACE INTO idempotency (user_id, key, value, created_at) VALUES (?, ?, ?, ?)')
        .run(userId, key, JSON.stringify(value), Date.now());
    },
    pruneIdempotency(beforeMs) {
      db.prepare('DELETE FROM idempotency WHERE created_at < ?').run(beforeMs);
    },

    // ---------- личная база подрядчиков ----------

    insertVendor(v) {
      db.prepare('INSERT INTO vendors (id, user_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(v.id, v.userId, JSON.stringify(v), v.createdAt ?? '', v.updatedAt ?? '');
    },
    getVendor(id) {
      return parseRow(db.prepare('SELECT data FROM vendors WHERE id = ?').get(id));
    },
    listVendorsByUser(userId) {
      return db.prepare('SELECT data FROM vendors WHERE user_id = ?').all(userId).map(parseRow);
    },
    updateVendor(id, patch) {
      const cur = store.getVendor(id);
      if (!cur) return null;
      const next = { ...cur, ...patch };
      db.prepare('UPDATE vendors SET data = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(next), next.updatedAt ?? cur.updatedAt ?? '', id);
      return next;
    },
    deleteVendor(id) { db.prepare('DELETE FROM vendors WHERE id = ?').run(id); },

    // ---------- подрядчики свадьбы ----------

    insertEventVendor(ev) {
      db.prepare('INSERT INTO event_vendors (id, event_id, source_vendor_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(ev.id, ev.eventId, ev.sourceVendorId ?? null, JSON.stringify(ev), ev.createdAt ?? '', ev.updatedAt ?? '');
    },
    getEventVendor(id) {
      return parseRow(db.prepare('SELECT data FROM event_vendors WHERE id = ?').get(id));
    },
    updateEventVendor(id, patch) {
      const cur = store.getEventVendor(id);
      if (!cur) return null;
      const next = { ...cur, ...patch };
      db.prepare('UPDATE event_vendors SET data = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(next), next.updatedAt ?? cur.updatedAt ?? '', id);
      return next;
    },
    deleteEventVendor(id) { db.prepare('DELETE FROM event_vendors WHERE id = ?').run(id); },
    eventVendorsForEvent(eventId) {
      return db.prepare('SELECT data FROM event_vendors WHERE event_id = ?').all(eventId).map(parseRow);
    },
    findEventVendorBySource(eventId, sourceVendorId) {
      return parseRow(db.prepare('SELECT data FROM event_vendors WHERE event_id = ? AND source_vendor_id = ?').get(eventId, sourceVendorId));
    },

    // ---------- смета ----------

    insertBudget(b) {
      db.prepare('INSERT INTO budgets (event_id, data, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run(b.eventId, JSON.stringify(b), b.createdAt ?? '', b.updatedAt ?? '');
    },
    getBudget(eventId) {
      return parseRow(db.prepare('SELECT data FROM budgets WHERE event_id = ?').get(eventId));
    },
    updateBudget(eventId, patch) {
      const cur = store.getBudget(eventId);
      if (!cur) return null;
      const next = { ...cur, ...patch };
      db.prepare('UPDATE budgets SET data = ?, updated_at = ? WHERE event_id = ?')
        .run(JSON.stringify(next), next.updatedAt ?? cur.updatedAt ?? '', eventId);
      return next;
    },

    insertBudgetLine(l) {
      db.prepare('INSERT INTO budget_lines (id, event_id, source_event_vendor_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(l.id, l.eventId, l.sourceEventVendorId ?? null, JSON.stringify(l), l.createdAt ?? '', l.updatedAt ?? '');
    },
    getBudgetLine(id) {
      return parseRow(db.prepare('SELECT data FROM budget_lines WHERE id = ?').get(id));
    },
    updateBudgetLine(id, patch) {
      const cur = store.getBudgetLine(id);
      if (!cur) return null;
      const next = { ...cur, ...patch };
      db.prepare('UPDATE budget_lines SET data = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(next), next.updatedAt ?? cur.updatedAt ?? '', id);
      return next;
    },
    deleteBudgetLine(id) { db.prepare('DELETE FROM budget_lines WHERE id = ?').run(id); },
    budgetLinesForEvent(eventId) {
      return db.prepare('SELECT data FROM budget_lines WHERE event_id = ?').all(eventId).map(parseRow);
    },
    findBudgetLineByEventVendor(eventId, eventVendorId) {
      return parseRow(db.prepare('SELECT data FROM budget_lines WHERE event_id = ? AND source_event_vendor_id = ?').get(eventId, eventVendorId));
    },

    // ---------- сессии ----------

    insertSession(session) {
      db.prepare('INSERT INTO sessions (id_hash, user_id, created_at, last_seen_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)')
        .run(session.idHash, session.userId, session.createdAt, session.lastSeenAt, session.expiresAt, session.userAgent ?? null);
    },
    getSessionByIdHash(idHash) {
      const row = db.prepare('SELECT id_hash, user_id, created_at, last_seen_at, expires_at, user_agent FROM sessions WHERE id_hash = ?').get(idHash);
      if (!row) return null;
      return {
        idHash: row.id_hash, userId: row.user_id, createdAt: row.created_at,
        lastSeenAt: row.last_seen_at, expiresAt: row.expires_at, userAgent: row.user_agent,
      };
    },
    touchSession(idHash, patch) {
      const cur = store.getSessionByIdHash(idHash);
      if (!cur) return null;
      const next = { ...cur, ...patch };
      db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id_hash = ?')
        .run(next.lastSeenAt, next.expiresAt, idHash);
      return next;
    },
    deleteSession(idHash) { db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(idHash); },
    deleteSessionsForUser(userId, exceptIdHash = null) {
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND id_hash != ?').run(userId, exceptIdHash ?? '');
    },

    // ---------- приглашения ----------

    insertInvite(invite) {
      const { tokenHash, workspaceId, email, kind, expiresAt, usedAt, createdBy, createdAt, ...rest } = invite;
      db.prepare('INSERT INTO invites (token_hash, workspace_id, email, kind, data, expires_at, used_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(tokenHash, workspaceId, email.toLowerCase(), kind, JSON.stringify(rest), expiresAt, usedAt ?? null, createdBy ?? null, createdAt ?? '');
    },
    getInviteByTokenHash(tokenHash) {
      const row = db.prepare('SELECT * FROM invites WHERE token_hash = ?').get(tokenHash);
      return row ? rowToInvite(row) : null;
    },
    markInviteUsed(tokenHash, usedAt) {
      db.prepare('UPDATE invites SET used_at = ? WHERE token_hash = ?').run(usedAt, tokenHash);
      return store.getInviteByTokenHash(tokenHash);
    },
    findActiveInviteByEmail(workspaceId, email) {
      const row = db.prepare(
        "SELECT * FROM invites WHERE workspace_id = ? AND email = ? AND used_at IS NULL AND kind = 'invite'",
      ).get(workspaceId, email.toLowerCase());
      return row ? rowToInvite(row) : null;
    },
    invalidateInvite(tokenHash) { db.prepare('DELETE FROM invites WHERE token_hash = ?').run(tokenHash); },

    // ---------- попытки входа ----------

    insertLoginAttempt(attempt) {
      db.prepare('INSERT INTO login_attempts (key, ip, at) VALUES (?, ?, ?)').run(attempt.key, attempt.ip, attempt.at);
    },
    countLoginAttempts(key, sinceMs) {
      return db.prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE key = ? AND at >= ?').get(key, sinceMs).n;
    },
    countLoginAttemptsByIp(ip, sinceMs) {
      return db.prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND at >= ?').get(ip, sinceMs).n;
    },
    pruneLoginAttempts(beforeMs) {
      db.prepare('DELETE FROM login_attempts WHERE at < ?').run(beforeMs);
    },

    // ---------- эксплуатация ----------

    /** `SELECT 1` для /healthz — база открыта и отвечает. */
    ping() { return db.prepare('SELECT 1 AS ok').get().ok === 1; },
    /** Резервная копия «на лету», без остановки сервиса (docs/specs/08-foundation.md, §5). */
    backupTo(path) { db.prepare('VACUUM INTO ?').run(path); },
    close() { db.close(); },
  };

  return store;
}

function rowToInvite(row) {
  return {
    tokenHash: row.token_hash, workspaceId: row.workspace_id, email: row.email, kind: row.kind,
    expiresAt: row.expires_at, usedAt: row.used_at, createdBy: row.created_by, createdAt: row.created_at,
    ...JSON.parse(row.data),
  };
}
