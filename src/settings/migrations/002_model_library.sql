-- Centralized model library. Each entry pairs a provider with a
-- specific model id, plus parameters the agent loop needs (context
-- window, reasoning effort, capabilities). Auto-discovered entries
-- are surfaced as suggestions; only entries the operator explicitly
-- adds land in this table. Tier selectors (casual / normal / planner
-- / recall / image-vlm / etc.) point at rows here by `id`.
--
-- See src/settings/model-library.js for the JS surface.

CREATE TABLE IF NOT EXISTS model_library (
  id                       TEXT PRIMARY KEY NOT NULL,        -- 'anthropic/claude-opus-4-7' (matches the registry's tier-string convention)
  provider                 TEXT NOT NULL,                    -- 'anthropic' | 'openai' | …
  model_id                 TEXT NOT NULL,                    -- 'claude-opus-4-7'
  label                    TEXT,                             -- display name (defaults to model_id when null)
  family                   TEXT,                             -- 'claude' | 'gpt' | 'gemini' | …
  context_window           INTEGER,                          -- max input tokens
  max_output               INTEGER,                          -- max output tokens
  compact_at               INTEGER,                          -- compaction trigger (defaults to ~85% of context_window when null)
  capabilities_json        TEXT,                             -- JSON: { tools, vision, audio, video }
  reasoning_effort_default TEXT,                             -- 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'max'
  reasoning_effort_levels  TEXT,                             -- JSON array of supported levels
  metadata_json            TEXT,                             -- vendor-specific extras
  source                   TEXT NOT NULL DEFAULT 'manual',   -- 'manual' (operator-added) | 'auto' (vendor /models) | 'migration'
  user_overrides_json      TEXT,                             -- JSON: which fields the user explicitly overrode (so 'reset to vendor defaults' knows what to re-pull)
  enabled                  INTEGER NOT NULL DEFAULT 1,
  added_at                 INTEGER NOT NULL,
  refreshed_at             INTEGER
);

CREATE INDEX IF NOT EXISTS idx_model_library_provider ON model_library(provider);
CREATE INDEX IF NOT EXISTS idx_model_library_enabled ON model_library(enabled);
