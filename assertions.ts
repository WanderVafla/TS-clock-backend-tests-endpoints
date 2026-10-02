import * as v from "valibot";

// Shared assertion helpers + contract schemas for response envelopes.
// The error envelope mirrors backend/src/share/response.ts ApiSuccessError
// (owner decision: use the response.ts output pattern as errorShape).
// The success envelope mirrors ApiSuccessResponse.

export type Attack = {
  label: string;
  value: unknown;
  tags: string[];
};

export const errorShape = v.object({
  success: v.literal(false),
  name: v.string(),
  status: v.union([v.number(), v.string()]),
  message: v.string(),
});

export function successEnvelope(data: v.GenericSchema) {
  return v.object({
    success: v.literal(true),
    status: v.union([v.number(), v.string()]),
    data,
  });
}

export type Ctx = {
  endpoint: string;
  method: string;
  path: string;
  field: string;
  attack: string;
  sentBody?: string;
};

function fmt(ctx: Ctx, extra: string): string {
  const sent = ctx.sentBody ? ` body=${ctx.sentBody.slice(0, 300)}` : "";
  return `[${ctx.endpoint} ${ctx.method} ${ctx.path} field=${ctx.field} attack=${ctx.attack}]${sent} ${extra}`;
}

export function expect4xx(ctx: Ctx, status: number, text: string): void {
  if (status < 400 || status >= 500) {
    throw new Error(fmt(ctx, `expected 4xx, got ${status}. body=${text.slice(0, 300)}`));
  }
}

export function expectNo5xx(ctx: Ctx, status: number, text: string): void {
  if (status >= 500) {
    throw new Error(fmt(ctx, `got 5xx ${status} (never allowed). body=${text.slice(0, 300)}`));
  }
}

export function expectNoValidationError(
  ctx: Ctx,
  status: number,
  json: unknown,
  text: string,
): void {
  const name = (json as { name?: unknown } | null)?.name;
  if (name === "VALIDATION") {
    throw new Error(fmt(ctx, `schema-valid payload rejected with VALIDATION. body=${text.slice(0, 300)}`));
  }
}

export function checkContentType(ctx: Ctx, headers: Headers, text: string): void {
  const ct = headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) {
    throw new Error(fmt(ctx, `expected application/json, got "${ct}". body=${text.slice(0, 200)}`));
  }
}

const LEAK_PATTERNS: RegExp[] = [
  /at\s+\S+\s*\(.+:\d+:\d+\)/, // stack frames
  /node_modules/,
  /\/src\//,
  /\.ts["':\s]/,
  /\.js:\d+/,
  /SELECT\s+.+\s+FROM/i,
  /INSERT\s+INTO/i,
  /DELETE\s+FROM/i,
  /UPDATE\s+\w+\s+SET/i,
  /syntax error/i,
  /violates\s+(unique|foreign key|not-null|check)/i,
  /labels_time_entrie/,
  /time_entries/,
  /project_id|time_entry_id|label_id/,
  /created_at/,
  /relation\s+"/i,
  /PostgresError|SQLError|ERR_POSTGRES/,
  /ECONNREFUSED|ENOTFOUND/,
];

export function assertNoLeaks(ctx: Ctx, text: string): void {
  for (const re of LEAK_PATTERNS) {
    if (re.test(text)) {
      throw new Error(fmt(ctx, `possible leak matching ${re}. body=${text.slice(0, 300)}`));
    }
  }
}

export function assertHugeNotEchoed(ctx: Ctx, text: string, attackLen: number): void {
  if (text.length >= attackLen) {
    throw new Error(fmt(ctx, `huge input echoed back (response ${text.length} chars)`));
  }
}

export function parseJson(ctx: Ctx, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(fmt(ctx, `body is not JSON. body=${text.slice(0, 200)}`));
  }
}

export function expectShape(
  ctx: Ctx,
  schema: v.GenericSchema,
  json: unknown,
  text: string,
): void {
  const p = v.safeParse(schema, json);
  if (!p.success) {
    throw new Error(fmt(ctx, `shape mismatch: ${v.summarize(p.issues)} body=${text.slice(0, 300)}`));
  }
}

export function errorKeys(json: unknown): string {
  if (typeof json !== "object" || json === null || Array.isArray(json)) return "<non-object>";
  return Object.keys(json).sort().join(",");
}
