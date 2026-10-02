# Contract test report

Run: `bun --env-file=../.env test tests/contract` (the `--env-file` is
required: test imports app source, and `share/constants.ts` builds the SQL
client at import time).
Seed: `20260929` (override: `SEED=<n>`). Base: `http://localhost:8000`
(`BASE_URL` override). Server must already run; the suite never starts it.

Latest run: **802 tests, 791 pass, 11 fail.**

## 1. Inventory (from code)

| Route | Method | Body schema | Query schema | Success contract |
|---|---|---|---|---|
| `/labels` | GET | — | — | envelope + `Label[]` (imported `LabelSchema`) |
| `/labels` | POST | `v.omit(LabelSchema, ["id"])` (inline, D1) | — | envelope + `Label`, 2xx |
| `/labels` | DELETE | — | `v.object({id: idQuerySchema})` (inline, D2) | envelope + `{id: number}` (declared type) |
| `/labels` | PATCH | `UpdateLabelSchema` | — | envelope + `Label` |
| `/projects` | GET | — | — | envelope + project list (D3) |
| `/projects` | POST | `CreateProjectSchema` | — | envelope + project (D3), 2xx |
| `/projects` | DELETE | — | `v.object({id: idQuerySchema})` (inline, D2) | envelope + FULL project (declared `Promise<Project>`, D4) |
| `/projects` | PATCH | `UpdateProjectSchema` | — | envelope + project (D3) |
| `/`, `/openapi*` | GET | **no schemas — finding, inventory only, never requested** | | |

Shared: `id` = `union(string→trim→minLength(1) | number)` → `transform(Number)` →
`number/integer/minValue(1)`; `name` = `string/trim/nonEmpty/min(1)/max(255)`;
update = `object{id, partial…}` + check “≥1 field besides id”.
Errors must match `response.ts` pattern:
`{success: false, name: string, status: number|string, message: string}`.
Success envelope: `{success: true, status, data}` (exact, owner decision).

Routes with no schema at all: `GET /`, `/openapi`, `/openapi/json`
(documentation UI; excluded from probing by owner decision).

## 2. Totals per endpoint (latest run)

| Endpoint | Pass | Fail |
|---|---|---|
| labels.list | 1 | 0 |
| labels.create | 143 | 1 |
| labels.remove | 36 | 0 |
| labels.update | 211 | 1 |
| projects.list | 1 | 0 |
| projects.create | 143 | 1 |
| projects.remove | 29 | 7 |
| projects.update | 211 | 1 |
| (global routes) | 16 | 0 |

Error-shape consistency: single top-level key set
(`message,name,status,success`) across all 351 error responses — PASS.

## 3. Failures grouped by root cause (KEEP RED, do not fix tests)

### F1. NUL byte in `name` -> HTTP 500 (4 cases, REAL APP BUG)
- `labels.create POST name=nul-byte`, `labels.update PATCH name=nul-byte`,
  `projects.create`, `projects.update` — same.
- Request: `{"name": "ab\0cd"}` (+ valid id for PATCH). Schema ACCEPTS
  (non-empty string). Server answers
  `500 {"success":false,"name":"ServerError","status":500,"message":"Server Error"}`.
- Violated: oracle rule “schema-valid must never 5xx”. Postgres rejects the
  NUL byte (invalid byte sequence), the driver error surfaces as 500.
- Note: the 500 envelope itself is clean (no leaks) — the bug is the 500,
  not its shape.

### F2. `DELETE /projects` returns `{id}`, declared `Promise<Project>` (7 cases, INTENDED DIVERGENCE per owner decision 3.2)
- `projects.remove` valid deletes in every id form
  (`form:plain/leading-zero/padded-spaces/hex/trailing-dot-zero/plus-sign`,
  `syntax:percent-encoded`): HTTP 200 with `data: {"id": N}`.
- Registry asserts the FULL project shape because the declared type is
  `Promise<Project>`. Mismatch recorded, test stays red until the owner
  decides: (a) handler returns the full row, or (b) type/response-schema
  becomes `{id}` and the registry is updated after that change.
- `DELETE /labels` (declared `{id}`) passes the same cases — the oracle is
  symmetric, the code is not.

## 4. Ambiguities (weakest invariant asserted, questions for owner)

1. **400 vs 422.** Observed on every validation rejection: HTTP status is
   **422** (Elysia default) while the body says `"status": 400`. Suite asserts
   only “4xx”. Question: should `set.status` be synced to the body status
   (the pending `set.status`-sync decision)? Until then the two numbers
   disagree by design accident, not by contract.
2. **404 vs 409.** No UNIQUE constraints exist, so 409 is currently
   unreachable; missing rows assert exact 404 (HTTP semantics + app taxonomy).
   If a UNIQUE ever appears, duplicate handling (400/404/409) needs a ruling.
3. **Duplicate JSON keys** (`{"name":"a","name":"b"}`): last-wins may be 2xx
   or 4xx — asserted only “no 5xx + shape routing”.
4. **Missing Content-Type / text-plain / urlencoded / odd charsets with a
   valid JSON payload:** server parses and creates (201 observed). Asserted
   only “no 5xx + routing” — no contract rule demands 415 here.
5. **Trailing/double slash:** asserted only “no 5xx (+ shape if 4xx)”.
   Observed: handled without 5xx.
6. **int32-overflow ids** (`2147483648`): schema-valid, observed 404 (no 500).
   Oracle-compliant; why the driver does not complain is unexplained but not
   a failure.
7. **OPTIONS/PUT on existing paths:** 404-or-405 asserted; observed within
   range. HEAD returns 200 (see §6, test fix H3).

## 5. Coverage gaps

- Schema constructs not present in the app (nothing to walk): email, uuid,
  regex, url, picklist, date/datetime, nested objects/arrays in request
  bodies. If added, extend `attacks/` + walker and re-run.
- Skipped per owner “Reduce” decision: 1M-char payloads (10k kept), 1000-level
  nesting, concurrent state attacks (read-load @10 kept).
- `GET /`, `/openapi*`: inventory only, never requested (owner decision).
- Walker reads Valibot v1 internals (`.type/.entries/.options/.pipe`,
  action `.type/.requirement`); if Valibot changes its internals, boundary
  extraction silently yields less (static catalogs still apply).

## 6. Test bugs found and fixed during the build (tests only, app untouched)

Each was wrong AGAINST THE CONTRACT and fixed with the contract citation:
- **T1 huge-echo check on every short string:** any rejected short name
  “failed” because any response is longer than `""`. Now applies only to
  `huge`-tagged attacks (≥1000 chars). (~100 spurious failures removed.)
- **T2 raw-body oracle demanded 4xx for missing-CT/urlencoded/charset
  payloads:** no contract rule requires 415; server parses them into valid
  payloads (201 observed). Split: malformed → strict 4xx (HTTP semantics);
  content-type-ambiguous → weakest invariant.
- **T3 DELETE tests used arbitrary live ids** (`?id=1`, `?id=5`): first full
  run deleted pre-existing rows (see §7). Redesigned: invalid-format values
  (never resolve) + fixture-derived parsing forms each with a FRESH owned
  row + guaranteed-missing id `900000001` + exotic syntax split into
  resolving (fresh row) / non-resolving (dummy base).
- **T4 HEAD expected 404/405:** wrong — RFC 9110 (contract source: HTTP
  semantics) requires HEAD wherever GET exists. Now expects 2xx + empty body.
- **T5 state GET check validated the list against the single-entity schema:**
  used the wrong schema for the route; now uses per-resource `listData`.
- **T6 valid-body create case generated for DELETE** (a route with no body
  schema): out-of-contract usage; removed (valid deletes covered by T3).
- **T7 loop variable `v` shadowed the Valibot import** (`v.safeParse is not
  a function`, 300+ cascading failures): renamed to `variant`.
- **T8 outcomes missing for throws outside case guards:** `PlannedCase.meta`
  + record-then-rethrow wrapper in `contract.test.ts` (recording ≠
  swallowing; every error is rethrown).
- **T9 error-shape consistency was collected but never asserted:** final
  `(suite)` test now fails if key sets diverge.

## 7. Database incidents (full disclosure)

- **Incident 1 (first full run, before T3):** query attacks with arbitrary
  ids (`?id=1`, `?id=5`) deleted pre-existing rows (labels `1 Bug`;
  projects `1`, `5`) and 8 untracked `contract-x` rows were left behind
  (raw-body 201s were not tracked). Remediation, all verified: leftovers
  deleted via API; rows re-inserted with original ids
  (`OVERRIDING SYSTEM VALUE`; `created_at` approximated as `now()`).
- **After the final run:** labels `1` and projects `1, 5, 7` are missing
  AGAIN, but the recorded report proves the suite sent no deleting request
  for them (every small-id request in `/tmp/contract-report.json` is 422 or
  404; all 2xx DELETEs hit fixture ids ≥ 600). Rows `211–215 "Update test"`
  (not suite-named) appeared mid-session. Conclusion: concurrent manual
  activity on the same DB, not the suite. Deliberately NOT re-restored —
  re-inserting could undo someone's intentional deletes. If those rows must
  come back, say so and they will be re-inserted with original ids.
- Lesson encoded: T3 (owned rows only) + `MISSING_ID` + tracking of every
  2xx `data.id` + cleanup that deletes only tracked ids.

## 8. Deviations D1–D4 (registry mirrors, not copies)

- **D1:** `POST /labels` body `v.omit(LabelSchema, ["id"])` mirrors the
  route's inline call (not exported; same constraint, no duplicated
  knowledge).
- **D2:** DELETE query `v.object({ id: idQuerySchema })` mirrors the routes'
  inline objects, built from the imported `idQuerySchema`.
- **D3:** project response shapes are declared minimally in the registry
  because `ProjectSchema` is not exported by the app. Switch to the import
  if it ever becomes exported.
- **D4:** `DELETE /projects` asserts the full project (declared type) —
  currently red, see F2.

## 9. Replaced legacy tests

`contract.test.ts` (hand-written matrix, untracked) was overwritten because
it was wrong against the contract: it expected 4xx for numeric PATCH ids
that the union id schema accepts (oracle: schema-valid must not be
validation-rejected); it hardcoded response shapes instead of importing
schemas; randomness was unseeded (`crypto.randomUUID`). Its coverage is a
strict subset of the engine-driven suite.

## 10. How to extend

- New endpoint: one entry in `registry.ts` (method, path, imported schemas,
  response `data` schema, `makeValidBody`, `needsFixture` for PATCH/DELETE).
  Nothing else changes.
- New attack kind: one `{ label, value, tags }` entry in the matching
  `attacks/*.ts` file.
- New Valibot construct: walker case in `engine.ts` (+ gap note here if
  uncovered).
