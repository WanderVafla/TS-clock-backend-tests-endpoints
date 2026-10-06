# Contract test report

Run: `bun --env-file=../.env test tests/contract` (the `--env-file` is
required: test imports app source, and `share/constants.ts` builds the SQL
client at import time).
Seed: `20260929` (override: `SEED=<n>`). Base: `http://localhost:8000`
(`BASE_URL` override). Server must already run; the suite never starts it.

Latest run: **1621 tests, 1609 pass, 12 fail** (engine suite 1613 outcomes:
1602 pass, 11 fail; `entries-semantic.test.ts` 8 tests: 7 pass, 1 fail).
Covers issue #6 (time entries CRUD + label associations).

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
| `/entiers` | GET | — | `{id?, project_id?}` (inline, D5) | envelope + `Entiers[]` (imported `EntiersSchema`), filter mode |
| `/entiers` | POST | `CreateEntiersSchema` | — | envelope + `Entiers` (toggle start/finish, A8), 2xx |
| `/entiers` | DELETE | — | `v.object({id: idQuerySchema})` (inline, D2) | envelope + `{id: number}` (declared type) |
| `/entiers` | PATCH | `UpdateEntiersSchema` | — | envelope + FULL entry (runtime `returning *`, D6) |
| `/entiers/labels` | GET | — | `{label_id?, time_entry_id?}` (no registry fuzz, D7) | envelope + link list (imported `EntryLabelLinkSchema`) |
| `/entiers/labels` | POST | `EntryLabelLinkSchema` | — | envelope + link, 2xx |
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
| entries.list | 50 | 0 |
| entries.create | 205 | 0 |
| entries.remove | 36 | 0 |
| entries.update | 290 | 4 |
| entry-labels.list | 1 | 0 |
| entry-labels.create | 225 | 0 |
| entries semantic (issue #6) | 7 | 1 |
| (global routes) | 28 | 0 |

Error-shape consistency: single top-level key set
(`message,name,status,success`) across all 926 error responses — PASS.

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

### F3. `GET /entiers?id=<missing>` returns `200 []`, not 404 (REAL APP DIVERGENCE from issue #6, last red semantic case)
- Semantic `GET entry by missing id -> 404`: `GET /entiers?id=900000001`
  answers `200 {"success":true,"data":[]}`.
- Issue #6 requires "get entry details" + "Not-found cases return 404".
  The app only has a list route (filters never 404 — by HTTP semantics a
  filter with no matches is `200 []`, so the engine asserts 2xx-list for it,
  T13). The strict reading (detail route must 404) stays red here.
- Violated: issue #6 acceptance criteria (no dedicated detail route at all).

### F4. `POST /entiers/labels` answered 500 for duplicate and unknown-FK pairs (FIXED 2026-10-05, two changes)
- Duplicate pair: `ON CONFLICT DO NOTHING` + `throw InternalError` → 500.
  Fixed by throwing `NotFoundError` instead → 404 (owner-accepted semantic;
  suite oracle accepts any non-VALIDATION 4xx here).
- Unknown `time_entry_id`/`label_id`: FK violation surfaced as 500.
  Fixed by the global `errno === "23503" → 404` mapping in `index.ts`
  (same fix as F7). 24 engine cases + semantic duplicate case green.
- Duplicate pair: `ON CONFLICT DO NOTHING` returns zero rows, the handler
  throws `InternalError` → `500 {"name":"InternalError"}`. Schema-valid
  input (both ids exist) must never 5xx.
- Unknown `time_entry_id`/`label_id` (any positive int, numeric strings,
  hex/exp forms, MISSING-key-stripped extras): FK violation surfaces as
  `500 {"name":"ServerError"}` instead of 404. Same class as F7.
- Semantic `duplicate link never 5xx` records the duplicate half.

### F5. `POST /entiers` drops `description` (REAL APP DIVERGENCE from issue #6)
- Semantic `create persists description`: sent `"descr-sent-…"`, stored row
  has `description: null`. `startEntier` inserts `project_id` only.
- Issue #6: "Each entry stores ... a description". Shape stays valid
  (`nullish`), so only the semantic test catches it.

### F6. `PATCH /entiers` with `end_time < start_time` answers 500 (REAL APP BUG)
- `UpdateEntiersSchema` has NO range check (the `forward` partialCheck lives
  only on the full `EntiersSchema`), so the payload is schema-valid; the
  `update` then violates the DB `CHECK (end_time >= start_time)`
  (`time_entries_check`) → `500 ServerError`.
- Semantic `end_time < start_time -> no 5xx` records it (oracle-correct
  weakest invariant: schema accepts → never 5xx).

### F7. `POST /entiers` with unknown `project_id` answered 500 (FIXED 2026-10-05)
- `startEntier` hit `time_entries_project_id_fkey` → 500. Fixed by the
  global `errno === "23503" → 404` mapping in `index.ts`. All 12 cases green.
- Follow-up fix same day: ids beyond int4 (`2^31`, `2^53-1`, …) raised
  `22003 numeric_value_out_of_range` → 500. Fixed at the contract level:
  `idQuerySchema` caps at `2147483647` (`NumberTooLarge`), so they are 422
  without touching the DB. Resolves ambiguity A6 (int32 overflow).
- Any schema-valid unknown project (`123`, `1000`, int32 bounds, numeric /
  padded / hex / exp strings): `startEntier` hits the FK
  (`time_entries_project_id_fkey`) → `500 ServerError` instead of 404.
- 12 engine cases, one root cause.

### F8. Validation messages echo input, tripping leak/amplification rules (FINDING, low severity for short input)
- `PATCH /entiers` `end_time`/`start_time` use `v.isoTimestamp()`, whose
  failure message embeds the received value. A 10k-char blob comes back in
  the 422 body (huge-echo rule, 2 cases); a short `1 UNION SELECT…` string
  matches the SQL-leak regexes (2 cases) — both are attacker-reflection in a
  422, not a server-side SQL leak. Kept red under the existing rules; the
  actionable part is the 10k amplification, not the short echo.

### F9. Rapid start→finish toggle answered sporadic 500 (FIXED 2026-10-05)
- `finishEntier` stamped `end_time` with client-side `new Date()`
  (millisecond precision, truncated) while `start_time` defaulted to DB
  `now()` (microsecond). Insert and finish inside the same millisecond →
  `end_time < start_time` → CHECK violation → 500.
- Evidence: direct-DB toggle loop 8/60 failures with no delay, 0/60 with a
  3 ms gap; HTTP burst 7–10/60.
- Fixed by stamping `end_time = now()` database-side in `finishEntier`.
  Toggle-path cases stable since (two consecutive full runs clean).
- `finishEntier` stamps `end_time` with client-side `new Date()`
  (millisecond precision, truncated) while `start_time` defaults to DB
  `now()` (microsecond). Insert and finish inside the same millisecond →
  `end_time < start_time` → CHECK violation → 500.
- Evidence: direct-DB toggle loop 8/60 failures with no delay, 0/60 with a
  3 ms gap; HTTP burst 7–10/60; suite `entries.create` toggle-path cases
  fail in varying subsets per run (~18 this run). Labels/projects are
  unaffected (single-query writes).
- Suite impact: the exact failing attack names in `entries.create` vary
  between runs (13–18 per run observed); all group here. No sleeps/retries
  were added to dodge it (that would hide flakiness, forbidden).

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
8. **POST /entiers is a start/finish toggle, not a plain create.** First POST
   with a fresh project opens an entry; the next POST closes it (returns the
   same row with `end_time` set) instead of creating a new row. Undocumented
   in issue #6 ("create an entry"), but exercised green by the semantic
   toggle test — recorded as behavior, not asserted as failure. Interacts
   with F9 (same-ms toggle) and F5 (`description` only accepted, never stored).

## 5. Coverage gaps

- Schema constructs not present in the app (nothing to walk): email, uuid,
  regex, url, picklist, date/datetime, nested objects/arrays in request
  bodies. If added, extend `attacks/` + walker and re-run.
- Skipped per owner “Reduce” decision: 1M-char payloads (10k kept), 1000-level
  nesting, concurrent state attacks (read-load @10 kept).
- `GET /`, `/openapi*`: inventory only, never requested (owner decision).
- Resolving filters on SECONDARY query keys (`project_id`,
  `time_entry_id`, `label_id`): the engine fuzzes validation per key but
  resolving-filter round-trips live in `entries-semantic.test.ts` (link
  round-trip through both filters, cascade, invalid-id 4xx).
- `GET /entiers/labels` has no registry query fuzz (D7: no numeric data.id
  to track, no DELETE route for fixtures); covered semantically instead.
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
- **T10 leak matcher flagged public field names:** `assertNoLeaks` matched
  `/project_id|time_entry_id|label_id/` against Elysia VALIDATION messages
  (`Invalid key: Expected "time_entry_id"…`), failing every 422 on entries
  endpoints. Those names are public API contract (route schemas + /openapi),
  not internals — the pattern is removed, table-name/SQL/stack patterns stay.
  Contract citation: the no-leak rule bans internals; the key echo reveals
  nothing beyond the schema.
- **T11 query attacks used small literal `7` as the non-resolving base:**
  `double-encoded 7` decodes server-side and resolved to pre-existing entry
  id 7 — and `DELETE` removed it (incident 2, §7). Base is now `MISSING_ID`
  (still missing → same 404/422 outcomes on labels/projects, safe everywhere).
- **T12 generic state cases assumed POST-creates-addressable-row:** link rows
  have no numeric `data.id` and no DELETE route, so all three state cases
  failed in setup. New generic `stateless` flag skips them for
  `entry-labels.create`; cascade is covered semantically instead. (Same
  family as legacy fix T6: no out-of-contract usage.)
- **T13 row-vs-filter query semantics:** the engine demanded exact 404 for a
  missing id and strict 4xx for exotic syntax on every query. For all-optional
  GET-list filters those inputs are schema-valid (stripped/decoded to `{}` or
  a valid id), so the oracle forbids expecting 4xx. New generic `queryMode`:
  `"row"` (DELETE, unchanged) vs `"filter"` (GET list: missing-id expects a
  2xx list, exotic syntax uses weakest routing). The strict "GET detail must
  404" reading stays red in the semantic suite (F3).

## 7. Database incidents (full disclosure)

- **Incident 2 (entries suite, 2026-10-05):** the new `entries.remove`
  `syntax:double-encoded` case (`?id=%2537`, dummy base `7`) decoded
  server-side to id 7 and `DELETE` removed **pre-existing time entry id 7**
  (`project_id=1`, Oct 2 row). Audit of the report JSON proves this was the
  only sub-50 id deleted by the suite (all other 2xx DELETEs hit owned
  fixtures). Remediation: NOT re-inserted — parent project 1 is itself gone
  (external concurrent activity, same pattern as §7 incident 1; re-creating
  it would guess at someone else's intent) so the row cannot be restored
  under its FK. Recurrence fixed at the root: non-resolving query bases are
  now `MISSING_ID` (T11).

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
- **D5:** `GET /entiers` query mirrors the route's inline object with two
  optional keys, built from the imported `idQuerySchema`.
- **D6:** `PATCH /entiers` asserts the full entry (`EntiersSchema`): the
  handler runs `update ... returning *`, so at runtime the row is complete
  even though the declared type is the partial `UpdateEntier`.
- **D7:** `GET /entiers/labels` has no registry query fuzz (link rows have
  no numeric `data.id` to track and no DELETE route for fixture cleanup);
  filters are covered by `entries-semantic.test.ts` instead.

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
- Endpoint needing foreign rows: `setup`/`teardown` hooks + `ctx` ids
  (entries pattern: owned project, then entry/label; teardown reverses).
- PATCH-shape bodies: `makeValidPatchBody` (engine prefers it over
  `makeValidBody` when `needsFixture`).
- GET-list filters: `queryMode: "filter"` (missing filter → 2xx list).
  Resources without addressable rows: `stateless: true`.
- Semantic (meaning, not shape) checks: `entries-semantic.test.ts`
  (round-trips, toggle, cascade; same oracle, same hygiene).
- New attack kind: one `{ label, value, tags }` entry in the matching
  `attacks/*.ts` file.
- New Valibot construct: walker case in `engine.ts` (+ gap note here if
  uncovered).
