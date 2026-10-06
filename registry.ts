// Endpoint registry: the ONLY file edited when adding an endpoint.
// Request schemas are IMPORTED from application source (never copied).
// Documented deviations from "import, don't re-declare" (see REPORT.md):
//  D1. POST /labels body: the route uses v.omit(LabelSchema, ["id"]) INLINE
//      (not exported). The registry mirrors that exact call — same constraint,
//      no duplicated knowledge.
//  D2. DELETE query objects: routes build v.object({ id: idQuerySchema })
//      inline. Mirrored with the imported idQuerySchema.
//  D3. Project response data: ProjectSchema is NOT exported by the app, so the
//      registry declares a minimal project shape. If the app exports it later,
//      switch the import and delete the declaration.
//  D4. DELETE /projects success data is `{id}` (owner decision (b),
 //      2026-10-06): the handler runs `delete ... returning id` and the
//      declared type is `Promise<{id: number}>`, so the contract is `{id}`.
//  D5. GET /entiers query object: the route builds
//      v.object({ id: optional(idQuerySchema), project_id: optional(idQuerySchema) })
//      inline. Mirrored with the imported idQuerySchema (same constraint).
//  D6. PATCH /entiers success data is the FULL entry (imported EntiersSchema):
//      the handler runs `update ... returning *`, so at runtime the row is
//      complete even though the declared type is the partial UpdateEntier.
//      If the handler ever returns a partial row, the red case goes to REPORT.md.
//  D7. GET /entiers/labels has NO querySchema here on purpose: the engine
//      fuzzes the primary query key with owned-row fixtures, but a link has
//      no numeric data.id to track and no DELETE route for cleanup. Filter
//      validation + resolving filters are covered by entries-semantic.test.ts.

import * as v from "valibot";
import { idQuerySchema } from "../../src/share/schema";
import {
  LabelSchema,
  UpdateLabelSchema,
} from "../../src/labels/labels.schema";
import {
  CreateProjectSchema,
  UpdateProjectSchema,
} from "../../src/projects/projects.schema";
import {
  CreateEntiersSchema,
  EntiersSchema,
  EntryLabelLinkSchema,
  UpdateEntiersSchema,
} from "../../src/entries/entries.schema";
import { rng, send, setupEntry } from "./engine";

export type RegistryEntry = {
  key: string;
  resource: "labels" | "projects" | "entries";
  method: "GET" | "POST" | "DELETE" | "PATCH";
  path: string;
  bodySchema?: v.GenericSchema;
  querySchema?: v.GenericSchema;
  // Schema for the `data` field of a 2xx envelope response.
  responseData: v.GenericSchema;
  // Schema for the `data` of the resource's GET list (used by state tests).
  listData: v.GenericSchema;
  makeValidBody?: (
    tag: string,
    entry?: RegistryEntry,
  ) => Record<string, unknown>;
  // PATCH-shape factory for needsFixture entries (update schema, not create).
  makeValidPatchBody?: (tag: string) => Record<string, unknown>;
  // Async cross-resource fixtures. Replaces the generic single-POST setupEntry
  // when an endpoint needs pre-existing rows (entries need an owned project,
  // links need project + entry + label). contract.test.ts runs setup before
  // all cases and teardown after the generic cleanup.
  setup?: (entry: RegistryEntry) => Promise<void>;
  teardown?: (entry: RegistryEntry) => Promise<void>;
  // Per-entry scratch space for fixture ids (owned project/entry/label).
  ctx?: Record<string, unknown>;
  // PATCH/DELETE need a real row id from setup().
  needsFixture?: boolean;
  fixtureId?: number;
  tracked: number[];
  // GET lists filter rows (missing filter -> 2xx list); DELETE addresses one
  // row (missing id -> 404). Default "row" preserves existing entries.
  queryMode?: "row" | "filter";
  // No generic POST-then-DELETE-by-id state cases (links have no numeric
  // data.id and no DELETE route; see T12).
  stateless?: boolean;
};

function suffix(tag: string): string {
  return `${tag}-${Math.floor(rng() * 0xffffff).toString(16)}`;
}

// D3: minimal project shape (ProjectSchema is not exported by the app).
const projectData = v.object({
  id: v.number(),
  name: v.string(),
  created_at: v.optional(v.string()),
});

const idOnlyData = v.object({ id: v.number() });

function validName(resource: string, tag: string): Record<string, unknown> {
  return { name: `contract-${resource}-${suffix(tag)}` };
}

// ── Entries fixtures (owned rows only; never seed ids) ──
// POST /entiers requires a live project_id, and POST /entiers/labels requires
// a live (time_entry_id, label_id) pair. Each registry entry below owns its
// project; link entries additionally own one entry and one label. Teardown
// deletes the entry first (CASCADE drops its links), then label, then project.
// Engine cleanupEntry already removes entries tracked by id; teardown only
// handles the cross-resource parents the generic cleanup cannot see.

type SendResp = Awaited<ReturnType<typeof send>>;

function takeId(r: SendResp, what: string): number {
  const id = (r.json as { data?: { id?: unknown } } | null)?.data?.id;
  if (r.status < 200 || r.status >= 300 || typeof id !== "number") {
    throw new Error(
      `entries setup: ${what} -> ${r.status} ${r.text.slice(0, 200)}`,
    );
  }
  return id;
}

function mustProject(entry: RegistryEntry | undefined): number {
  const id = entry?.ctx?.["projectId"];
  if (typeof id !== "number") {
    throw new Error(
      "entries fixture: no owned projectId in ctx (setup hook missed?)",
    );
  }
  return id;
}

async function setupOwnedProject(entry: RegistryEntry): Promise<void> {
  const r = await send("POST", "/projects", {
    name: `contract-entries-proj-${suffix("setup")}`,
  });
  entry.ctx = { ...(entry.ctx ?? {}), projectId: takeId(r, "POST /projects") };
}

async function teardownOwnedProject(entry: RegistryEntry): Promise<void> {
  const id = entry.ctx?.["projectId"];
  if (typeof id === "number") await send("DELETE", `/projects?id=${id}`);
}

function validEntryBody(
  tag: string,
  entry?: RegistryEntry,
): Record<string, unknown> {
  return {
    project_id: mustProject(entry),
    description: `contract-entries-${suffix(tag)}`,
  };
}

function mustLinkPair(
  entry: RegistryEntry | undefined,
): { time_entry_id: number; label_id: number } {
  mustProject(entry); // fail fast when the setup hook missed
  const time_entry_id = entry?.ctx?.["entryId"];
  const label_id = entry?.ctx?.["labelId"];
  if (typeof time_entry_id !== "number" || typeof label_id !== "number") {
    throw new Error(
      "entries fixture: no owned entryId/labelId in ctx (setup hook missed?)",
    );
  }
  return { time_entry_id, label_id };
}

async function setupLinkFixtures(entry: RegistryEntry): Promise<void> {
  await setupOwnedProject(entry);
  const projectId = mustProject(entry);
  const er = await send("POST", "/entiers", {
    project_id: projectId,
    description: `contract-link-entry-${suffix("setup")}`,
  });
  const lr = await send("POST", "/labels", {
    name: `contract-link-label-${suffix("setup")}`,
  });
  // The pair stays UNLINKED: the valid-create case links it (2xx), so the
  // duplicate-link 500 surfaces only where the oracle expects it (REPORT F4).
  entry.ctx = {
    ...entry.ctx,
    entryId: takeId(er, "POST /entiers"),
    labelId: takeId(lr, "POST /labels"),
  };
}

async function teardownLinkFixtures(entry: RegistryEntry): Promise<void> {
  const entryId = entry.ctx?.["entryId"];
  const labelId = entry.ctx?.["labelId"];
  if (typeof entryId === "number") {
    await send("DELETE", `/entiers?id=${entryId}`);
  }
  if (typeof labelId === "number") {
    await send("DELETE", `/labels?id=${labelId}`);
  }
  await teardownOwnedProject(entry);
}

const entierListData = v.array(EntiersSchema);
const linkListData = v.array(EntryLabelLinkSchema);

export const REGISTRY: RegistryEntry[] = [
  {
    key: "labels.list",
    resource: "labels",
    method: "GET",
    path: "/labels",
    responseData: v.array(LabelSchema),
    listData: v.array(LabelSchema),
    tracked: [],
  },
  {
    key: "labels.create",
    resource: "labels",
    method: "POST",
    path: "/labels",
    bodySchema: v.omit(LabelSchema, ["id"]), // D1
    responseData: LabelSchema,
    listData: v.array(LabelSchema),
    makeValidBody: (tag) => validName("labels", tag),
    tracked: [],
  },
  {
    key: "labels.remove",
    resource: "labels",
    method: "DELETE",
    path: "/labels",
    querySchema: v.object({ id: idQuerySchema }), // D2
    responseData: idOnlyData,
    listData: v.array(LabelSchema),
    makeValidBody: (tag) => validName("labels", tag),
    tracked: [],
  },
  {
    key: "labels.update",
    resource: "labels",
    method: "PATCH",
    path: "/labels",
    bodySchema: UpdateLabelSchema,
    responseData: LabelSchema,
    listData: v.array(LabelSchema),
    makeValidBody: (tag) => validName("labels", tag),
    needsFixture: true,
    tracked: [],
  },
  {
    key: "projects.list",
    resource: "projects",
    method: "GET",
    path: "/projects",
    responseData: v.array(projectData), // D3
    listData: v.array(projectData), // D3
    tracked: [],
  },
  {
    key: "projects.create",
    resource: "projects",
    method: "POST",
    path: "/projects",
    bodySchema: CreateProjectSchema,
    responseData: projectData, // D3
    listData: v.array(projectData), // D3
    makeValidBody: (tag) => validName("projects", tag),
    tracked: [],
  },
  {
    key: "projects.remove",
    resource: "projects",
    method: "DELETE",
    path: "/projects",
    querySchema: v.object({ id: idQuerySchema }), // D2
    responseData: idOnlyData, // D4: contract is `{id}` (owner decision (b))
    listData: v.array(projectData), // D3
    makeValidBody: (tag) => validName("projects", tag),
    tracked: [],
  },
  {
    key: "projects.update",
    resource: "projects",
    method: "PATCH",
    path: "/projects",
    bodySchema: UpdateProjectSchema,
    responseData: projectData, // D3
    listData: v.array(projectData), // D3
    makeValidBody: (tag) => validName("projects", tag),
    needsFixture: true,
    tracked: [],
  },
  {
    key: "entries.list",
    resource: "entries",
    method: "GET",
    path: "/entiers",
    querySchema: v.object({
      id: v.optional(idQuerySchema),
      project_id: v.optional(idQuerySchema),
    }), // D5
    responseData: entierListData,
    listData: entierListData,
    queryMode: "filter",
    makeValidBody: validEntryBody,
    setup: (entry) => setupOwnedProject(entry),
    teardown: (entry) => teardownOwnedProject(entry),
    tracked: [],
  },
  {
    key: "entries.create",
    resource: "entries",
    method: "POST",
    path: "/entiers",
    bodySchema: CreateEntiersSchema,
    responseData: EntiersSchema,
    listData: entierListData,
    makeValidBody: validEntryBody,
    setup: (entry) => setupOwnedProject(entry),
    teardown: (entry) => teardownOwnedProject(entry),
    tracked: [],
  },
  {
    key: "entries.remove",
    resource: "entries",
    method: "DELETE",
    path: "/entiers",
    querySchema: v.object({ id: idQuerySchema }), // D2
    responseData: idOnlyData,
    listData: entierListData,
    makeValidBody: validEntryBody,
    setup: (entry) => setupOwnedProject(entry),
    teardown: (entry) => teardownOwnedProject(entry),
    tracked: [],
  },
  {
    key: "entries.update",
    resource: "entries",
    method: "PATCH",
    path: "/entiers",
    bodySchema: UpdateEntiersSchema,
    responseData: EntiersSchema, // D6
    listData: entierListData,
    makeValidBody: validEntryBody,
    makeValidPatchBody: (tag) => ({
      description: `contract-entries-patch-${suffix(tag)}`,
    }),
    needsFixture: true,
    setup: async (entry) => {
      await setupOwnedProject(entry);
      await setupEntry(entry);
    },
    teardown: (entry) => teardownOwnedProject(entry),
    tracked: [],
  },
  {
    key: "entry-labels.list",
    resource: "entries",
    method: "GET",
    path: "/entiers/labels",
    responseData: linkListData,
    listData: linkListData,
    tracked: [],
  },
  {
    key: "entry-labels.create",
    resource: "entries",
    method: "POST",
    path: "/entiers/labels",
    bodySchema: EntryLabelLinkSchema,
    responseData: EntryLabelLinkSchema,
    listData: linkListData,
    stateless: true, // T12: no id, no DELETE route; cascade is semantic-tested
    makeValidBody: (_tag, entry) => ({ ...mustLinkPair(entry) }),
    setup: (entry) => setupLinkFixtures(entry),
    teardown: (entry) => teardownLinkFixtures(entry),
    tracked: [],
  },
];

export const PATHS: string[] = [...new Set(REGISTRY.map((e) => e.path))];
