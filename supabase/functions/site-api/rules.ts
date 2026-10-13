// Backend rules for generated sites: how a project's `_backend` is interpreted and how submitted rows are validated.
// Pure functions, no Deno globals (runs under `node --test`). See docs/STEP4_DESIGN.md §1-2.

export const LIMITS = {
  body: 65_536,        // bytes per request
  row: 16_384,         // bytes per stored row (JSON)
  maxRowsDefault: 10_000,
  maxRowsCap: 100_000,
  collections: 50,
  fields: 50,
  listMax: 100,
  password: { min: 8, max: 128 },
  email: 254,
  metadataBytes: 4_096,
};

export type Access = 'public' | 'user' | 'owner';

export interface Field {
  key: string;
  type: string;
  required: boolean;
  max: number | null;
}

export interface Collection {
  id: string;
  fields: Field[];
  read: Access;
  write: Access;
  maxRows: number;
  notifyOwner: boolean;
}

export interface Backend {
  collections: Map<string, Collection>;
  authEnabled: boolean;
}

export const COLLECTION_RE = /^[a-z0-9_-]{1,40}$/;
const FIELD_KEY_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const normCollection = (v: unknown): string => (typeof v === 'string' ? v.trim().toLowerCase() : '');

/** `transactions` is written only by the Stripe webhook (analytics sums it as revenue); `_*` is reserved for internals. */
export const isReserved = (name: string): boolean => name === 'transactions' || name.startsWith('_');

const asAccess = (v: unknown): Access | null => (v === 'public' || v === 'user' || v === 'owner' ? v : null);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const stripNul = (s: string): string => s.replace(/\u0000/g, '');

/**
 * Turn whatever sits in `_backend` (JSON string, object, or garbage) into usable rules.
 * Defaults keep today's AI-built sites working: anyone may submit; reads are the caller's own rows when accounts are
 * on, otherwise owner-only. Public reads must be asked for explicitly.
 */
export function parseBackend(raw: unknown): Backend {
  let cfg: unknown = raw;
  if (typeof raw === 'string') {
    try { cfg = JSON.parse(raw); } catch { cfg = null; }
  }
  const out: Backend = { collections: new Map(), authEnabled: false };
  if (!isObj(cfg)) return out;

  out.authEnabled = isObj(cfg.auth) && cfg.auth.enabled === true;

  const list = Array.isArray(cfg.collections) ? cfg.collections.slice(0, LIMITS.collections) : [];
  for (const item of list) {
    if (!isObj(item)) continue;
    const id = normCollection(item.id);
    if (!COLLECTION_RE.test(id) || isReserved(id) || out.collections.has(id)) continue;

    const fields: Field[] = [];
    if (Array.isArray(item.fields)) {
      for (const f of item.fields.slice(0, LIMITS.fields)) {
        if (!isObj(f) || typeof f.key !== 'string' || !FIELD_KEY_RE.test(f.key)) continue;
        if (fields.some((x) => x.key === f.key)) continue;
        const max = typeof f.max === 'number' && Number.isInteger(f.max) && f.max >= 1 && f.max <= 16_000 ? f.max : null;
        fields.push({
          key: f.key,
          type: typeof f.type === 'string' ? f.type.toLowerCase() : 'text',
          required: f.required === true,
          max,
        });
      }
    }

    const maxRows = typeof item.max_rows === 'number' && Number.isInteger(item.max_rows) && item.max_rows >= 1
      ? Math.min(item.max_rows, LIMITS.maxRowsCap)
      : LIMITS.maxRowsDefault;

    out.collections.set(id, {
      id,
      fields,
      read: asAccess(item.read) ?? (out.authEnabled ? 'user' : 'owner'),
      write: asAccess(item.write) ?? 'public',
      maxRows,
      notifyOwner: item.notify_owner === true,
    });
  }
  return out;
}

// ── validation ────────────────────────────────────────────────────────────────────────────────────────

export type Validated =
  | { ok: true; data: Record<string, unknown>; ignored: string[] }
  | { ok: false; status: number; error: string };

const bad = (error: string, status = 400): Validated => ({ ok: false, status, error });
const byteLength = (s: string): number => new TextEncoder().encode(s).length;

type FieldResult = { ok: true; value: unknown } | { ok: false; error: string };

function checkField(f: Field, v: unknown): FieldResult {
  const fail = (what: string): FieldResult => ({ ok: false, error: `invalid ${f.key}: ${what}` });
  const str = (limit: number): FieldResult => {
    if (typeof v !== 'string') return fail('expected text');
    const s = stripNul(v);
    if (s.length > (f.max ?? limit)) return fail(`too long (max ${f.max ?? limit})`);
    return { ok: true, value: s };
  };

  switch (f.type) {
    case 'email': {
      if (typeof v !== 'string') return fail('expected an email address');
      const s = stripNul(v).trim();
      if (s.length > LIMITS.email || !EMAIL_RE.test(s)) return fail('not a valid email address');
      return { ok: true, value: s };
    }
    case 'number': case 'range': case 'currency': {
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
      if (!Number.isFinite(n)) return fail('expected a number');
      return { ok: true, value: n };
    }
    case 'boolean': case 'checkbox': case 'toggle': {
      if (typeof v === 'boolean') return { ok: true, value: v };
      if (v === 'true' || v === 'on' || v === '1' || v === 1) return { ok: true, value: true };
      if (v === 'false' || v === 'off' || v === '0' || v === 0) return { ok: true, value: false };
      return fail('expected true/false');
    }
    case 'url': {
      const r = str(2000);
      if (!r.ok) return r;
      try {
        const u = new URL(r.value as string);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return fail('must be an http(s) link');
      } catch { return fail('not a valid link'); }
      return r;
    }
    case 'tel': case 'phone': return str(40);
    case 'date': case 'datetime': case 'datetime-local': case 'time': return str(64);
    case 'textarea': case 'longtext': return str(5000);
    default: {
      // text, select, radio, unknown types: be lenient about primitives and generous with text (AIs declare long
      // messages as plain "text"); the 16 KB row cap is the real bound. A field's own `max` still wins.
      if (typeof v === 'number' && Number.isFinite(v)) return { ok: true, value: v };
      if (typeof v === 'boolean') return { ok: true, value: v };
      return str(5000);
    }
  }
}

/** Free-form JSON for collections that declare no fields: depth- and size-limited, prototype-pollution keys dropped. */
function sanitizeJson(v: unknown, depth: number): unknown {
  if (typeof v === 'string') return stripNul(v);
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean' || v === null) return v;
  if (depth <= 0) return null;
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => sanitizeJson(x, depth - 1));
  if (isObj(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v).slice(0, 100)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype' || k.length > 64) continue;
      out[stripNul(k)] = sanitizeJson(x, depth - 1);
    }
    return out;
  }
  return null;
}

/** Validate a row for a collection. Declared fields are an allowlist: unknown keys are dropped and reported. */
export function validateData(c: Collection, data: unknown): Validated {
  if (!isObj(data)) return bad('data must be an object');
  let raw: string;
  try { raw = JSON.stringify(data); } catch { return bad('data must be JSON'); }
  if (byteLength(raw) > LIMITS.row * 2) return bad('row too large', 413); // cheap pre-check before walking it

  let clean: Record<string, unknown>;
  const ignored: string[] = [];

  if (c.fields.length === 0) {
    clean = sanitizeJson(data, 5) as Record<string, unknown>;
  } else {
    clean = {};
    for (const f of c.fields) {
      const v = (data as Record<string, unknown>)[f.key];
      if (v === undefined || v === null || v === '') {
        if (f.required) return bad(`${f.key} is required`);
        continue;
      }
      const r = checkField(f, v);
      if (!r.ok) return bad(r.error);
      clean[f.key] = r.value;
    }
    const declared = new Set(c.fields.map((f) => f.key));
    for (const k of Object.keys(data)) if (!declared.has(k)) ignored.push(k);
  }

  if (byteLength(JSON.stringify(clean)) > LIMITS.row) return bad('row too large', 413);
  return { ok: true, data: clean, ignored: ignored.slice(0, 20) };
}

// ── site-user input ───────────────────────────────────────────────────────────────────────────────────

export function normEmail(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = stripNul(v).trim().toLowerCase();
  return s.length >= 3 && s.length <= LIMITS.email && EMAIL_RE.test(s) ? s : null;
}

/** Signup metadata: a flat object of primitives, small. Anything else is rejected (null). */
export function cleanMetadata(v: unknown): Record<string, string | number | boolean> | null {
  if (v === undefined || v === null) return {};
  if (!isObj(v)) return null;
  const out: Record<string, string | number | boolean> = {};
  const entries = Object.entries(v);
  if (entries.length > 20) return null;
  for (const [k, x] of entries) {
    if (!FIELD_KEY_RE.test(k) || k === '__proto__') return null;
    if (typeof x === 'string') out[k] = stripNul(x).slice(0, 500);
    else if (typeof x === 'number' && Number.isFinite(x)) out[k] = x;
    else if (typeof x === 'boolean') out[k] = x;
    else return null;
  }
  return byteLength(JSON.stringify(out)) <= LIMITS.metadataBytes ? out : null;
}
