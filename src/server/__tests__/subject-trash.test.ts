import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRepository } from "@/data/memory-repository";
import type { Character, Location } from "@/domain/schemas";

/**
 * Characters and Locations in the Trash, through the REAL actions and the REAL project loaders (memory mode): a
 * deleted one is hidden everywhere with everything attached to it kept, Restore brings it back exactly, and it is
 * deleted for good only from the Trash or after 30 days. One the story still uses is refused, with where.
 */
vi.hoisted(() => {
  process.env.PRISM_STUDIO_PERSISTENCE = "memory";
});
const world = vi.hoisted(() => ({ redirects: [] as string[] }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((to: string) => void world.redirects.push(to)),
  notFound: vi.fn(() => {
    throw new Error("not found");
  }),
}));
vi.mock("@/server/auth", () => ({
  requireUser: async () => ({ kind: "memory", id: "tester" }),
  getCurrentUser: async () => null,
}));

import { requireProjectFresh } from "../repo";
import { deleteSubjectNow, emptyTrash, moveToTrash, restoreSubject, trashSubject } from "../trash-actions";
import { removeShotInput } from "../actions";
import { purgeExpiredTrash } from "../trash";
import { loadLibrary } from "../character-library";

const SLUG = "ojousama";
let repo: MemoryRepository;
beforeEach(() => {
  repo = new MemoryRepository();
  globalThis.__prismMemoryRepo = repo;
  world.redirects = [];
});
afterEach(() => vi.clearAllMocks());

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries({ projectSlug: SLUG, ...fields })) f.set(k, v);
  return f;
};
const loaded = () => requireProjectFresh(SLUG);
const raw = async () => (await repo.loadProject(SLUG))!;

/** A Character nothing in the story uses, with a reference slot, a Look and a voice. */
async function looseCharacter(): Promise<Character> {
  const d = await raw();
  const base = d.characters[0]!;
  const c: Character = { ...base, id: randomUUID(), name: "Extra Waiter" };
  await repo.upsert(d.project.id, "characters", c);
  await repo.upsert(d.project.id, "identityRefs", {
    ...d.identityRefs[0]!,
    id: randomUUID(),
    characterId: c.id,
  });
  await repo.upsert(d.project.id, "looks", { ...d.looks[0]!, id: randomUUID(), characterId: c.id });
  await repo.upsert(d.project.id, "voiceProfiles", {
    ...d.voiceProfiles[0]!,
    id: randomUUID(),
    characterId: c.id,
  });
  return c;
}

describe("Characters in the Trash", () => {
  it("one the story uses is refused, with where", async () => {
    const d = await loaded();
    const used = d.characters.find((c) =>
      d.shots.some((s) => s.characters.some((x) => x.characterId === c.id)),
    )!;
    const r = await trashSubject(form({ kind: "character", id: used.id }));
    expect(r).toMatchObject({
      ok: false,
      error: expect.stringMatching(/can't be deleted yet: it is still used in .*Shot/),
    });
    expect((await loaded()).characters.some((c) => c.id === used.id)).toBe(true);
  });

  it("Delete hides it (and what hangs off it) everywhere, keeping everything; Restore brings it back exactly", async () => {
    const c = await looseCharacter();
    const before = await raw();
    const own = (d: typeof before) => ({
      refs: d.identityRefs.filter((r) => r.characterId === c.id),
      looks: d.looks.filter((l) => l.characterId === c.id),
      voices: d.voiceProfiles.filter((v) => v.characterId === c.id),
    });
    expect(await trashSubject(form({ kind: "character", id: c.id }))).toEqual({ ok: true });
    expect(world.redirects.at(-1)).toBe(`/projects/${SLUG}/characters`);
    const d = await loaded();
    expect(d.characters.some((x) => x.id === c.id)).toBe(false);
    expect(d.identityRefs.some((r) => r.characterId === c.id)).toBe(false);
    expect(d.looks.some((l) => l.characterId === c.id)).toBe(false);
    expect(d.voiceProfiles.some((v) => v.characterId === c.id)).toBe(false);
    expect(d.trashedCharacters!.map((x) => x.id)).toEqual([c.id]);
    // kept, untouched
    expect(own(await raw())).toEqual(own(before));
    expect(await trashSubject(form({ kind: "character", id: c.id }))).toMatchObject({ ok: false });

    expect(await restoreSubject(form({ kind: "character", id: c.id }))).toEqual({ ok: true });
    const back = await loaded();
    expect(back.characters.find((x) => x.id === c.id)).toMatchObject({
      name: "Extra Waiter",
      trashedAt: null,
    });
    expect(own(back)).toEqual(own(before));
    expect(back.trashedCharacters).toBeUndefined();
  });

  it("Delete now (confirmed) removes it with its references, Looks and voices", async () => {
    const c = await looseCharacter();
    await trashSubject(form({ kind: "character", id: c.id }));
    expect(await deleteSubjectNow(form({ kind: "character", id: c.id }))).toMatchObject({
      ok: false,
      error: "Confirm that you want to delete it for good.",
    });
    expect(await deleteSubjectNow(form({ kind: "character", id: c.id, confirm: "1" }))).toEqual({ ok: true });
    const d = await raw();
    expect(d.characters.some((x) => x.id === c.id)).toBe(false);
    expect(d.identityRefs.some((r) => r.characterId === c.id)).toBe(false);
    expect(d.looks.some((l) => l.characterId === c.id)).toBe(false);
    expect(d.voiceProfiles.some((v) => v.characterId === c.id)).toBe(false);
  });

  it("after 30 days in the Trash it is deleted for good when the project is opened; before that it stays", async () => {
    const c = await looseCharacter();
    await trashSubject(form({ kind: "character", id: c.id }));
    const day = 24 * 60 * 60 * 1000;
    expect(await purgeExpiredTrash(await loaded(), new Date(Date.now() + 29 * day).toISOString())).toBe(0);
    expect((await raw()).characters.some((x) => x.id === c.id)).toBe(true);
    expect(await purgeExpiredTrash(await loaded(), new Date(Date.now() + 31 * day).toISOString())).toBe(1);
    expect((await raw()).characters.some((x) => x.id === c.id)).toBe(false);
  });

  it("a Character in the Trash is out of the library until it is restored", async () => {
    const c = await looseCharacter();
    await repo.setInLibrary((await raw()).project.id, c.id, true);
    expect((await loadLibrary()).characters.map((x) => x.name)).toEqual(["Extra Waiter"]);
    await trashSubject(form({ kind: "character", id: c.id }));
    expect((await loadLibrary()).characters).toEqual([]);
    await restoreSubject(form({ kind: "character", id: c.id }));
    expect((await loadLibrary()).characters.map((x) => x.name)).toEqual(["Extra Waiter"]);
  });
});

describe("Locations in the Trash", () => {
  async function looseLocation(): Promise<Location> {
    const d = await raw();
    const l: Location = { ...d.locations[0]!, id: randomUUID(), name: "Back Alley", locked: false };
    await repo.upsert(d.project.id, "locations", l);
    return l;
  }

  it("one a Scene or Shot uses is refused with where; a locked one is refused", async () => {
    const d = await loaded();
    const used = d.locations.find((l) => d.scenes.some((s) => s.locationId === l.id))!;
    if (used.locked) await repo.upsert(d.project.id, "locations", { ...used, locked: false });
    expect(await trashSubject(form({ kind: "location", id: used.id }))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/can't be deleted yet: it is still used in .*Scene/),
    });
    const free = await looseLocation();
    await repo.upsert(d.project.id, "locations", { ...free, locked: true });
    expect(await trashSubject(form({ kind: "location", id: free.id }))).toMatchObject({
      ok: false,
      error: `"Back Alley" is locked. Unlock it before deleting it.`,
    });
  });

  it("Delete hides it; Restore brings it back; Empty trash deletes it for good", async () => {
    const l = await looseLocation();
    expect(await trashSubject(form({ kind: "location", id: l.id }))).toEqual({ ok: true });
    expect(world.redirects.at(-1)).toBe(`/projects/${SLUG}/locations`);
    expect((await loaded()).locations.some((x) => x.id === l.id)).toBe(false);
    expect(await restoreSubject(form({ kind: "location", id: l.id }))).toEqual({ ok: true });
    expect((await loaded()).locations.find((x) => x.id === l.id)).toMatchObject({ name: "Back Alley" });
    await trashSubject(form({ kind: "location", id: l.id }));
    expect(await emptyTrash(form({ confirm: "1" }))).toMatchObject({ ok: true, message: "1 deleted." });
    expect((await raw()).locations.some((x) => x.id === l.id)).toBe(false);
  });
});

describe("a picture a Shot is made from", () => {
  it("can't be deleted until it is taken off the Shot; then it can (the Shot just goes without it)", async () => {
    const d = await raw();
    const shot = d.shots[0]!;
    const pic = { ...d.assets[0]!, id: randomUUID(), type: "image" as const, objectPath: null, metadata: {} };
    await repo.upsert(d.project.id, "assets", pic);
    await repo.upsert(d.project.id, "shots", {
      ...shot,
      status: "draft",
      generation: { ...shot.generation, referenceAssetIds: [...shot.generation.referenceAssetIds, pic.id] },
    });
    const del = () => moveToTrash(form({ assetId: pic.id }));
    expect(await del()).toMatchObject({
      ok: false,
      error: expect.stringContaining(`Shot ${shot.shotCode} · generation reference`),
    });
    expect(await del()).toMatchObject({
      error: expect.stringContaining('use "Remove from this Shot" first'),
    });
    // a locked Shot keeps its inputs
    await repo.upsert(d.project.id, "shots", {
      ...(await raw()).shots.find((s) => s.id === shot.id)!,
      status: "locked",
    });
    const remove = () => removeShotInput(form({ shotId: shot.id, role: "reference", assetId: pic.id }));
    expect(await remove()).toMatchObject({ ok: false, error: expect.stringContaining("locked") });
    await repo.upsert(d.project.id, "shots", {
      ...(await raw()).shots.find((s) => s.id === shot.id)!,
      status: "draft",
    });
    expect(await remove()).toEqual({ ok: true });
    const after = (await raw()).shots.find((s) => s.id === shot.id)!;
    expect(after.generation.referenceAssetIds).not.toContain(pic.id);
    expect(after.generation.referenceAssetIds).toEqual(shot.generation.referenceAssetIds);
    expect(await remove()).toMatchObject({ ok: false, error: "That picture is no longer on this Shot." });
    expect(await del()).toEqual({ ok: true });
  });
});
