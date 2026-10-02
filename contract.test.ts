// Contract suite entrypoint: loops over registry.ts + global route cases.
// No per-endpoint logic here. Replaces the legacy hand-written matrix, which
// was wrong against the contract (expected 4xx for numeric PATCH ids that the
// union id schema accepts; hardcoded shapes instead of imported schemas;
// unseeded randomness). See REPORT.md "Replaced legacy tests".
import { describe, test, beforeAll, afterAll } from "bun:test";
import { REGISTRY, PATHS } from "./registry";
import {
  SEED,
  outcomes,
  errorKeySets,
  preflight,
  setupEntry,
  cleanupEntry,
  planEndpoint,
  planGlobals,
  writeReport,
  type Outcome,
} from "./engine";

const REPORT_PATH = "/tmp/contract-report.json";

beforeAll(async () => {
  await preflight();
  for (const entry of REGISTRY) {
    await setupEntry(entry);
  }
});

for (const entry of REGISTRY) {
  describe(entry.key, () => {
    for (const c of planEndpoint(entry)) {
      test(c.name, async () => {
        // Record-then-rethrow: outcomes must include even failures thrown
        // outside the engine's own try blocks (e.g. network errors).
        // Recording is not swallowing — the error is always rethrown.
        const before = outcomes.length;
        try {
          await c.run();
        } catch (e) {
          if (outcomes.length === before) {
            outcomes.push({
              endpoint: c.meta.endpoint,
              method: c.meta.method,
              path: c.meta.path,
              field: c.meta.field,
              attack: c.meta.attack,
              sentBody: undefined,
              expected: "(unrecorded: threw outside case guards)",
              status: null,
              bodyText: "",
              pass: false,
              error: String(e instanceof Error ? e.message : e),
            } satisfies Outcome);
          }
          throw e;
        }
      });
    }
  });
}

describe("(global routes)", () => {
  for (const c of planGlobals(PATHS)) {
    test(c.name, async () => {
      const before = outcomes.length;
      try {
        await c.run();
      } catch (e) {
        if (outcomes.length === before) {
          outcomes.push({
            endpoint: c.meta.endpoint,
            method: c.meta.method,
            path: c.meta.path,
            field: c.meta.field,
            attack: c.meta.attack,
            sentBody: undefined,
            expected: "(unrecorded: threw outside case guards)",
            status: null,
            bodyText: "",
            pass: false,
            error: String(e instanceof Error ? e.message : e),
          } satisfies Outcome);
        }
        throw e;
      }
    });
  }

  test("(suite) error shape identical across all statuses", () => {
    const sets = [...errorKeySets.keys()];
    const outcome: Outcome = {
      endpoint: "(global)",
      method: "-",
      path: "-",
      field: "(suite)",
      attack: "same-error-shape",
      sentBody: undefined,
      expected: "single top-level key set",
      status: null,
      bodyText: JSON.stringify(sets),
      pass: errorKeySets.size === 1,
      error: errorKeySets.size === 1 ? null : `distinct error shapes: ${JSON.stringify(sets)}`,
    };
    outcomes.push(outcome);
    if (!outcome.pass) throw new Error(outcome.error as string);
  });
});

afterAll(async () => {
  const cleanups = [];
  for (const entry of REGISTRY) {
    cleanups.push(cleanupEntry(entry).then((r) => ({ key: entry.key, ...r })));
  }
  const results = await Promise.all(cleanups);
  console.log(`seed=${SEED} cleanup=${JSON.stringify(results)}`);
  await writeReport(REPORT_PATH);
  console.log(`report json: ${REPORT_PATH}`);
});
