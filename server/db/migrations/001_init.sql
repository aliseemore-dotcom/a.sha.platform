-- Схема пилота (docs/specs/08-foundation.md, §1.5). Каждая сущность: свои столбцы для id, связей
-- и уникальности; остальные поля — в `data` (JSON), чтобы новые поля из ТЗ 07 и далее не требовали
-- отдельной миграции на каждое поле.

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_users_workspace ON users (workspace_id);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_events_workspace ON events (workspace_id);

CREATE TABLE event_members (
  event_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (event_id, user_id)
);
CREATE INDEX idx_event_members_user ON event_members (user_id);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  template_key TEXT,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_tasks_event ON tasks (event_id);
CREATE UNIQUE INDEX idx_tasks_template_key ON tasks (event_id, template_key) WHERE template_key IS NOT NULL;

CREATE TABLE vendors (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_vendors_user ON vendors (user_id);

CREATE TABLE event_vendors (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  source_vendor_id TEXT,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_event_vendors_event ON event_vendors (event_id);
CREATE UNIQUE INDEX idx_event_vendors_source ON event_vendors (event_id, source_vendor_id) WHERE source_vendor_id IS NOT NULL;

CREATE TABLE budgets (
  event_id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE budget_lines (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  source_event_vendor_id TEXT,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_budget_lines_event ON budget_lines (event_id);

CREATE TABLE idempotency (
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  user_agent TEXT
);
CREATE INDEX idx_sessions_user ON sessions (user_id);

CREATE TABLE invites (
  token_hash TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  email TEXT NOT NULL,
  kind TEXT NOT NULL,
  data TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_invites_workspace_email ON invites (workspace_id, email);

CREATE TABLE login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  ip TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX idx_login_attempts_key ON login_attempts (key, at);
CREATE INDEX idx_login_attempts_ip ON login_attempts (ip, at);
