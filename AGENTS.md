# Contract test suite: rules for agents

Purpose: adversarial black-box tests for the Elysia + Valibot API. The suite
exists to FIND bugs. A red test means the suite works.

## Golden rules
1. Expected behavior comes from the contract (Valibot schemas, HTTP semantics,
   the invariants below, explicit user instructions), never from what the code
   currently returns.
2. Reading application code may only ADD or TIGHTEN tests. Never use it to
   skip, loosen or reshape a case, even if you can see the bug it will hit.
3. Never modify application code, schemas, handlers or the database schema.
   Tests only (tests/contract/**).
4. Never make the suite green by editing tests. Report failures instead.
5. Forbidden: .skip, .todo, .only, swallowed errors, retries to hide flakiness,
   mocks, response snapshots, widening accepted status ranges after a failure.
6. A test may be changed or removed only if it is wrong AGAINST THE CONTRACT.
   State which contract rule in REPORT.md.

## Oracle (do not change without the owner's approval)
- Schema rejects the payload  -> server must answer 4xx.
- Schema accepts the payload  -> server must not answer a validation error and
  must never answer 5xx.
- Any status >= 500 is always a failure.
- Ambiguous exact status -> assert only "4xx" and record the question in REPORT.md.

## Error-response invariants
- JSON object, Content-Type application/json.
- Same top-level shape across all error statuses.
- No stack traces, file paths, SQL, table/column names or library error text.
- Unknown route -> JSON 404 in the same shape.

## Structure
- tests/contract/registry.ts: the only file edited when adding an endpoint.
- tests/contract/engine.ts: generic engine, no per-endpoint logic.
- tests/contract/attacks/*.ts: data only, one entry per attack.
- tests/contract/assertions.ts: shared checks.
- tests/contract/contract.test.ts: loops over the registry.
- Schemas are IMPORTED from application source. Never copy or redefine them,
  so the oracle can not drift from the real code.

## When a new endpoint or schema appears
1. Add one entry to registry.ts (method, path, imported schemas, success
   response schema, setup/cleanup).
2. If the schema uses a Valibot construct the engine does not handle
   (new v.pipe action, custom check, v.transform, v.variant ...), add an
   attack file entry or a walker case in engine.ts. List the gap in REPORT.md
   if you can't cover it.
3. Run `bun test tests/contract`, update REPORT.md. Do not touch failing cases.

## When a new kind of attack is needed
Add one entry to the matching file in attacks/ ({ label, value, tags }).
Never add endpoint-specific attacks to engine.ts.

## Hygiene
- Created data uses the prefix "contract-" + random suffix and is always
  cleaned up, including rows created unexpectedly by an attack (track every id
  returned by any 2xx).
- Never touch pre-existing rows.
- Don't start or stop the server. Use BASE_URL (default http://localhost:8000).
- Dependencies limited to bun:test and valibot. Ask before adding more.
- Deterministic: seeded randomness only, print the seed.
- Bounded concurrency (about 10).

## After every run
Update tests/contract/REPORT.md: inventory, totals per endpoint, failures
grouped by root cause (endpoint, field, attack, request, expected vs actual),
ambiguities, coverage gaps. Do not propose application fixes unless asked.