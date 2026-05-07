/**
 * settings/transport.js — the only thing that mutates settings.db.
 *
 * Accepts a JSON-Merge-Patch dialect with explicit tri-state semantics:
 *
 *   { "voice.silenceThresholdMs": 600,    // SET
 *     "voice.ttsVoice": null,             // CLEAR (DELETE the row)
 *     "providers.openai.apiKey": "" }     // for type:'secret', no-op
 *
 * Missing keys mean "leave alone". Tri-state contract documented on
 * each SettingDef via per-type rules in validators.js.
 *
 * Server flow:
 *   1. Walk patch entries; reject unknown keys with 422.
 *   2. coerce + validate each value; bail on any error.
 *   3. BEGIN TRANSACTION on settings.db.
 *   4. Upsert / delete each touched key.
 *   5. COMMIT.
 *   6. store.applyPatch(...) — fires reactive subscribers.
 *   7. Run each touched def's onApply hook.
 *   8. Return { changed, errors } for the API layer.
 */

'use strict';

const registry = require('./registry');
const store = require('./store');
const dbModule = require('./db');
const {
  coerceValue, validateValue,
  serializeForDb, deserializeFromEnv,
} = require('./validators');

/**
 * Compute the value a key should resolve to when its DB row is absent.
 * Mirrors the loader's resolution order: env override > registry default.
 * Returns { value, provenance, envLocked }.
 */
function _resolveAbsentKey(def) {
  const envNames = [def.envVar, ...(def.legacyAlias || [])].filter(Boolean);
  for (const name of envNames) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') continue;
    const parsed = deserializeFromEnv(def, raw);
    if (parsed !== undefined) {
      return { value: parsed, provenance: 'env', envLocked: true };
    }
  }
  return { value: def.default, provenance: 'default', envLocked: false };
}

class PatchError extends Error {
  constructor(errors) {
    super(`settings patch rejected: ${errors.length} error(s)`);
    this.name = 'PatchError';
    this.errors = errors;
    this.statusCode = 422;
  }
}

/**
 * Apply a tri-state patch.
 *
 * @param {object} patch          — flat dotted-key map; see header
 * @param {object} [opts]
 * @param {string} [opts.actor]   — 'wizard' | 'settings-ui' | 'plugin:<id>' | 'cli'
 * @returns {{ changed: string[], errors: Array, snapshot: object }}
 */
function applyPatch(patch, opts = {}) {
  const actor = opts.actor || 'unknown';
  const errors = [];
  const upserts = [];
  const deletes = [];
  const storeChanges = [];     // { key, value }
  const storeRemovals = [];    // key

  if (patch == null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new PatchError([{ key: '$root', error: 'patch must be a JSON object' }]);
  }

  for (const [key, raw] of Object.entries(patch)) {
    const def = registry.get(key);
    if (!def) {
      errors.push({ key, error: 'unknown setting' });
      continue;
    }

    // Explicit clear — null. The DB row goes away, but the in-memory
    // store re-resolves to the appropriate fallback (env override > default).
    if (raw === null) {
      deletes.push(key);
      const resolved = _resolveAbsentKey(def);
      storeChanges.push({
        key,
        value: resolved.value,
        provenance: resolved.provenance,
        envLocked: resolved.envLocked,
      });
      continue;
    }

    // Per-type sentinel: secret + "" = no change
    if (def.type === 'secret' && (raw === '' || raw === undefined)) continue;

    // Other absent values caught at the JSON layer (the key wouldn't be in
    // patch at all). undefined here is treated as no-change for safety.
    if (raw === undefined) continue;

    const { value, error: coerceErr } = coerceValue(def, raw);
    if (coerceErr) {
      errors.push({ key, error: coerceErr });
      continue;
    }

    const validateErr = validateValue(def, value);
    if (validateErr) {
      errors.push({ key, error: validateErr });
      continue;
    }

    upserts.push({ key, value, type: def.type, updatedBy: actor });
    storeChanges.push({ key, value, provenance: 'db' });
  }

  if (errors.length) throw new PatchError(errors);

  // ── DB transaction ─────────────────────────────────────────────────
  const db = dbModule.instance();
  if (!db) throw new Error('[settings/transport] settings.db is not open — call loader.boot() first');

  if (upserts.length || deletes.length) {
    db.applyTx({
      upserts: upserts.map(u => ({
        key: u.key,
        value: serializeForDb(registry.get(u.key), u.value),
        type: u.type,
        updatedBy: u.updatedBy,
      })),
      deletes,
      updatedBy: actor,
    });
  }

  // ── store + reactive subscribers ───────────────────────────────────
  const touched = store.applyPatch(storeChanges, storeRemovals);

  // ── onApply hooks (per-def declarative side effects) ──────────────
  // Run after the store has the new values so hooks can read fresh.
  for (const key of touched) {
    const def = registry.get(key);
    if (!def?.onApply) continue;
    try {
      def.onApply(store.get(key), undefined, { actor });
    } catch (e) {
      // hooks must not break the patch; log via console (transport has no logger ref).
      // eslint-disable-next-line no-console
      console.warn(`[settings/transport] onApply for ${key} threw: ${e.message}`);
    }
  }

  return {
    changed: [...touched],
    errors: [],
    snapshot: store.snapshotFlat(),
  };
}

/**
 * Translate the legacy nested wizard / settings payload shape into a
 * flat dotted patch consumable by applyPatch. Frontend code currently
 * sends:
 *
 *   { displayName, nicknames, enhancedRecall,
 *     providers: { openai: { apiKey, baseUrl }, ... },
 *     models:    { planner: { provider, model } | "string" , ... },
 *     voice:     { enabled, sttProvider, ... },
 *     proactive: { enabled, cooldownMinutes, ... },
 *     webSearch: { searxngUrl, searxngApiKey, braveApiKey },
 *     browser:   { backend },
 *     theme:     'dark',
 *     modelLimits: {...} }
 *
 * Frontend will eventually emit flat keys directly; until then this
 * adapter keeps the wire format compatible.
 *
 *   const patch = transport.flattenWizardPayload(body);
 *   transport.applyPatch(patch, { actor: 'wizard' });
 *
 * Returns a NEW flat patch object; does not mutate the input.
 */
function flattenWizardPayload(body) {
  if (body == null || typeof body !== 'object') return {};
  const out = {};

  // Pass-through scalars (registry keys match wizard keys 1:1).
  for (const k of ['displayName', 'enhancedRecall', 'modelLimits', 'tokenPricing', 'embedder', 'agentEffort', 'agentBornDate', 'publicUrl']) {
    if (Object.prototype.hasOwnProperty.call(body, k)) out[k] = body[k];
  }
  if (Object.prototype.hasOwnProperty.call(body, 'inviteKey')) out.inviteKey = body.inviteKey;
  if (Object.prototype.hasOwnProperty.call(body, 'nicknames')) {
    // Wizard sends an array; registry expects array<string>.
    out.nicknames = body.nicknames;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'theme')) out['appearance.theme'] = body.theme;

  // Providers — flatten {provider: {field: value}} → 'providers.<provider>.<field>'.
  // Wizard `_obReadProvider` always includes scratch fields (models — the
  // populate-models textarea, referer — openrouter-only) that aren't
  // settings on every provider. Drop any flat key the registry doesn't
  // know so validation passes; known keys go through normally.
  if (body.providers && typeof body.providers === 'object') {
    for (const [provider, fields] of Object.entries(body.providers)) {
      if (provider === 'custom' && Array.isArray(fields)) {
        out['providers.custom'] = fields;
        continue;
      }
      if (!fields || typeof fields !== 'object') continue;
      for (const [field, value] of Object.entries(fields)) {
        const key = `providers.${provider}.${field}`;
        if (!registry.get(key)) continue;       // wizard scratch — silently dropped
        out[key] = value;
      }
    }
  }

  // Models — value can be a string or { provider, model }. Compose into
  // the registry's plain-string shape ("model" or "provider/model").
  if (body.models && typeof body.models === 'object') {
    for (const [tier, value] of Object.entries(body.models)) {
      out[`models.${tier}`] = _composeModelRef(value);
    }
  }

  // Voice — straight nested→flat
  if (body.voice && typeof body.voice === 'object') {
    for (const [k, v] of Object.entries(body.voice)) {
      out[`voice.${k}`] = v;
    }
  }

  // Proactive — straight nested→flat
  if (body.proactive && typeof body.proactive === 'object') {
    for (const [k, v] of Object.entries(body.proactive)) {
      out[`proactive.${k}`] = v;
    }
  }

  // Channels — telegram + slack + discord all nest two deep
  if (body.channels && typeof body.channels === 'object') {
    for (const [chan, fields] of Object.entries(body.channels)) {
      if (!fields || typeof fields !== 'object') continue;
      for (const [k, v] of Object.entries(fields)) {
        out[`channels.${chan}.${k}`] = v;
      }
    }
  }

  // Web search
  if (body.webSearch && typeof body.webSearch === 'object') {
    for (const [k, v] of Object.entries(body.webSearch)) {
      out[`webSearch.${k}`] = v;
    }
  }

  // Browser backend (wizard sends { browser: { backend } })
  if (body.browser && typeof body.browser === 'object') {
    if (body.browser.backend !== undefined) out.browserBackend = body.browser.backend;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'browserBackend')) out.browserBackend = body.browserBackend;

  // Top-level loop / budget overrides
  if (Object.prototype.hasOwnProperty.call(body, 'sectionBudgets')) out.sectionBudgets = body.sectionBudgets;
  if (Object.prototype.hasOwnProperty.call(body, 'totalPromptBudget')) out.totalPromptBudget = body.totalPromptBudget;
  if (Object.prototype.hasOwnProperty.call(body, 'casualMessageBudget')) out.casualMessageBudget = body.casualMessageBudget;
  if (Object.prototype.hasOwnProperty.call(body, 'complexMessageBudget')) out.complexMessageBudget = body.complexMessageBudget;
  if (Object.prototype.hasOwnProperty.call(body, 'maxToolResultChars')) out.maxToolResultChars = body.maxToolResultChars;
  if (Object.prototype.hasOwnProperty.call(body, 'compactTokenThreshold')) out.compactTokenThreshold = body.compactTokenThreshold;
  if (body.agent && typeof body.agent === 'object') {
    if (Object.prototype.hasOwnProperty.call(body.agent, 'effort')) out.agentEffort = body.agent.effort;
    const budgets = body.agent.budgets;
    if (budgets && typeof budgets === 'object') {
      for (const k of ['casualMessageBudget', 'complexMessageBudget', 'maxToolResultChars', 'compactTokenThreshold']) {
        if (Object.prototype.hasOwnProperty.call(budgets, k)) out[k] = budgets[k];
      }
    }
  }
  if (body.budgets && typeof body.budgets === 'object') {
    if (Object.prototype.hasOwnProperty.call(body.budgets, 'sections')) out.sectionBudgets = body.budgets.sections;
    if (Object.prototype.hasOwnProperty.call(body.budgets, 'total')) out.totalPromptBudget = body.budgets.total;
  }

  // Plain dotted keys passed through unchanged (allows callers to
  // mix-and-match flat + nested in the same payload).
  for (const [k, v] of Object.entries(body)) {
    if (!k.includes('.')) continue;          // skip top-level (already handled)
    out[k] = v;
  }

  return out;
}

/**
 * Compose the wizard's `{provider, model}` tuple into the registry's
 * plain-string model ref. `'anthropic'` is the implicit default
 * provider (so just `'opus-4-7'` without a slash). Mirrors
 * web.js _composeSettingsModelRef.
 */
function _composeModelRef(value) {
  if (value === null) return null;
  if (value === undefined) return undefined;
  if (typeof value === 'string') {
    const t = value.trim();
    return t || null;
  }
  if (typeof value === 'object') {
    const provider = String(value.provider || 'anthropic').trim().toLowerCase() || 'anthropic';
    const model = String(value.model || value.name || '').trim();
    if (!model) return null;
    return provider === 'anthropic' ? model : `${provider}/${model}`;
  }
  return null;
}

module.exports = { applyPatch, flattenWizardPayload, PatchError };
