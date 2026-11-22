import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRepository } from "@/data/memory-repository";
import { buildSeedProject } from "@/data/seed";
import { freeCharacterName, planCharacterCopy } from "@/domain/character-library";
import type { Asset, ProjectData } from "@/domain/schemas";

/**
 * The account's character library, through the REAL actions and memory repository with an in-memory store for the
 * bytes: a Character saved from one project is added to another as an independent copy (new ids, its pictures copied
 * into the target's own storage), and nothing of the source changes.
 */
const world = vi.hoisted(() => ({
  repo: null as unknown,
  files: new Map<string, Uint8Array>(),
  /** Puts that succeed before the next one fails (null: none fails). */
  failAfter: null as number | null,
}));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
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
    put: async (p: string, b: Uint8Array) => {
      if (world.failAfter !== null && world.failAfter-- <= 0) throw new Error("disk full");
      world.files.set(p, new Uint8Array(b));
    },
    get: async (p: string) => world.files.get(p) ?? null,
    signedUrl: async () => null,
    remove: async (p: string) => void world.files.delete(p),
  };
  return {
    getUploadStorage: async () => store,
    storageForAsset: async (a: { objectPath: string | null }) => (a.objectPath ? store : null),
    checksum: (b: Uint8Array) => createHash("sha256").update(b).digest("hex"),
  };
});

import { addFromLibrary, setCharacterInLibrary } from "../library-actions";
import { loadLibrary } from "../character-library";

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

let repo: MemoryRepository;
let source: ProjectData;
let target: ProjectData;
const BYTES = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);

/** A stored picture in `data`'s project (bytes in the store). */
function storedPicture(data: ProjectData, name: string, extra: Partial<Asset> = {}): Asset {
  const id = randomUUID();
  const objectPath = `${data.project.id}/${id}/${name}`;
  world.files.set(objectPath, BYTES);
  return {
    ...data.assets[0]!,
    id,
    projectId: data.project.id,
    type: "image",
    purpose: "identity_ref",
    source: "upload",
    name,
    originalFilename: name,
    storageProvider: "local",
    bucket: null,
    objectPath,
    mime: "image/png",
    byteSize: BYTES.length,
    metadata: {},
    ...extra,
  };
}

beforeEach(async () => {
  world.files = new Map();
  world.failAfter = null;
  const seed = buildSeedProject();
  repo = new MemoryRepository([seed]);
  world.repo = repo;
  source = (await repo.loadProject(seed.project.slug))!;
  // Yumeko's front reference is a real stored photo; her Look has a wardrobe picture (shared with the 3/4 slot), and an
  // archived picture that must stay behind
  const yumeko = source.characters.find((c) => c.name === "Yumeko")!;
  const front = storedPicture(source, "front.png");
  const wardrobe = storedPicture(source, "gown.png", { source: "generated" });
  const archived = storedPicture(source, "old.png", { metadata: { archived: { at: "2026-11-01" } } });
  await repo.upsertMany(source.project.id, "assets", [front, wardrobe, archived]);
  const refs = source.identityRefs.filter((r) => r.characterId === yumeko.id);
  const bySlot = (slot: string) => refs.find((r) => r.slot === slot)!;
  await repo.upsert(source.project.id, "identityRefs", {
    ...bySlot("front"),
    assetId: front.id,
    metadata: { visualRole: "canonical" },
  });
  await repo.upsert(source.project.id, "identityRefs", { ...bySlot("three_quarter"), assetId: wardrobe.id });
  await repo.upsert(source.project.id, "identityRefs", { ...bySlot("profile"), assetId: archived.id });
  const look = source.looks.find((l) => l.characterId === yumeko.id)!;
  await repo.upsert(source.project.id, "looks", { ...look, referenceAssetIds: [wardrobe.id, archived.id] });
  source = (await repo.loadProject(seed.project.slug))!;
  // a second project of the same creator, with a Character already called Yumeko
  const other = buildSeedProject();
  const projectId = randomUUID();
  await repo.createProject(
    { ...other.project, id: projectId, slug: "second-show", title: "Second Show" },
    { ...other.bible, projectId },
  );
  target = (await repo.loadProject("second-show"))!;
  await repo.upsert(target.project.id, "characters", {
    ...other.characters[0]!,
    id: randomUUID(),
    projectId: target.project.id,
    name: "Yumeko",
  });
  target = (await repo.loadProject("second-show"))!;
});
afterEach(() => vi.clearAllMocks());

const yumekoOf = (d: ProjectData) => d.characters.find((c) => c.name === "Yumeko")!;

describe("the character library", () => {
  it("plans an independent copy: new ids, the target's project, each picture once, nothing archived", () => {
    const yumeko = yumekoOf(source);
    const plan = planCharacterCopy(source, yumeko.id, target, randomUUID, "2026-11-22T00:00:00.000Z");
    expect(plan.character).toMatchObject({ projectId: target.project.id, name: "Yumeko (2)" });
    expect(plan.character.id).not.toBe(yumeko.id);
    // the 3/4 slot and the Look share one picture: copied once; the archived picture stays behind
    expect(plan.assets.map((a) => a.from.name).sort()).toEqual(
      expect.arrayContaining(["front.png", "gown.png"]),
    );
    expect(plan.assets.some((a) => a.from.name === "old.png")).toBe(false);
    expect(new Set(plan.assets.map((a) => a.to.id)).size).toBe(plan.assets.length);
    for (const { from, to } of plan.assets) {
      expect(to).toMatchObject({ projectId: target.project.id, objectPath: null, source: from.source });
      expect(to.metadata).toMatchObject({ copiedFrom: { projectId: source.project.id, assetId: from.id } });
    }
    const ids = new Set(plan.assets.map((a) => a.to.id));
    // the reference whose picture was archived is not copied as an empty slot
    expect(plan.identityRefs.some((r) => r.slot === "profile")).toBe(false);
    for (const r of plan.identityRefs) {
      expect(r.characterId).toBe(plan.character.id);
      if (r.assetId) expect(ids.has(r.assetId)).toBe(true);
    }
    expect(plan.identityRefs.find((r) => r.slot === "front")!.metadata).toEqual({ visualRole: "canonical" });
    expect(plan.looks).toHaveLength(1);
    expect(plan.looks[0]).toMatchObject({ episodeId: null, characterId: plan.character.id });
    expect(plan.looks[0]!.referenceAssetIds).toHaveLength(1);
    expect(ids.has(plan.looks[0]!.referenceAssetIds[0]!)).toBe(true);
    expect(plan.voiceProfiles.every((v) => v.characterId === plan.character.id)).toBe(true);
    expect(freeCharacterName("Sean", [{ name: "sean" }, { name: "Sean (2)" }])).toBe("Sean (3)");
  });

  it("save → add to another project: the copy has its own pictures, the original is untouched", async () => {
    const yumeko = yumekoOf(source);
    expect((await loadLibrary()).characters).toEqual([]);
    expect(
      await setCharacterInLibrary(form({ projectSlug: source.project.slug, characterId: yumeko.id })),
    ).toMatchObject({ ok: true, message: "Yumeko is in your library." });
    // saving twice is harmless
    await setCharacterInLibrary(form({ projectSlug: source.project.slug, characterId: yumeko.id }));
    const lib = await loadLibrary();
    expect(lib).toMatchObject({ available: true });
    expect(lib.characters).toHaveLength(1);
    expect(lib.characters[0]).toMatchObject({
      name: "Yumeko",
      projectTitle: source.project.title,
      projectSlug: source.project.slug,
    });
    expect(lib.characters[0]!.thumbUrl).toMatch(/^\/api\/assets\//);

    // not into its own project
    expect(
      await addFromLibrary(form({ projectSlug: source.project.slug, characterId: yumeko.id })),
    ).toMatchObject({ ok: false, error: "That character already lives in this project." });
    const before = JSON.stringify(await repo.loadProject(source.project.slug));
    const filesBefore = world.files.size;
    expect(await addFromLibrary(form({ projectSlug: "second-show", characterId: yumeko.id }))).toMatchObject({
      ok: true,
      message: "Yumeko (2) added with 2 pictures.",
    });
    const after = (await repo.loadProject("second-show"))!;
    const copy = after.characters.find((c) => c.name === "Yumeko (2)")!;
    expect(copy.physicalDescription).toBe(yumeko.physicalDescription);
    const refs = after.identityRefs.filter((r) => r.characterId === copy.id && r.assetId);
    expect(refs.length).toBeGreaterThan(0);
    for (const r of refs) {
      const a = after.assets.find((x) => x.id === r.assetId)!;
      expect(a.projectId).toBe(after.project.id);
      if (a.objectPath) {
        expect(a.objectPath.startsWith(`${after.project.id}/${a.id}/`)).toBe(true);
        expect(world.files.get(a.objectPath)).toEqual(BYTES);
      }
    }
    expect(world.files.size).toBe(filesBefore + 2);
    expect(after.looks.filter((l) => l.characterId === copy.id)).toHaveLength(1);
    // the source project is exactly as it was
    expect(JSON.stringify(await repo.loadProject(source.project.slug))).toBe(before);

    // out of the library
    expect(
      await setCharacterInLibrary(
        form({ projectSlug: source.project.slug, characterId: yumeko.id, saved: "0" }),
      ),
    ).toMatchObject({ ok: true, message: "Yumeko is out of your library." });
    expect((await loadLibrary()).characters).toEqual([]);
    expect(await addFromLibrary(form({ projectSlug: "second-show", characterId: yumeko.id }))).toMatchObject({
      ok: false,
      error: "That character is not in your library.",
    });
  });

  it("a copy that fails part-way leaves nothing behind", async () => {
    const yumeko = yumekoOf(source);
    await setCharacterInLibrary(form({ projectSlug: source.project.slug, characterId: yumeko.id }));
    const before = (await repo.loadProject("second-show"))!;
    const files = world.files.size;
    world.failAfter = 1; // the first picture is stored, the second cannot be
    const r = await addFromLibrary(form({ projectSlug: "second-show", characterId: yumeko.id }));
    expect(r.ok).toBe(false);
    const after = (await repo.loadProject("second-show"))!;
    expect(after.characters).toHaveLength(before.characters.length);
    expect(after.assets).toHaveLength(before.assets.length);
    expect(after.identityRefs).toHaveLength(before.identityRefs.length);
    expect(world.files.size).toBe(files);
  });

  it("a copy that fails after its records are written removes them again (and the copied bytes)", async () => {
    const yumeko = yumekoOf(source);
    await setCharacterInLibrary(form({ projectSlug: source.project.slug, characterId: yumeko.id }));
    const before = (await repo.loadProject("second-show"))!;
    const files = world.files.size;
    const upsertMany = repo.upsertMany.bind(repo);
    vi.spyOn(repo, "upsertMany").mockImplementation(async (projectId, name, items) => {
      if (name === "looks") throw new Error("database went away");
      return upsertMany(projectId, name, items as never);
    });
    expect((await addFromLibrary(form({ projectSlug: "second-show", characterId: yumeko.id }))).ok).toBe(
      false,
    );
    const after = (await repo.loadProject("second-show"))!;
    expect(after.characters).toHaveLength(before.characters.length);
    expect(after.assets).toHaveLength(before.assets.length);
    expect(after.identityRefs).toHaveLength(before.identityRefs.length);
    expect(after.looks).toHaveLength(before.looks.length);
    expect(world.files.size).toBe(files);
  });

  it("deleting the project a library Character lives in takes it out of the library; copies stay", async () => {
    const yumeko = yumekoOf(source);
    await setCharacterInLibrary(form({ projectSlug: source.project.slug, characterId: yumeko.id }));
    await addFromLibrary(form({ projectSlug: "second-show", characterId: yumeko.id }));
    await repo.deleteProject(source.project.id);
    expect((await loadLibrary()).characters).toEqual([]);
    expect((await repo.loadProject("second-show"))!.characters.some((c) => c.name === "Yumeko (2)")).toBe(
      true,
    );
  });
});
