-- Users: one per person. Password as "pbkdf2$<iterations>$<salt>$<hash>".
CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  roles         TEXT NOT NULL DEFAULT '[]',     -- JSON list of role keys
  brands        TEXT NOT NULL DEFAULT '[]',     -- JSON list; empty = every brand
  is_admin      INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1,
  password      TEXT NOT NULL,
  must_change   INTEGER NOT NULL DEFAULT 1,
  signature     TEXT,                           -- PNG data URL, drawn by the user
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Sessions: only a SHA-256 of the cookie token is kept.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

-- One approval form. `chain` is fixed when the form is submitted.
CREATE TABLE forms (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  number      TEXT NOT NULL UNIQUE,
  owner_id    INTEGER NOT NULL REFERENCES users(id),
  status      TEXT NOT NULL DEFAULT 'draft',   -- draft returned pending approved done
  data        TEXT NOT NULL DEFAULT '{}',
  rule        TEXT,
  chain       TEXT NOT NULL DEFAULT '[]',      -- JSON list of role keys
  step        INTEGER NOT NULL DEFAULT 0,      -- index into chain while pending
  so_number   TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX forms_status ON forms(status);
CREATE INDEX forms_owner ON forms(owner_id);

-- Everything that happened to a form. Approvals keep the signature as
-- it was at that moment, so a later redrawn signature changes nothing.
CREATE TABLE events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  form_id    INTEGER NOT NULL REFERENCES forms(id),
  user_id    INTEGER NOT NULL REFERENCES users(id),
  user_name  TEXT NOT NULL,
  action     TEXT NOT NULL,      -- created submitted approved returned so_entered attached removed
  role       TEXT,
  step       INTEGER,
  remark     TEXT,
  signature  TEXT,
  at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX events_form ON events(form_id);

-- Supporting documents, stored in 1 MB pieces.
CREATE TABLE files (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  form_id     INTEGER NOT NULL REFERENCES forms(id),
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX files_form ON files(form_id);

CREATE TABLE file_chunks (
  file_id INTEGER NOT NULL REFERENCES files(id),
  seq     INTEGER NOT NULL,
  data    BLOB NOT NULL,
  PRIMARY KEY (file_id, seq)
);

-- Settings: the approval rules live here as JSON.
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO settings (key, value) VALUES ('rules', '[]');
