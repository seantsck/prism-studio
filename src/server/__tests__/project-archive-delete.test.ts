import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRepository } from "@/data/memory-repository";

/**
 * Archiving and deleting projects from the Projects list, through the REAL actions on the memory store: archive hides
 * and restore brings back with nothing lost; delete needs the exact title, waits for unfinished work, removes the
 * project and its stored files.
 */
vi.hoisted(() => {
  process.env.PRISM_STUDIO_INLINE_WORKER = "0";
  process.env.PRISM_STUDIO_ENABLE_MOCK_PROVIDER = "1";
  process.env.PRISM_STUDIO_STORY_AI_PROVIDERS = "openai";
  delete process.env.PRISM_STUDIO_ALLOW_PAID_STORY_AI;
});
const world = vi.hoisted(() => ({
  repo: null as unknown,
  files: new Map<string, Uint8Array>(),
  redirects: [] as string[],
}));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((to: string) => void world.redirects.push(to)),
  notFound: vi.fn(),
}));
vi.mock("@/server/auth", () => ({ requireUser: async () => ({ kind: "memory", id: "tester" }) }));
vi.mock("@/server/repo", async () => {
  const { UserFacingError } = await import("@/server/action-result");
  return {
    getRepo: async () => world.repo,
    requireProjectFresh: async (slug: string) => {
      const data = await (world.repo as MemoryRepository).loadProject(slug);
      if (!data) throw new UserFacingError("That project no longer exists.");
      return data;
    },
  };
});
vi.mock("@/server/storage", () => {
  const store = {
    name: "local" as const,
    bucket: null,
    put: async (p: string, b: Uint8Array) => void world.files.set(p, new Uint8Array(b)),
    get: async (p: string) => world.files.get(p) ?? null,
    remove: async (p: string) => void world.files.delete(p),
  };
  return {
    getUploadStorage: async () => store,
    storageForAsset: async () => store,
    checksum: (b: Uint8Array) => createHash("sha256").update(b).digest("hex"),
  };
});

import { archiveProject, deleteProject } from "../actions";
import { analyzeStory } from "../story-actions";

const SLUG = "ojousama";
let repo: MemoryRepository;
beforeEach(() => {
  repo = new MemoryRepository();
  world.repo = repo;
  world.files.clear();
  world.redirects = [];
});
afterEach(() => vi.clearAllMocks());

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries({ projectSlug: SLUG, ...fields })) f.set(k, v);
  return f;
};
const project = async () => (await repo.listProjects()).find((p) => p.slug === SLUG)!;

describe("archiving a project", () => {
  it("hides it from the list with everything kept; Restore brings it back unchanged", async () => {
    const before = (await repo.loadProject(SLUG))!;
    expect(await archiveProject(form({ archived: "1" }))).toEqual({ ok: true });
    expect((await repo.archivedProjectIds()).ids.has(before.project.id)).toBe(true);
    // still all there, and still openable
    expect(await repo.loadProject(SLUG)).toEqual(before);
    expect(await archiveProject(form({ archived: "0" }))).toEqual({ ok: true });
    expect((await repo.archivedProjectIds()).ids.size).toBe(0);
  });

  it("refuses a project that isn't one of the owner's", async () => {
    expect(await archiveProject(form({ projectSlug: "nope", archived: "1" }))).toMatchObject({
      ok: false,
      error: "That project no longer exists.",
    });
  });
});

describe("deleting a project", () => {
  it("needs the exact title typed", async () => {
    const p = await project();
    for (const typed of ["", "wrong", p.title.slice(0, -1)])
      expect(await deleteProject(form({ confirmTitle: typed }))).toMatchObject({
        ok: false,
        error: `Type the project's title exactly ("${p.title}") to delete it.`,
      });
    expect(await repo.loadProject(SLUG)).not.toBeNull();
  });

  it("waits while work for the project is still queued or running", async () => {
    const data = (await repo.loadProject(SLUG))!;
    const episode = data.episodes.find((e) => e.scriptText.trim())!;
    expect(
      await analyzeStory(
        form({ sourceMode: "episode", episodeId: episode.id, model: "prism-test/screenplay-parser-v1" }),
      ),
    ).toMatchObject({ ok: true });
    const p = await project();
    expect(await deleteProject(form({ confirmTitle: p.title }))).toMatchObject({
      ok: false,
      error: expect.stringContaining("still has work in progress (1 story analysis)"),
    });
    expect(await repo.loadProject(SLUG)).not.toBeNull();
  });

  it("deletes the project, everything in it and its stored files, then opens the Projects list", async () => {
    const data = (await repo.loadProject(SLUG))!;
    // a stored file of one of its assets
    const asset = {
      ...data.assets[0]!,
      id: "00000000-0000-4000-9000-00000000f11e",
      storageProvider: "local" as const,
      objectPath: `${data.project.id}/stored.png`,
    };
    await repo.upsert(data.project.id, "assets", asset);
    world.files.set(asset.objectPath, new Uint8Array([1, 2, 3]));
    await archiveProject(form({ archived: "1" })); // an archived project can be deleted too
    expect(await deleteProject(form({ confirmTitle: `  ${data.project.title} ` }))).toEqual({ ok: true });
    expect(await repo.loadProject(SLUG)).toBeNull();
    expect((await repo.listProjects()).some((p) => p.id === data.project.id)).toBe(false);
    expect((await repo.archivedProjectIds()).ids.size).toBe(0);
    expect(world.files.has(asset.objectPath!)).toBe(false);
    expect(world.redirects.at(-1)).toBe("/");
    // and it is gone for good: a second delete finds nothing
    expect(await deleteProject(form({ confirmTitle: data.project.title }))).toMatchObject({
      ok: false,
      error: "That project no longer exists.",
    });
  });
});
