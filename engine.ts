// Generic contract-test engine: schema walking, oracle, runner, report.
// No per-endpoint logic here. Endpoint knowledge lives in registry.ts only.

import * as v from "valibot";
import {
  type Attack,
  type Ctx,
  errorShape,
  successEnvelope,
  expect4xx,
  expectNo5xx,
  expectNoValidationError,
  expectShape,
  checkContentType,
  assertNoLeaks,
  assertHugeNotEchoed,
  parseJson,
  errorKeys,
} from "./assertions";
import { STRING_ATTACKS } from "./attacks/string";
import { NUMBER_ATTACKS } from "./attacks/number";
import { BOOLEAN_ATTACKS } from "./attacks/boolean";
import {
  MASS_ASSIGNMENT_KEYS,
  PROTO_KEYS,
  EXTRA_VALUES,
} from "./attacks/object";
import { RAW_BODY_ATTACKS } from "./attacks/request";
import { QUERY_ATTACKS } from "./attacks/query";
import {
  ROUTE_ATTACKS,
  UNKNOWN_ROUTES,
} from "./attacks/route";
import type { RegistryEntry } from "./registry";

export const BASE: string =
  process.env.BASE_URL ?? "http://localhost:8000";

const SEED_ENV = Number(process.env.SEED ?? "20260929");
export const SEED: number = Number.isInteger(SEED_ENV) ? SEED_ENV : 20260929;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const rng: () => number = mulberry32(SEED);

// ── Valibot structure walking (duck-typed v1 internals) ──

type Node = {
  kind: string;
  entries?: Record<string, unknown>;
  options?: unknown[];
  wrapped?: unknown;
  item?: unknown;
  pipe?: Array<{ type?: string; requirement?: unknown }>;
};

function nodeOf(s: unknown): Node {
  const o = s as Record<string, unknown>;
  return {
    kind: typeof o?.type === "string" ? (o.type as string) : "unknown",
    entries: o?.entries as Record<string, unknown> | undefined,
    options: o?.options as unknown[] | undefined,
    wrapped: (o?.wrapped ?? o?.nested ?? o?.schema) as unknown,
    item: o?.item as unknown,
    pipe: o?.pipe as Array<{ type?: string; requirement?: unknown }> | undefined,
  };
}

const OMITTABLE = new Set([
  "optional",
  "nullish",
  "undefinedable",
  "optional_with_default",
]);

function unwrap(s: unknown): { base: unknown; omittable: boolean } {
  let cur = s;
  let omittable = false;
  for (;;) {
    const n = nodeOf(cur);
    if (n.kind === "optional" || n.kind === "nullish" || n.kind === "undefinedable") {
      omittable = true;
      if (n.wrapped === undefined || n.wrapped === null) break;
      cur = n.wrapped;
      continue;
    }
    if (n.kind === "nullable" || n.kind === "non_optional" || n.kind === "non_nullable" || n.kind === "non_nullish") {
      if (n.wrapped === undefined || n.wrapped === null) break;
      cur = n.wrapped;
      continue;
    }
    break;
  }
  return { base: cur, omittable };
}

function baseKinds(s: unknown): string[] {
  const { base } = unwrap(s);
  const n = nodeOf(base);
  if (n.kind === "union" && Array.isArray(n.options)) {
    const kinds = new Set<string>();
    for (const o of n.options) kinds.add(nodeOf(unwrap(o).base).kind);
    return [...kinds];
  }
  return [n.kind];
}

type Bound =
  | { kind: "len"; req: number }
  | { kind: "val"; req: number };

function collectBounds(s: unknown, out: Bound[] = []): Bound[] {
  const { base } = unwrap(s);
  const n = nodeOf(base);
  if (n.kind === "union" && Array.isArray(n.options)) {
    for (const o of n.options) collectBounds(o, out);
    return out;
  }
  if (Array.isArray(n.pipe)) {
    for (const a of n.pipe) {
      if (
        (a.type === "min_length" || a.type === "max_length") &&
        typeof a.requirement === "number"
      ) {
        out.push({ kind: "len", req: a.requirement });
      }
      if (
        (a.type === "min_value" || a.type === "max_value") &&
        typeof a.requirement === "number"
      ) {
        out.push({ kind: "val", req: a.requirement });
      }
    }
  }
  return out;
}

const CROSS_TYPE: Attack[] = [
  { label: "x-null", value: null, tags: ["type"] },
  { label: "x-true", value: true, tags: ["type"] },
  { label: "x-number", value: 123, tags: ["type"] },
  { label: "x-string", value: "x", tags: ["type"] },
  { label: "x-array", value: [], tags: ["type"] },
  { label: "x-object", value: {}, tags: ["type"] },
];

function catalogFor(kinds: string[]): Attack[] {
  const out: Attack[] = [...CROSS_TYPE];
  if (kinds.includes("string")) out.push(...STRING_ATTACKS);
  if (kinds.includes("number") || kinds.includes("integer")) out.push(...NUMBER_ATTACKS);
  if (kinds.includes("boolean")) out.push(...BOOLEAN_ATTACKS);
  return out;
}

function boundaryAttacks(fieldSchema: unknown, kinds: string[]): Attack[] {
  const out: Attack[] = [];
  const seen = new Set<string>();
  const add = (a: Attack) => {
    if (!seen.has(a.label)) {
      seen.add(a.label);
      out.push(a);
    }
  };
  for (const b of collectBounds(fieldSchema)) {
    if (b.kind === "len" && kinds.includes("string")) {
      for (const n of [b.req - 1, b.req, b.req + 1]) {
        if (n < 0 || n > 10000) continue;
        add({ label: `len-${n}`, value: "y".repeat(n), tags: ["boundary"] });
      }
    }
    if (b.kind === "val" && (kinds.includes("number") || kinds.includes("integer"))) {
      for (const n of [b.req - 1, b.req, b.req + 1]) {
        add({ label: `val-${n}`, value: n, tags: ["boundary"] });
      }
    }
  }
  return out;
}

// ── HTTP plumbing ──

export type Outcome = {
  endpoint: string;
  method: string;
  path: string;
  field: string;
  attack: string;
  sentBody?: string;
  expected: string;
  status: number | null;
  bodyText: string;
  pass: boolean;
  error: string | null;
};

export const outcomes: Outcome[] = [];
export const errorKeySets = new Map<string, number>();

function record(o: Outcome): void {
  outcomes.push(o);
}

function fail(o: Omit<Outcome, "pass" | "error">, message: string): never {
  const full = { ...o, pass: false, error: message };
  record(full);
  throw new Error(message);
}

function ok(o: Omit<Outcome, "pass" | "error" | "status" | "bodyText">, status: number, bodyText: string): void {
  record({ ...o, pass: true, error: null, status, bodyText: bodyText.slice(0, 500) });
}

export type Resp = {
  status: number;
  headers: Headers;
  text: string;
  json: unknown;
};

export async function send(
  method: string,
  path: string,
  body?: unknown,
  raw?: string,
  contentType?: string,
): Promise<Resp> {
  const hasBody = body !== undefined || raw !== undefined;
  const headers: Record<string, string> = {};
  if (contentType !== undefined) headers["Content-Type"] = contentType;
  else if (hasBody) headers["Content-Type"] = "application/json";
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, text, json };
}

function trackId(entry: RegistryEntry, r: Resp): void {
  const id = (r.json as { data?: { id?: unknown } } | null)?.data?.id;
  if (r.status >= 200 && r.status < 300 && typeof id === "number") {
    entry.tracked.push(id);
  }
}

// Shared post-response checks for any 4xx error response.
function checkErrorResponse(
  base: Omit<Outcome, "pass" | "error" | "status" | "bodyText">,
  r: Resp,
  attackLen?: number,
): void {
  const ctx: Ctx = {
    endpoint: base.endpoint,
    method: base.method,
    path: base.path,
    field: base.field,
    attack: base.attack,
    sentBody: base.sentBody,
  };
  checkContentType(ctx, r.headers, r.text);
  const json = parseJson(ctx, r.text);
  assertNoLeaks(ctx, r.text);
  expectShape(ctx, errorShape, json, r.text);
  const keys = errorKeys(json);
  errorKeySets.set(keys, (errorKeySets.get(keys) ?? 0) + 1);
  if (attackLen !== undefined) assertHugeNotEchoed(ctx, r.text, attackLen);
}

// Shared post-response checks for any 2xx success response.
function checkSuccessResponse(
  base: Omit<Outcome, "pass" | "error" | "status" | "bodyText">,
  entry: RegistryEntry,
  r: Resp,
): void {
  const ctx: Ctx = {
    endpoint: base.endpoint,
    method: base.method,
    path: base.path,
    field: base.field,
    attack: base.attack,
    sentBody: base.sentBody,
  };
  checkContentType(ctx, r.headers, r.text);
  const json = parseJson(ctx, r.text);
  expectShape(ctx, successEnvelope(entry.responseData), json, r.text);
}

// ── Fixtures ──

// Valid request base for attack cases. PATCH entries (needsFixture) must
// satisfy the UPDATE schema (id + patch fields), not the create shape, so a
// dedicated patch factory wins when present. Entries without it behave
// exactly as before.
export function validBaseOf(
  entry: RegistryEntry,
  tag: string,
): Record<string, unknown> {
  if (!entry.makeValidBody) throw new Error(`no body factory for ${entry.key}`);
  return entry.needsFixture && entry.makeValidPatchBody
    ? entry.makeValidPatchBody(tag)
    : entry.makeValidBody(tag, entry);
}

export async function preflight(): Promise<void> {
  console.log(`contract-test seed=${SEED} base=${BASE}`);
  let r: Resp;
  try {
    r = await send("GET", "/labels");
  } catch (e) {
    throw new Error(`server unreachable at ${BASE}: ${String(e)}. Start the backend first.`);
  }
  if (r.status >= 500) throw new Error(`server unhealthy: GET /labels -> ${r.status}`);
}

export async function setupEntry(entry: RegistryEntry): Promise<void> {
  if (!entry.makeValidBody) return;
  const body = entry.makeValidBody("fixture", entry);
  const r = await send("POST", entry.path, body);
  if (r.status < 200 || r.status >= 300) {
    throw new Error(`setup failed for ${entry.key}: POST ${entry.path} -> ${r.status} ${r.text.slice(0, 200)}`);
  }
  trackId(
    entry,
    r as Resp,
  );
  const id = (r.json as { data?: { id?: unknown } } | null)?.data?.id;
  if (typeof id !== "number") throw new Error(`setup failed for ${entry.key}: no numeric data.id`);
  entry.fixtureId = id;
}

export async function cleanupEntry(entry: RegistryEntry): Promise<{ attempted: number; gone: number }> {
  let attempted = 0;
  let gone = 0;
  for (const id of [...new Set(entry.tracked)]) {
    attempted++;
    try {
      const r = await send("DELETE", `${entry.path}?id=${id}`);
      if (r.status === 404) gone++;
      else if (r.status >= 200 && r.status < 300) gone++;
    } catch {
      // best effort; leftovers are reported, not thrown
    }
  }
  return { attempted, gone };
}

// ── Case planning ──

export type PlannedCase = {
  name: string;
  meta: { endpoint: string; method: string; path: string; field: string; attack: string };
  run: () => Promise<void>;
};

function hugeLen(a: Attack): number | undefined {
  return a.tags.includes("huge") && typeof a.value === "string" && a.value.length >= 1000
    ? a.value.length
    : undefined;
}

function bodyCases(entry: RegistryEntry, schema: v.GenericSchema): PlannedCase[] {
  const cases: PlannedCase[] = [];
  if (!entry.makeValidBody) return cases;
  const entries = nodeOf(schema).entries ?? {};
  for (const [field, fschema] of Object.entries(entries)) {
    const kinds = baseKinds(fschema);
    const attacks = [...catalogFor(kinds), ...boundaryAttacks(fschema, kinds)];
    const seen = new Set<string>();
    for (const a of attacks) {
      if (seen.has(a.label)) continue;
      seen.add(a.label);
      const meta = { endpoint: entry.key, method: entry.method, path: entry.path, field, attack: a.label };
      cases.push({
        name: `[${entry.key} body.${field}] ${a.label}`,
        meta,
        run: async () => {
          const valid = validBaseOf(entry, "case");
          if (entry.needsFixture && entry.fixtureId !== undefined && field === "id") {
            valid["id"] = entry.fixtureId;
          } else if (entry.needsFixture && entry.fixtureId !== undefined && valid["id"] === undefined) {
            valid["id"] = entry.fixtureId;
          }
          const payload: Record<string, unknown> = { ...valid, [field]: a.value };
          const sent = JSON.stringify(payload);
          const base = {
            endpoint: entry.key,
            method: entry.method,
            path: entry.path,
            field,
            attack: a.label,
            sentBody: sent,
            expected: "",
          };
          const parsed = v.safeParse(schema, payload);
          const r = await send(entry.method, entry.path, payload);
          if (!parsed.success) {
            base.expected = "4xx (schema rejects)";
            try {
              expect4xx({ ...base }, r.status, r.text);
              checkErrorResponse(base, r, hugeLen(a));
            } catch (e) {
              fail({ ...base, status: r.status, bodyText: r.text.slice(0, 500) }, String((e as Error).message));
            }
          } else {
            base.expected = "no VALIDATION, no 5xx";
            try {
              expectNo5xx({ ...base }, r.status, r.text);
              expectNoValidationError({ ...base }, r.status, r.json, r.text);
              if (r.status >= 200 && r.status < 300) {
                trackId(entry, r);
                checkSuccessResponse(base, entry, r);
              } else {
                checkErrorResponse(base, r);
              }
            } catch (e) {
              fail({ ...base, status: r.status, bodyText: r.text.slice(0, 500) }, String((e as Error).message));
            }
          }
          ok(base, r.status, r.text);
        },
      });
    }
    // missing-key case for every field; oracle decides via safeParse
    const missingMeta = { endpoint: entry.key, method: entry.method, path: entry.path, field, attack: "MISSING-KEY" };
    cases.push({
      name: `[${entry.key} body.${field}] MISSING-KEY`,
      meta: missingMeta,
      run: async () => {
        const valid = validBaseOf(entry, "case");
        if (entry.needsFixture && entry.fixtureId !== undefined && valid["id"] === undefined) {
          valid["id"] = entry.fixtureId;
        }
        const payload = { ...valid };
        delete payload[field];
        const sent = JSON.stringify(payload);
        const base = {
          endpoint: entry.key,
          method: entry.method,
          path: entry.path,
          field,
          attack: "MISSING-KEY",
          sentBody: sent,
          expected: "",
        };
        const parsed = v.safeParse(schema, payload);
        const r = await send(entry.method, entry.path, payload);
        if (!parsed.success) {
          base.expected = "4xx (schema rejects)";
          try {
            expect4xx({ ...base }, r.status, r.text);
            checkErrorResponse(base, r);
          } catch (e) {
            fail({ ...base, status: r.status, bodyText: r.text.slice(0, 500) }, String((e as Error).message));
          }
        } else {
          base.expected = "no VALIDATION, no 5xx";
          try {
            expectNo5xx({ ...base }, r.status, r.text);
            expectNoValidationError({ ...base }, r.status, r.json, r.text);
            if (r.status >= 200 && r.status < 300) {
              trackId(entry, r);
              checkSuccessResponse(base, entry, r);
            } else {
              checkErrorResponse(base, r);
            }
          } catch (e) {
            fail({ ...base, status: r.status, bodyText: r.text.slice(0, 500) }, String((e as Error).message));
          }
        }
        ok(base, r.status, r.text);
      },
    });
  }
  return cases;
}

function objectLevelCases(entry: RegistryEntry, schema: v.GenericSchema): PlannedCase[] {
  const cases: PlannedCase[] = [];
  if (!entry.makeValidBody) return cases;
  const applyExtra = (valid: Record<string, unknown>, key: string, value: unknown) => {
    const payload = { ...valid };
    if (key === "__proto__") {
      Object.defineProperty(payload, "__proto__", { value, enumerable: true, configurable: true, writable: true });
    } else {
      (payload as Record<string, unknown>)[key] = value;
    }
    return payload;
  };
  const variants: Array<{ label: string; build: (valid: Record<string, unknown>) => Record<string, unknown> }> = [];
  for (const k of MASS_ASSIGNMENT_KEYS) {
    for (const val of EXTRA_VALUES) {
      variants.push({ label: `extra-${k}=${JSON.stringify(val)}`, build: (valid) => applyExtra(valid, k, val) });
    }
  }
  for (const k of PROTO_KEYS) {
    variants.push({ label: `proto-${k}`, build: (valid) => applyExtra(valid, k, { polluted: true }) });
  }
  for (const variant of variants) {
    const objMeta = { endpoint: entry.key, method: entry.method, path: entry.path, field: "(object)", attack: variant.label };
    cases.push({
      name: `[${entry.key} body] ${variant.label}`,
      meta: objMeta,
      run: async () => {
        const valid = validBaseOf(entry, "case");
        if (entry.needsFixture && entry.fixtureId !== undefined && valid["id"] === undefined) {
          valid["id"] = entry.fixtureId;
        }
        const payload = variant.build(valid);
        const sent = JSON.stringify(payload);
        const base = {
          endpoint: entry.key,
          method: entry.method,
          path: entry.path,
          field: "(object)",
          attack: variant.label,
          sentBody: sent,
          expected: "",
        };
        const parsed = v.safeParse(schema, payload);
        const r = await send(entry.method, entry.path, payload);
        if (!parsed.success) {
          base.expected = "4xx (schema rejects)";
          try {
            expect4xx({ ...base }, r.status, r.text);
            checkErrorResponse(base, r);
          } catch (e) {
            fail({ ...base, status: r.status, bodyText: r.text.slice(0, 500) }, String((e as Error).message));
          }
        } else {
          base.expected = "no VALIDATION, no 5xx (unknown keys are stripped)";
          try {
            expectNo5xx({ ...base }, r.status, r.text);
            expectNoValidationError({ ...base }, r.status, r.json, r.text);
            if (r.status >= 200 && r.status < 300) {
              trackId(entry, r);
              checkSuccessResponse(base, entry, r);
            } else {
              checkErrorResponse(base, r);
            }
          } catch (e) {
            fail({ ...base, status: r.status, bodyText: r.text.slice(0, 500) }, String((e as Error).message));
          }
        }
        ok(base, r.status, r.text);
      },
    });
  }
  return cases;
}

function rawBodyCases(entry: RegistryEntry): PlannedCase[] {
  // Malformed requests: 4xx by HTTP semantics (unparseable / wrong-shape body).
  // Content-type-ambiguous ones (server parses urlencoded/form/charset variants
  // and missing-CT JSON by framework behavior): weakest invariant, no 5xx +
  // shape routing. Never trust a strictness the contract does not state.
  const MALFORMED = new Set([
    "broken-json",
    "truncated-json",
    "empty-body-with-ct",
    "no-body-no-ct",
    "top-level-array",
    "top-level-string",
    "top-level-number",
    "top-level-null",
    "top-level-true",
  ]);
  return RAW_BODY_ATTACKS.map((a) => ({
    name: `[${entry.key} body] raw:${a.label}`,
    meta: { endpoint: entry.key, method: entry.method, path: entry.path, field: "(raw-body)", attack: a.label },
    run: async () => {
      const base = {
        endpoint: entry.key,
        method: entry.method,
        path: entry.path,
        field: "(raw-body)",
        attack: a.label,
        sentBody: a.raw,
        expected: "",
      };
      const r = await send(entry.method, entry.path, undefined, a.raw, a.contentType);
      if (MALFORMED.has(a.label)) {
        base.expected = "4xx (malformed request)";
        try {
          expect4xx({ ...base }, r.status, r.text);
          checkErrorResponse(base, r);
        } catch (e) {
          fail({ ...base, status: r.status, bodyText: r.text.slice(0, 500) }, String((e as Error).message));
        }
      } else {
        // duplicate-keys, missing-ct, text-plain, urlencoded, charsets:
        // server may parse into a valid payload -> weakest invariant.
        base.expected = "no 5xx (parsing behavior ambiguous)";
        try {
          expectNo5xx({ ...base }, r.status, r.text);
          if (r.status >= 200 && r.status < 300) {
            trackId(entry, r);
            checkSuccessResponse(base, entry, r);
          } else if (r.status >= 400 && r.status < 500) {
            checkErrorResponse(base, r);
          } else {
            fail({ ...base, status: r.status, bodyText: r.text.slice(0, 500) }, `unexpected status ${r.status}`);
          }
        } catch (e) {
          fail({ ...base, status: r.status, bodyText: r.text.slice(0, 500) }, String((e as Error).message));
        }
      }
      ok(base, r.status, r.text);
    },
  }));
}

async function freshFixtureId(entry: RegistryEntry, tag: string): Promise<number> {
  if (!entry.makeValidBody) throw new Error(`no body factory for ${entry.key}`);
  const body = entry.makeValidBody(tag, entry);
  const r = await send("POST", entry.path, body);
  if (r.status < 200 || r.status >= 300) {
    throw new Error(`fixture POST ${entry.path} -> ${r.status} ${r.text.slice(0, 200)}`);
  }
  trackId(entry, r);
  const id = (r.json as { data?: { id?: unknown } } | null)?.data?.id;
  if (typeof id !== "number") throw new Error(`fixture for ${entry.key}: no numeric data.id`);
  return id;
}

// Collision-proof missing id: int4-safe, far above any serial range.
const MISSING_ID = 900000001;

// Query attacks that can resolve to a live row MUST use an owned (fresh)
// fixture row — never an arbitrary id. Pre-existing rows are untouchable.
const RESOLVING_QUERY = new Set([
  "repeated-key",
  "repeated-key-diff",
  "percent-encoded",
  "plus-as-space",
]);

// Single string values that can never resolve to a row (safeParse rejects).
const SAFE_QUERY_STRINGS = [
  "abc",
  "",
  " ",
  "1.5",
  "-1.5",
  "true",
  "null",
  "undefined",
  "NaN",
  "[object Object]",
  "0xZZZ",
  "1;DROP",
  "тест",
];

function queryCases(entry: RegistryEntry, schema: v.GenericSchema): PlannedCase[] {
  const cases: PlannedCase[] = [];
  const qentries = nodeOf(schema).entries ?? {};
  const keys = Object.keys(qentries);
  if (keys.length === 0) return cases;
  const enc = encodeURIComponent;

  const routeQueryOutcome = async (
    meta: { endpoint: string; method: string; path: string; field: string; attack: string },
    search: string,
    mode: "strict4xx" | "weak" | "exact404" | "expect2xx",
  ): Promise<void> => {
    const base = { ...meta, path: `${entry.path}?${search}`, sentBody: undefined as string | undefined, expected: "" };
    const r = await send(entry.method, `${entry.path}?${search}`);
    try {
      if (mode === "strict4xx") {
        base.expected = "4xx (never resolves)";
        expect4xx({ ...base }, r.status, r.text);
        checkErrorResponse(base, r);
      } else if (mode === "exact404") {
        base.expected = "404 (missing row)";
        if (r.status !== 404) throw new Error(`expected 404, got ${r.status}`);
        checkErrorResponse(base, r);
      } else if (mode === "expect2xx") {
        base.expected = "2xx (owned row exists)";
        if (r.status < 200 || r.status >= 300) throw new Error(`expected 2xx, got ${r.status}`);
        trackId(entry, r);
        checkSuccessResponse(base, entry, r);
      } else {
        base.expected = "no 5xx (resolves or rejects, both routed)";
        expectNo5xx({ ...base }, r.status, r.text);
        if (r.status >= 200 && r.status < 300) {
          trackId(entry, r);
          checkSuccessResponse(base, entry, r);
        } else if (r.status >= 400 && r.status < 500) {
          checkErrorResponse(base, r);
        } else {
          throw new Error(`unexpected status ${r.status}`);
        }
      }
    } catch (e) {
      fail({ ...base, status: r.status, bodyText: r.text.slice(0, 500) }, String((e as Error).message));
    }
    ok(base, r.status, r.text);
  };

  // 1. Values that can never resolve -> strict 4xx (oracle via safeParse guard).
  // Runs for EVERY query key: rejecting an invalid filter is in-contract for
  // each of them. Resolving/form cases (§2-3) run for the primary key only;
  // resolving filters on secondary keys are covered by semantic round-trips.
  for (const key of keys) {
  for (const s of SAFE_QUERY_STRINGS) {
    const parsed = v.safeParse(schema, { [key]: s });
    if (parsed.success) continue; // safety: never assert 4xx on schema-valid input
    const label = `safe:${JSON.stringify(s)}`;
    const meta = { endpoint: entry.key, method: entry.method, path: entry.path, field: key, attack: label };
    cases.push({
      name: `[${entry.key} query.${key}] ${label}`,
      meta,
      run: () => routeQueryOutcome(meta, `${key}=${enc(s)}`, "strict4xx"),
    });
  }

  // 2. Fixture-derived parsing variants, each with its OWN fresh row.
  // Primary key only (a fresh row id is meaningful only for the id filter).
  if (key === keys[0]) {
  const FORM_LABELS = ["plain", "leading-zero", "padded-spaces", "hex", "trailing-dot-zero", "plus-sign"] as const;
  for (const label of FORM_LABELS) {
    const meta = { endpoint: entry.key, method: entry.method, path: entry.path, field: key, attack: `form:${label}` };
    cases.push({
      name: `[${entry.key} query.${key}] form:${label}`,
      meta,
      run: async () => {
        const f = await freshFixtureId(entry, `qform-${label}`);
        const value = {
          plain: String(f),
          "leading-zero": `0${f}`,
          "padded-spaces": ` ${f} `,
          hex: `0x${f.toString(16)}`,
          "trailing-dot-zero": `${f}.0`,
          "plus-sign": `+${f}`,
        }[label];
        await routeQueryOutcome(meta, `${key}=${enc(value)}`, "expect2xx");
      },
    });
  }

  // 3. Exotic syntax: resolving ones get a fresh owned row + weakest routing;
  //    non-resolving ones use a guaranteed-missing base and expect strict 4xx
  //    (row mode) or weakest routing (filter mode, T13). The base is MISSING_ID,
  //    never a small literal: a previous run deleted pre-existing row id 7
  //    because double-encoding resolves server-side (T11, REPORT incident 2).
  for (const q of QUERY_ATTACKS) {
    const meta = { endpoint: entry.key, method: entry.method, path: entry.path, field: key, attack: `syntax:${q.label}` };
    cases.push({
      name: `[${entry.key} query.${key}] syntax:${q.label}`,
      meta,
      run: async () => {
        if (RESOLVING_QUERY.has(q.label)) {
          const f = await freshFixtureId(entry, `qsyn-${q.label}`);
          await routeQueryOutcome(meta, q.apply(key, String(f)), "weak");
        } else {
          await routeQueryOutcome(
            meta,
            q.apply(key, String(MISSING_ID)),
            entry.queryMode === "filter" ? "weak" : "strict4xx",
          );
        }
      },
    });
  }

  // 4. Guaranteed-missing id.
  // Row mode (DELETE by id): exact 404 (HTTP semantics + app taxonomy).
  // Filter mode (GET list): the id is schema-valid, so the oracle forbids
  // expecting 4xx — a filter returns 2xx with a list (T13). The strict
  // "GET detail must 404" reading of issue #6 stays covered by the semantic
  // suite (REPORT F3), which asserts the contract instead of the oracle.
  } // end if (primary key)
  } // end per-key loop
  {
    const key = keys[0];
    const meta = { endpoint: entry.key, method: entry.method, path: entry.path, field: key, attack: "missing-id" };
    if (entry.queryMode === "filter") {
      cases.push({
        name: `[${entry.key} query.${key}] missing-id`,
        meta,
        run: async () => {
          const base = { ...meta, path: `${entry.path}?${key}=${MISSING_ID}`, sentBody: undefined as string | undefined, expected: "2xx list (filter finds nothing)" };
          const r = await send(entry.method, `${entry.path}?${key}=${MISSING_ID}`);
          try {
            if (r.status < 200 || r.status >= 300) {
              throw new Error(`expected 2xx, got ${r.status}`);
            }
            checkSuccessResponse(base, { ...entry, responseData: entry.listData }, r);
          } catch (e) {
            fail({ ...base, status: r.status, bodyText: r.text.slice(0, 500) }, String((e as Error).message));
          }
          ok(base, r.status, r.text);
        },
      });
    } else {
      cases.push({
        name: `[${entry.key} query.${key}] missing-id`,
        meta,
        run: () => routeQueryOutcome(meta, `${key}=${MISSING_ID}`, "exact404"),
      });
    }
  }
  return cases;
}

function stateCases(entry: RegistryEntry): PlannedCase[] {
  if (!entry.makeValidBody) return [];
  const mk = async (tag: string): Promise<number> => {
    const body = entry.makeValidBody!(tag, entry);
    const r = await send("POST", entry.path, body);
    if (r.status < 200 || r.status >= 300) {
      throw new Error(`state setup failed: POST ${entry.path} -> ${r.status}`);
    }
    trackId(entry, r);
    const id = (r.json as { data?: { id?: unknown } } | null)?.data?.id;
    if (typeof id !== "number") throw new Error("state setup: no numeric data.id");
    return id;
  };
  const del = (id: number) => send("DELETE", `${entry.path}?id=${id}`);
  return [
    {
      name: `[${entry.key} state] double-delete -> second 4xx`,
      meta: { endpoint: entry.key, method: entry.method, path: entry.path, field: "(auto)", attack: "(auto)" },
      run: async () => {
        const id = await mk("dbl-del");
        const base = {
          endpoint: entry.key, method: "DELETE", path: `${entry.path}?id=${id}`,
          field: "(state)", attack: "double-delete", sentBody: undefined, expected: "second DELETE 4xx",
        };
        const first = await send("DELETE", `${entry.path}?id=${id}`);
        if (first.status < 200 || first.status >= 300) {
          fail({ ...base, status: first.status, bodyText: first.text.slice(0, 500) }, `first DELETE -> ${first.status}, expected 2xx`);
        }
        const second = await send("DELETE", `${entry.path}?id=${id}`);
        try {
          expect4xx({ ...base }, second.status, second.text);
          checkErrorResponse(base, second);
        } catch (e) {
          fail({ ...base, status: second.status, bodyText: second.text.slice(0, 500) }, String((e as Error).message));
        }
        ok(base, second.status, second.text);
      },
    },
    {
      name: `[${entry.key} state] patch-after-delete -> 4xx`,
      meta: { endpoint: entry.key, method: entry.method, path: entry.path, field: "(auto)", attack: "(auto)" },
      run: async () => {
        const id = await mk("patch-del");
        const base = {
          endpoint: entry.key, method: "PATCH", path: entry.path,
          field: "(state)", attack: "patch-after-delete", sentBody: undefined, expected: "PATCH 4xx",
        };
        await send("DELETE", `${entry.path}?id=${id}`);
        // PATCH-after-delete must send a schema-shaped update body. Entries
        // with a patch factory use it; others keep the legacy {name} body.
        const body: Record<string, unknown> = entry.makeValidPatchBody
          ? entry.makeValidPatchBody("ghost")
          : { name: "contract-ghost" };
        body["id"] = id;
        const r = await send("PATCH", entry.path, body);
        try {
          expect4xx({ ...base }, r.status, r.text);
          checkErrorResponse({ ...base, sentBody: JSON.stringify(body) }, r);
        } catch (e) {
          fail({ ...base, status: r.status, bodyText: r.text.slice(0, 500) }, String((e as Error).message));
        }
        ok(base, r.status, r.text);
      },
    },
    {
      name: `[${entry.key} state] get-excludes-deleted`,
      meta: { endpoint: entry.key, method: entry.method, path: entry.path, field: "(auto)", attack: "(auto)" },
      run: async () => {
        const id = await mk("get-del");
        const base = {
          endpoint: entry.key, method: "GET", path: entry.path,
          field: "(state)", attack: "get-excludes-deleted", sentBody: undefined, expected: "deleted id absent",
        };
        await send("DELETE", `${entry.path}?id=${id}`);
        const r = await send("GET", entry.path);
        try {
          if (r.status < 200 || r.status >= 300) {
            throw new Error(`GET -> ${r.status}, expected 2xx`);
          }
          // GET returns a LIST: validate against the list schema, not the
          // single-entity responseData of this entry (previous version did
          // that and failed spuriously; the check itself was wrong, not the app).
          checkSuccessResponse({ ...base, }, { ...entry, responseData: entry.listData ?? entry.responseData }, r);
          const items = (r.json as { data?: unknown })?.data;
          if (Array.isArray(items) && items.some((x) => (x as { id?: unknown })?.id === id)) {
            throw new Error(`deleted id ${id} still listed`);
          }
        } catch (e) {
          fail({ ...base, status: r.status, bodyText: r.text.slice(0, 500) }, String((e as Error).message));
        }
        ok(base, r.status, r.text);
      },
    },
  ];
}

function validCases(entry: RegistryEntry): PlannedCase[] {
  const cases: PlannedCase[] = [];
  if (entry.method === "GET") {
    cases.push({
      name: `[${entry.key}] valid GET -> 2xx envelope`,
      meta: { endpoint: entry.key, method: entry.method, path: entry.path, field: "(auto)", attack: "(auto)" },
      run: async () => {
        const base = {
          endpoint: entry.key, method: "GET", path: entry.path,
          field: "(valid)", attack: "valid-list", sentBody: undefined, expected: "2xx envelope",
        };
        const r = await send("GET", entry.path);
        try {
          if (r.status < 200 || r.status >= 300) throw new Error(`GET -> ${r.status}`);
          checkSuccessResponse(base, entry, r);
        } catch (e) {
          fail({ ...base, status: r.status, bodyText: r.text.slice(0, 500) }, String((e as Error).message));
        }
        ok(base, r.status, r.text);
      },
    });
    return cases;
  }
  // A "valid create with body" case only makes sense where the route takes a
  // body. DELETE takes none (query only); sending one is out-of-contract
  // usage, so no such case is generated (valid deletes are covered by the
  // query-form cases with fresh owned rows).
  if (entry.makeValidBody && !entry.needsFixture && entry.method !== "DELETE") {
    cases.push({
      name: `[${entry.key}] valid create -> 2xx envelope`,
      meta: { endpoint: entry.key, method: entry.method, path: entry.path, field: "(auto)", attack: "(auto)" },
      run: async () => {
        const body = entry.makeValidBody!("valid", entry);
        const base = {
          endpoint: entry.key, method: entry.method, path: entry.path,
          field: "(valid)", attack: "valid-create", sentBody: JSON.stringify(body), expected: "2xx envelope",
        };
        const r = await send(entry.method, entry.path, body);
        try {
          if (r.status < 200 || r.status >= 300) throw new Error(`-> ${r.status}`);
          trackId(entry, r);
          checkSuccessResponse(base, entry, r);
        } catch (e) {
          fail({ ...base, status: r.status, bodyText: r.text.slice(0, 500) }, String((e as Error).message));
        }
        ok(base, r.status, r.text);
      },
    });
  }
  if (entry.needsFixture && entry.makeValidBody) {
    for (const idForm of ["number", "string"] as const) {
      cases.push({
        name: `[${entry.key}] valid update id-as-${idForm} -> 2xx`,
        meta: { endpoint: entry.key, method: entry.method, path: entry.path, field: "(auto)", attack: "(auto)" },
        run: async () => {
          if (entry.fixtureId === undefined) throw new Error("no fixture id");
          const body = validBaseOf(entry, "valid");
          body["id"] = idForm === "number" ? entry.fixtureId : String(entry.fixtureId);
          const base = {
            endpoint: entry.key, method: entry.method, path: entry.path,
            field: "(valid)", attack: `valid-id-${idForm}`, sentBody: JSON.stringify(body), expected: "2xx envelope",
          };
          const r = await send(entry.method, entry.path, body);
          try {
            if (r.status < 200 || r.status >= 300) throw new Error(`-> ${r.status}`);
            trackId(entry, r);
            checkSuccessResponse(base, entry, r);
          } catch (e) {
            fail({ ...base, status: r.status, bodyText: r.text.slice(0, 500) }, String((e as Error).message));
          }
          ok(base, r.status, r.text);
        },
      });
    }
  }
  return cases;
}

export function planEndpoint(entry: RegistryEntry): PlannedCase[] {
  const out: PlannedCase[] = [];
  out.push(...validCases(entry));
  if (entry.bodySchema) {
    out.push(...bodyCases(entry, entry.bodySchema));
    out.push(...objectLevelCases(entry, entry.bodySchema));
    out.push(...rawBodyCases(entry));
  }
  if (entry.querySchema) out.push(...queryCases(entry, entry.querySchema));
  // Links have no numeric data.id and no DELETE route, so the generic
  // POST-then-DELETE-by-id state cases cannot address them (T12). Cascade
  // behavior is covered by the semantic suite instead.
  if (entry.makeValidBody && !entry.stateless) out.push(...stateCases(entry));
  return out;
}

export function planGlobals(paths: string[]): PlannedCase[] {
  const out: PlannedCase[] = [];
  for (const u of UNKNOWN_ROUTES) {
    out.push({
      name: `[global] unknown-route ${u} -> JSON 404 same shape`,
      meta: { endpoint: "(global)", method: "GET", path: u, field: "(route)", attack: "unknown-route" },
      run: async () => {
        const base = {
          endpoint: "(global)", method: "GET", path: u,
          field: "(route)", attack: "unknown-route", sentBody: undefined, expected: "404 same error shape",
        };
        const r = await send("GET", u);
        try {
          if (r.status !== 404) throw new Error(`expected 404, got ${r.status}`);
          checkErrorResponse(base, r);
        } catch (e) {
          fail({ ...base, status: r.status, bodyText: r.text.slice(0, 500) }, String((e as Error).message));
        }
        ok(base, r.status, r.text);
      },
    });
  }
  for (const p of paths) {
    for (const a of ROUTE_ATTACKS) {
      if (a.kind === "method" && a.method === "HEAD") {
        // RFC 9110: HEAD MUST be supported wherever GET is. Expecting 404/405
        // here was wrong against the contract (HTTP semantics override); HEAD
        // must succeed with an empty body.
        out.push({
          name: `[global] HEAD ${p} -> 2xx empty`,
          meta: { endpoint: "(global)", method: "HEAD", path: p, field: "(route)", attack: "HEAD" },
          run: async () => {
            const base = {
              endpoint: "(global)", method: "HEAD", path: p,
              field: "(route)", attack: "HEAD", sentBody: undefined, expected: "2xx (RFC 9110 HEAD-from-GET)",
            };
            const r = await send("HEAD", p);
            try {
              if (r.status < 200 || r.status >= 300) throw new Error(`expected 2xx, got ${r.status}`);
              if (r.text.length > 0) throw new Error(`HEAD must have empty body, got ${r.text.length} chars`);
            } catch (e) {
              fail({ ...base, status: r.status, bodyText: r.text.slice(0, 500) }, String((e as Error).message));
            }
            ok(base, r.status, r.text);
          },
        });
        continue;
      }
      if (a.kind === "method") {
        out.push({
          name: `[global] ${a.method} ${p} -> 404-or-405 same shape`,
          meta: { endpoint: "(global)", method: a.method, path: p, field: "(route)", attack: a.label },
          run: async () => {
            const base = {
              endpoint: "(global)", method: a.method, path: p,
              field: "(route)", attack: a.label, sentBody: undefined, expected: "404 or 405 same shape",
            };
            const r = await send(a.method, p);
            try {
              if (r.status !== 404 && r.status !== 405) {
                throw new Error(`expected 404 or 405, got ${r.status}`);
              }
              checkErrorResponse(base, r);
            } catch (e) {
              fail({ ...base, status: r.status, bodyText: r.text.slice(0, 500) }, String((e as Error).message));
            }
            ok(base, r.status, r.text);
          },
        });
      } else {
        const path = a.suffix === "/" && a.label === "double-slash" ? p.replace(/^\//, "//") : `${p}${a.suffix}`;
        out.push({
          name: `[global] GET ${path} (${a.label}) -> no 5xx`,
          meta: { endpoint: "(global)", method: "GET", path, field: "(route)", attack: a.label },
          run: async () => {
            const base = {
              endpoint: "(global)", method: "GET", path,
              field: "(route)", attack: a.label, sentBody: undefined, expected: "no 5xx (slash handling ambiguous)",
            };
            const r = await send("GET", path);
            try {
              expectNo5xx({ ...base }, r.status, r.text);
              if (r.status >= 400 && r.status < 500) checkErrorResponse(base, r);
            } catch (e) {
              fail({ ...base, status: r.status, bodyText: r.text.slice(0, 500) }, String((e as Error).message));
            }
            ok(base, r.status, r.text);
          },
        });
      }
    }
    // Bounded-concurrency read load: 30 parallel GETs, none may 5xx.
    out.push({
      name: `[global] GET ${p} x30 @10 -> no 5xx`,
      meta: { endpoint: "(global)", method: "GET", path: p, field: "(load)", attack: "concurrent-reads" },
      run: async () => {
        const base = {
          endpoint: "(global)", method: "GET", path: p,
          field: "(load)", attack: "concurrent-reads", sentBody: undefined, expected: "no 5xx",
        };
        const queue = Array.from({ length: 30 }, (_, i) => i);
        const workers = Array.from({ length: 10 }, async () => {
          while (queue.length > 0) {
            queue.pop();
            const r = await send("GET", p);
            if (r.status >= 500) throw new Error(`concurrent GET -> ${r.status}`);
          }
        });
        try {
          await Promise.all(workers);
        } catch (e) {
          fail({ ...base, status: null, bodyText: "" }, String((e as Error).message));
        }
        ok(base, 200, "concurrent reads clean");
      },
    });
  }
  return out;
}

export async function writeReport(path: string): Promise<void> {
  const { Bun } = globalThis as unknown as { Bun: { write: (p: string, s: string) => Promise<void> } };
  await Bun.write(
    path,
    JSON.stringify({ seed: SEED, base: BASE, outcomes, errorKeySets: [...errorKeySets] }, null, 1),
  );
}
