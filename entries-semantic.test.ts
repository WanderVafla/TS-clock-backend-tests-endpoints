// Semantic round-trips for time entries (issue #6) and entry/label links.
// Complements the adversarial engine suite: where the engine checks envelopes
// and shapes, this file checks MEANING — the entry stores what was sent, the
// start/finish toggle works, links resolve through both filters, and deletes
// cascade. Strict oracle: schema-valid must never 5xx, not-found must 404.
// Known-red cases stay red and are recorded in REPORT.md (F3-F5).
//
// Fixture rule (see REPORT.md §7): every test builds its own project (POST
// /entiers toggles the last entry of the project, so sharing one project
// between tests would couple their state). Everything created is deleted in
// afterAll; pre-existing rows are never touched.
import { describe, test, beforeAll, afterAll, expect } from "bun:test";
import * as v from "valibot";
import {
  EntiersSchema,
  EntryLabelLinkSchema,
} from "../../src/entries/entries.schema";
import { preflight, rng, send, type Resp } from "./engine";

const MISSING_ID = 900000001;

function sfx(tag: string): string {
  return `${tag}-${Math.floor(rng() * 0xffffff).toString(16)}`;
}

const projects: number[] = [];
const entries: number[] = [];
const labels: number[] = [];

type Data = { data?: unknown };

function dataOf(r: Resp, what: string): unknown {
  if (r.status < 200 || r.status >= 300) {
    throw new Error(`${what} -> ${r.status} ${r.text.slice(0, 200)}`);
  }
  return (r.json as Data)?.data;
}

type Entier = v.InferOutput<typeof EntiersSchema>;

function expectEntier(row: unknown, what: string): Entier {
  const parsed = v.safeParse(EntiersSchema, row);
  if (!parsed.success) {
    throw new Error(`${what} shape: ${v.summarize(parsed.issues)}`);
  }
  return parsed.output;
}

function expectLink(row: unknown, what: string): void {
  const parsed = v.safeParse(EntryLabelLinkSchema, row);
  if (!parsed.success) {
    throw new Error(`${what} shape: ${v.summarize(parsed.issues)}`);
  }
}

async function freshProject(tag: string): Promise<number> {
  const r = await send("POST", "/projects", { name: sfx(`sem-proj-${tag}`) });
  const id = (dataOf(r, "POST /projects") as { id?: unknown })?.id;
  if (typeof id !== "number") throw new Error("POST /projects: no numeric id");
  projects.push(id);
  return id;
}

async function freshEntry(projectId: number, tag: string): Promise<Entier> {
  const r = await send("POST", "/entiers", {
    project_id: projectId,
    description: sfx(`sem-entry-${tag}`),
  });
  const row = expectEntier(dataOf(r, "POST /entiers"), "POST /entiers");
  entries.push(row.id);
  return row;
}

async function freshLabel(tag: string): Promise<number> {
  const r = await send("POST", "/labels", { name: sfx(`sem-label-${tag}`) });
  const id = (dataOf(r, "POST /labels") as { id?: unknown })?.id;
  if (typeof id !== "number") throw new Error("POST /labels: no numeric id");
  labels.push(id);
  return id;
}

async function listLinks(query: string): Promise<unknown[]> {
  const r = await send("GET", `/entiers/labels${query}`);
  const data = dataOf(r, `GET /entiers/labels${query}`);
  if (!Array.isArray(data)) throw new Error("links list: data is not array");
  return data;
}

let sharedLabelId = 0;

beforeAll(async () => {
  await preflight();
  sharedLabelId = await freshLabel("shared");
});

afterAll(async () => {
  for (const id of [...new Set(entries)]) {
    try {
      await send("DELETE", `/entiers?id=${id}`);
    } catch {
      // best effort; leftovers are reported, not thrown
    }
  }
  for (const id of [...new Set(labels)]) {
    try {
      await send("DELETE", `/labels?id=${id}`);
    } catch {
      // best effort
    }
  }
  for (const id of [...new Set(projects)]) {
    try {
      await send("DELETE", `/projects?id=${id}`);
    } catch {
      // best effort
    }
  }
  console.log(
    `semantic cleanup: entries=${entries.length} labels=${labels.length} projects=${projects.length}`,
  );
});

describe("entries semantic (issue #6)", () => {
  test("create persists description", async () => {
    const projectId = await freshProject("descr");
    const sent = sfx("descr-sent");
    const r = await send("POST", "/entiers", {
      project_id: projectId,
      description: sent,
    });
    const created = expectEntier(dataOf(r, "POST /entiers"), "created");
    entries.push(created.id);
    // Issue #6: "Each entry stores ... a description". F5 if the handler
    // drops it (startEntier inserts project_id only).
    expect(created.description).toBe(sent);
  });

  test("second POST finishes the open entry (toggle)", async () => {
    const projectId = await freshProject("toggle");
    const first = await freshEntry(projectId, "toggle");
    expect(first.end_time == null).toBe(true);
    const r = await send("POST", "/entiers", { project_id: projectId });
    const second = expectEntier(dataOf(r, "POST /entiers#2"), "finished");
    expect(second.id).toBe(first.id);
    expect(second.end_time == null).toBe(false);
    expect(
      new Date(second.end_time as string).getTime(),
    ).toBeGreaterThanOrEqual(new Date(first.start_time).getTime());
  });

  test("link round-trip resolves through both filters", async () => {
    const projectId = await freshProject("link");
    const entry = await freshEntry(projectId, "link");
    const r = await send("POST", "/entiers/labels", {
      time_entry_id: entry.id,
      label_id: sharedLabelId,
    });
    expectLink(dataOf(r, "POST /entiers/labels"), "POST /entiers/labels");
    const byEntry = await listLinks(`?time_entry_id=${entry.id}`);
    expect(
      byEntry.some(
        (x) =>
          (x as { time_entry_id?: unknown }).time_entry_id === entry.id &&
          (x as { label_id?: unknown }).label_id === sharedLabelId,
      ),
    ).toBe(true);
    const byLabel = await listLinks(`?label_id=${sharedLabelId}`);
    expect(
      byLabel.some(
        (x) =>
          (x as { time_entry_id?: unknown }).time_entry_id === entry.id &&
          (x as { label_id?: unknown }).label_id === sharedLabelId,
      ),
    ).toBe(true);
  });

  test("delete entry cascades its links, label survives", async () => {
    const projectId = await freshProject("cascade");
    const entry = await freshEntry(projectId, "cascade");
    const labelId = await freshLabel("cascade");
    const link = await send("POST", "/entiers/labels", {
      time_entry_id: entry.id,
      label_id: labelId,
    });
    if (link.status < 200 || link.status >= 300) {
      throw new Error(`link setup -> ${link.status} ${link.text.slice(0, 200)}`);
    }
    const del = await send("DELETE", `/entiers?id=${entry.id}`);
    if (del.status < 200 || del.status >= 300) {
      throw new Error(`DELETE entry -> ${del.status}`);
    }
    const byEntry = await listLinks(`?time_entry_id=${entry.id}`);
    expect(byEntry.length).toBe(0);
    const lab = await send("GET", "/labels");
    const items = dataOf(lab, "GET /labels") as unknown[];
    if (!Array.isArray(items)) throw new Error("labels list: not array");
    expect(items.some((x) => (x as { id?: unknown })?.id === labelId)).toBe(
      true,
    );
  });

  test("duplicate link never 5xx (strict oracle, REPORT F4)", async () => {
    const projectId = await freshProject("dupe");
    const entry = await freshEntry(projectId, "dupe");
    const pair = { time_entry_id: entry.id, label_id: sharedLabelId };
    const first = await send("POST", "/entiers/labels", pair);
    if (first.status < 200 || first.status >= 300) {
      throw new Error(`first link -> ${first.status} ${first.text.slice(0, 200)}`);
    }
    const second = await send("POST", "/entiers/labels", pair);
    expect(second.status).toBeLessThan(500);
  });

  test("GET entry by missing id -> 404 (strict oracle, REPORT F3)", async () => {
    const r = await send("GET", `/entiers?id=${MISSING_ID}`);
    expect(r.status).toBe(404);
  });

  test("PATCH missing entry -> 404; end_time < start_time -> no 5xx", async () => {
    const ghost = await send("PATCH", "/entiers", {
      id: MISSING_ID,
      description: "sem-ghost",
    });
    expect(ghost.status).toBe(404);
    const projectId = await freshProject("patch");
    const entry = await freshEntry(projectId, "patch");
    const bad = await send("PATCH", "/entiers", {
      id: entry.id,
      start_time: new Date("2026-10-02T10:00:00.000Z").toISOString(),
      end_time: new Date("2026-10-01T10:00:00.000Z").toISOString(),
    });
    // Oracle-correct assertion: UpdateEntiersSchema has NO end>=start check,
    // so the payload is schema-valid and the server must not 5xx (REPORT F6).
    expect(bad.status).toBeLessThan(500);
    const good = await send("PATCH", "/entiers", {
      id: entry.id,
      description: sfx("patched"),
    });
    expectEntier(dataOf(good, "PATCH /entiers"), "patched");
  });

  test("link filters: invalid id -> 4xx, missing pair -> 200 []", async () => {
    const bad = await send("GET", "/entiers/labels?label_id=abc");
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(bad.status).toBeLessThan(500);
    const empty = await send(
      "GET",
      `/entiers/labels?time_entry_id=${MISSING_ID}`,
    );
    if (empty.status < 200 || empty.status >= 300) {
      throw new Error(`missing pair -> ${empty.status}`);
    }
    expect((empty.json as Data)?.data).toEqual([]);
  });
});
