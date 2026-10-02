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
//  D4. DELETE /projects success data is the FULL project shape because the
//      declared type is Promise<Project> (owner decision 3.2). The handler
//      currently returns {id} only, so this case is EXPECTED to fail and the
//      divergence goes to REPORT.md.

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
import { rng } from "./engine";

export type RegistryEntry = {
  key: string;
  resource: "labels" | "projects";
  method: "GET" | "POST" | "DELETE" | "PATCH";
  path: string;
  bodySchema?: v.GenericSchema;
  querySchema?: v.GenericSchema;
  // Schema for the `data` field of a 2xx envelope response.
  responseData: v.GenericSchema;
  // Schema for the `data` of the resource's GET list (used by state tests).
  listData: v.GenericSchema;
  makeValidBody?: (tag: string) => Record<string, unknown>;
  // PATCH/DELETE need a real row id from setup().
  needsFixture?: boolean;
  fixtureId?: number;
  tracked: number[];
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
    responseData: projectData, // D4: declared Promise<Project>
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
];

export const PATHS: string[] = [...new Set(REGISTRY.map((e) => e.path))];
