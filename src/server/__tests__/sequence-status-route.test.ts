import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { world } from "@/domain/continuity/__tests__/cut-fixtures";
import { MemoryRepository } from "@/data/memory-repository";

/**
 * Phase 3A.4F: the Supervisor's status route, over the real memory repositories. Only the session is mocked. Nothing here
 * reaches a provider. Jobs are placed in the shared stores as Shot QA and other edits would leave them.
 */
vi.setConfig({ testTimeout: 60_000 });
vi.mock("server-only", () => ({}));
const session = vi.hoisted(() => ({ user: { id: "u" } as { id: string } | null, repo: null as unknown }));
vi.mock("@/server/auth", () => ({ getCurrentUser: async () => session.user }));
vi.mock("@/server/repo", () => ({ getRepo: async () => session.repo }));
vi.mock("@/server/episode-edits", () => ({
  getEpisodeEditRepo: async () => (session.repo as MemoryRepository).episodeEdits,
}));
vi.mock("@/server/media-qa", () => ({
  getMediaQaRepo: async () => (session.repo as MemoryRepository).mediaQa,
}));
const { GET } = await import("@/app/api/projects/[project]/continuity/sequence-status/route");

type Stores = {
  jobs: Map<string, Record<string, unknown>>;
  transitionSubjects: Array<Record<string, unknown>>;
};

async function setup() {
  const w = world();
  const repo = new MemoryRepository([w.data]);
  session.repo = repo;
  session.user = { id: "u" };
  const edit = await repo.episodeEdits.create({
    projectId: w.data.project.id,
    episodeId: w.data.episodes[0]!.id,
    editRate: { num: 24, den: 1 },
    items: [],
    userId: null,
    now: new Date().toISOString(),
  });
  const stores = repo.mediaQa as unknown as Stores;
  const job = (o: {
    kind: "attempt" | "transition";
    status?: string;
    editId?: string;
    projectId?: string;
  }) => {
    const id = randomUUID();
    const runId = randomUUID();
    stores.jobs.set(id, {
      id,
      projectId: o.projectId ?? w.data.project.id,
      runId,
      subjectKind: o.kind,
      status: o.status ?? "queued",
      createdAt: new Date().toISOString(),
      inputSnapshot: { secret: "SNAPSHOT-PAYLOAD" },
      providerRef: "PROVIDER-REF",
      idempotencyKey: "KEY",
    });
    if (o.editId)
      stores.transitionSubjects.push({
        runId,
        projectId: o.projectId ?? w.data.project.id,
        editId: o.editId,
      });
    return id;
  };
  const setStatus = (id: string, status: string) => void (stores.jobs.get(id)!.status = status);
  const read = (slug = w.data.project.slug, editId: string | null = edit.id) =>
    GET(new Request(`http://x/api?${editId ? `edit=${editId}` : ""}`), {
      params: Promise.resolve({ project: slug }),
    });
  const body = async () =>
    (await (await read()).json()) as {
      signature: string;
      edit: { active: number; jobs: Array<{ id: string; status: string }> };
      project: { active: number; jobs: Array<{ id: string; subjectKind: string; status: string }> };
    };
  return { edit, job, setStatus, read, body, slug: w.data.project.slug };
}

describe("access", () => {
  beforeEach(() => undefined);

  it("an unauthenticated request is refused", async () => {
    const s = await setup();
    session.user = null;
    expect((await s.read()).status).toBe(401);
  });

  it("a Project the caller cannot see, or a malformed one, is not found", async () => {
    const s = await setup();
    expect((await s.read("no-such-project")).status).toBe(404);
    expect((await s.read("Bad Slug!")).status).toBe(404);
  });

  it("an edit that is not this Project's, or a malformed or missing one, is not found", async () => {
    const s = await setup();
    expect((await s.read(s.slug, randomUUID())).status).toBe(404);
    expect((await s.read(s.slug, "not-a-uuid")).status).toBe(404);
    expect((await s.read(s.slug, null)).status).toBe(404);
  });

  it("the owner reads safe status, uncached", async () => {
    const s = await setup();
    const r = await s.read();
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toContain("no-store");
    expect(await r.json()).toMatchObject({ edit: { active: 0 }, project: { active: 0 } });
  });
});

describe("what it returns", () => {
  it("no provider payload, snapshot, reference, key or credential", async () => {
    const s = await setup();
    s.job({ kind: "transition", editId: s.edit.id });
    s.job({ kind: "attempt" });
    const text = await (await s.read()).text();
    expect(text).not.toMatch(/SNAPSHOT-PAYLOAD|PROVIDER-REF|inputSnapshot|providerRef|idempotencyKey|KEY/);
    const body = JSON.parse(text) as { edit: { jobs: object[] }; project: { jobs: object[] } };
    for (const j of body.edit.jobs) expect(Object.keys(j).sort()).toEqual(["id", "status"]);
    for (const j of body.project.jobs) expect(Object.keys(j).sort()).toEqual(["id", "status", "subjectKind"]);
  });

  it("this edit's transition jobs are represented, active or finished", async () => {
    const s = await setup();
    const id = s.job({ kind: "transition", editId: s.edit.id, status: "processing" });
    expect(await s.body()).toMatchObject({
      edit: { active: 1, jobs: [{ id, status: "processing" }] },
      project: { active: 1 },
    });
    s.setStatus(id, "succeeded");
    expect(await s.body()).toMatchObject({
      edit: { active: 0, jobs: [{ id, status: "succeeded" }] },
      project: { active: 0, jobs: [] },
    });
  });

  it("an active Shot QA job counts toward the Project, not this edit", async () => {
    const s = await setup();
    const before = (await s.body()).signature;
    const id = s.job({ kind: "attempt", status: "processing" });
    const b = await s.body();
    expect(b.edit.active).toBe(0);
    expect(b.project).toEqual({ active: 1, jobs: [{ id, subjectKind: "attempt", status: "processing" }] });
    expect(b.signature).not.toBe(before);
  });

  it("another edit's Sequence job counts toward the Project, not this edit", async () => {
    const s = await setup();
    const id = s.job({ kind: "transition", editId: randomUUID() });
    const b = await s.body();
    expect(b.edit).toEqual({ active: 0, jobs: [] });
    expect(b.project.jobs).toEqual([{ id, subjectKind: "transition", status: "queued" }]);
  });

  it.each(["succeeded", "failed", "cancelled"])(
    "a %s job stops consuming capacity, and the signature moves",
    async (done) => {
      const s = await setup();
      const id = s.job({ kind: "attempt", status: "processing" });
      const before = await s.body();
      s.setStatus(id, done);
      const after = await s.body();
      expect(after.project).toEqual({ active: 0, jobs: [] });
      expect(after.signature).not.toBe(before.signature);
    },
  );

  it("another Project's job is invisible", async () => {
    const s = await setup();
    const before = (await s.body()).signature;
    s.job({ kind: "attempt", projectId: randomUUID() });
    expect((await s.body()).signature).toBe(before);
  });

  it("a read changes nothing", async () => {
    const s = await setup();
    s.job({ kind: "attempt" });
    const a = await s.body();
    expect(await s.body()).toEqual(a);
  });
});
