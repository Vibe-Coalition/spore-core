-- settings.db initial schema.
-- See src/settings/db.js for the migration runner.

CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY NOT NULL,
  value       TEXT,
  type        TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT
);

CREATE INDEX IF NOT EXISTS idx_settings_prefix ON settings(key);

CREATE TABLE IF NOT EXISTS settings_meta (
  k TEXT PRIMARY KEY NOT NULL,
  v TEXT
);
