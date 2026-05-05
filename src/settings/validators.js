/**
 * settings/validators.js — type-driven coercion, validation, and
 * serialization for the settings registry.
 *
 * Each SettingDef has a `type`. The default behavior for that type is
 * declared here; per-def overrides (custom validate/coerce) are layered
 * on top in transport.js.
 */

'use strict';

/** @typedef {'string'|'integer'|'number'|'boolean'|'enum'|'array<string>'|'json'|'secret'} SettingType */

const TYPES = new Set([
  'string', 'integer', 'number', 'boolean', 'enum',
  'array<string>', 'json', 'secret',
]);

function isValidType(t) { return TYPES.has(t); }

/**
 * Coerce a raw value (from JSON body or env) into the canonical
 * in-memory shape. Returns { value, error }.
 */
function coerceValue(def, raw) {
  if (raw === null) return { value: null };       // explicit clear; transport handles DELETE
  if (raw === undefined) return { value: undefined };

  switch (def.type) {
    case 'string':
    case 'enum': {
      const v = String(raw);
      const trimmed = def.coerce ? def.coerce(v) : v;
      const allowed = Array.isArray(def.enum) ? def.enum.map(x => String(x)) : null;
      if (def.type === 'enum' && allowed && !allowed.includes(String(trimmed))) {
        return { error: `must be one of: ${def.enum.join(', ')}` };
      }
      return { value: trimmed };
    }
    case 'secret': {
      // "" is a sentinel for "no change" at the transport layer; here
      // we just return the typed string. transport.js decides whether
      // to skip the write.
      return { value: String(raw) };
    }
    case 'integer': {
      const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
      if (!Number.isFinite(n) || !Number.isInteger(n)) return { error: 'not an integer' };
      return { value: n };
    }
    case 'number': {
      const n = typeof raw === 'number' ? raw : parseFloat(String(raw));
      if (!Number.isFinite(n)) return { error: 'not a number' };
      return { value: n };
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return { value: raw };
      const s = String(raw).toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(s)) return { value: true };
      if (['0', 'false', 'no', 'off', ''].includes(s)) return { value: false };
      return { error: 'not a boolean' };
    }
    case 'array<string>': {
      let arr;
      if (Array.isArray(raw)) arr = raw;
      else if (typeof raw === 'string') {
        const t = raw.trim();
        if (t.startsWith('[')) {
          try { arr = JSON.parse(t); } catch { return { error: 'invalid JSON array' }; }
        } else {
          arr = t.split(',');
        }
      } else {
        return { error: 'expected array or comma-separated string' };
      }
      if (!Array.isArray(arr)) return { error: 'expected array' };
      const out = arr.map(v => String(v).trim()).filter(Boolean);
      return { value: out };
    }
    case 'json': {
      if (typeof raw === 'string') {
        try { return { value: JSON.parse(raw) }; } catch (e) { return { error: `invalid JSON: ${e.message}` }; }
      }
      // Already structured (object/array/scalar) — accept as-is
      return { value: raw };
    }
    default:
      return { error: `unknown type: ${def.type}` };
  }
}

/**
 * Run the def's custom validator (if any) and any built-in
 * range/enum checks. Returns null on success, an error string on
 * failure.
 */
function validateValue(def, value) {
  if (value === null || value === undefined) return null;
  if (def.type === 'enum' && Array.isArray(def.enum) && !def.enum.includes(value)) {
    return `must be one of: ${def.enum.join(', ')}`;
  }
  if (typeof def.validate === 'function') {
    try {
      const result = def.validate(value);
      if (result == null) return null;
      return String(result);
    } catch (e) {
      return `validate threw: ${e.message}`;
    }
  }
  return null;
}

/**
 * Serialize an in-memory value to the TEXT column in settings.db.
 * Inverse of deserializeFromDb.
 */
function serializeForDb(def, value) {
  if (value === null || value === undefined) return null;
  switch (def.type) {
    case 'string':
    case 'enum':
    case 'secret':
      return String(value);
    case 'integer':
    case 'number':
      return String(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'array<string>':
    case 'json':
      return JSON.stringify(value);
    default:
      return JSON.stringify(value);
  }
}

function deserializeFromDb(def, raw) {
  if (raw === null || raw === undefined) return null;
  switch (def.type) {
    case 'string':
    case 'enum':
    case 'secret':
      return String(raw);
    case 'integer':
      return parseInt(raw, 10);
    case 'number':
      return parseFloat(raw);
    case 'boolean':
      return raw === 'true' || raw === '1';
    case 'array<string>':
    case 'json':
      try { return JSON.parse(raw); } catch { return null; }
    default:
      try { return JSON.parse(raw); } catch { return raw; }
  }
}

/**
 * Parse a raw env-var string into the canonical in-memory shape.
 * Same dispatch as coerceValue but always starts from a string.
 */
function deserializeFromEnv(def, raw) {
  if (raw === undefined) return undefined;
  const { value, error } = coerceValue(def, raw);
  if (error) return undefined;
  return value;
}

module.exports = {
  TYPES, isValidType,
  coerceValue, validateValue,
  serializeForDb, deserializeFromDb, deserializeFromEnv,
};
