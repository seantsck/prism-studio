import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRepository } from "@/data/memory-repository";
import {
  addLook,
  assignLook,
  characterByName,
  uploadIdentity,
  uploadLookRef,
} from "@/domain/__tests__/character-continuity-fixtures";
import { seed, shotByCode } from "@/domain/__tests__/helpers";
import { newUploadAsset } from "@/domain/__tests__/production-frame-fixtures";
import { MAX_LOCK_REFERENCES } from "@/domain/character-continuity";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

/**
 * Phase 2G.4: an oversized Continuity Lock basis is refused by the real server actions BEFORE anything is written.
 * Memory persistence only: no database, Storage, provider, 3D set or GPU.
 */

const SLUG = "ojousama";

/** Yumeko on Shot 3A in a Look whose usable images total exactly MAX_LOCK_REFERENCES (4 identity + 60 Look). */
function setup() {
  const data = seed();
  for (let i = 0; i < 4; i++) uploadIdentity(data, "Yumeko", "additional", `act-identity-${i}`);
  const look = addLook(data, "Yumeko", "Wide");
  for (let i = 0; i < 60; i++) uploadLookRef(data, look, `act-look-${i}`);
  assignLook(data, "3A", "Yumeko", look);
  const repo = new MemoryRepository([data]);
  globalThis.__prismMemoryRepo = repo;
  return {
    repo,
    projectId: data.project.id,
    yumeko: characterByName(data, "Yumeko"),
    look,
    shotId: shotByCode(data, "3A").id,
  };
}

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

/** One more usable identity image: the basis becomes MAX_LOCK_REFERENCES + 1. */
async function addOneIdentityImage(repo: MemoryRepository, projectId: string, characterId: string) {
  const asset = {
    ...newUploadAsset(projectId, { label: "act-identity-extra", width: 768, height: 1024 }),
    purpose: "identity_ref" as const,
  };
  await repo.upsert(projectId, "assets", asset);
  await repo.upsert(projectId, "identityRefs", {
    id: crypto.randomUUID(),
    characterId,
    slot: "additional",
    assetId: asset.id,
    label: "additional",
    metadata: {},
    locked: false,
  });
}

describe("Continuity Lock actions: an oversized basis persists nothing", () => {
  beforeEach(() => {
    vi.stubEnv("PRISM_STUDIO_PERSISTENCE", "memory");
  });

  it(`Character page: exactly ${MAX_LOCK_REFERENCES} is created; ${MAX_LOCK_REFERENCES + 1} is refused with 0 Locks, 0 members, Assets unchanged`, async () => {
    const { createCharacterContinuityLock } = await import("../character-continuity-actions");
    const { repo, projectId, yumeko, look } = setup();
    const ok = await createCharacterContinuityLock(
      form({ projectSlug: SLUG, characterId: yumeko.id, lookId: look.id, name: "Yumeko — Wide 64" }),
    );
    expect(ok.ok).toBe(true);
    const [lock] = (await repo.characterContinuity.listForProject(projectId)).locks;
    expect(lock.references).toHaveLength(MAX_LOCK_REFERENCES);

    await addOneIdentityImage(repo, projectId, yumeko.id);
    const assetsBefore = (await repo.loadProject(SLUG))!.assets.length;
    const refused = await createCharacterContinuityLock(
      form({ projectSlug: SLUG, characterId: yumeko.id, lookId: look.id, name: "Yumeko — Wide 65" }),
    );
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error).toBe(
      `This appearance has 65 usable reference images. A Continuity Lock supports at most 64. Remove some Identity or Look references before creating the Lock.`,
    );
    const after = await repo.characterContinuity.listForProject(projectId);
    expect(after.locks.map((l) => l.id)).toEqual([lock.id]); // no new Lock
    expect(after.locks[0].references).toHaveLength(MAX_LOCK_REFERENCES); // no member added anywhere
    expect((await repo.loadProject(SLUG))!.assets.length).toBe(assetsBefore);
  });

  it(`Shot Prep create-and-select: ${MAX_LOCK_REFERENCES + 1} is refused; no Lock is created and the selection is unchanged`, async () => {
    const { createLockFromShotAssignment } = await import("../character-continuity-actions");
    const { repo, projectId, yumeko, shotId } = setup();
    const first = await createLockFromShotAssignment(
      form({
        projectSlug: SLUG,
        shotId,
        characterId: yumeko.id,
        name: "Yumeko — Wide 64",
        expectedSelectedId: "",
      }),
    );
    expect(first.ok).toBe(true);
    const before = await repo.characterContinuity.listForProject(projectId);
    expect(before.locks).toHaveLength(1);
    expect(before.selections).toHaveLength(1);

    await addOneIdentityImage(repo, projectId, yumeko.id);
    const refused = await createLockFromShotAssignment(
      form({
        projectSlug: SLUG,
        shotId,
        characterId: yumeko.id,
        name: "Yumeko — Wide 65",
        expectedSelectedId: before.locks[0].id,
      }),
    );
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error).toContain("65 usable reference images");
    const after = await repo.characterContinuity.listForProject(projectId);
    expect(after.locks.map((l) => l.id)).toEqual(before.locks.map((l) => l.id));
    expect(after.selections).toEqual(before.selections);
  });
});
