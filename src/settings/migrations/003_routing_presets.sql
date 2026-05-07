-- 003_routing_presets.sql — named model-routing preset storage.
--
-- Each row is a named snapshot of the model-routing config
-- (tier assignments + model limits) that the user can save and
-- restore from the Settings UI.

CREATE TABLE IF NOT EXISTS routing_presets (
  name        TEXT PRIMARY KEY NOT NULL,
  config_json TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER
);
