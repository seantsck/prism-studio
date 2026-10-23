import { describe, expect, it } from "vitest";
import { CharacterContinuityError } from "@/data/character-continuity-repository";
import { MemoryRepository } from "@/data/memory-repository";
import { findAssetUsage } from "@/domain/asset-usage";
import {
  CHARACTER_CONTINUITY_FACTS_SCHEMA,
  CHARACTER_CONTINUITY_LOCK_SCHEMA,
  CONTINUITY_LOCK_INTEGRITY_MESSAGE,
  characterContinuityLockFingerprint,
  characterContinuityLockSchema,
  checkLockImage,
  draftCharacterContinuityLock,
  lockCoverage,
  MAX_LOCK_REFERENCES,
} from "@/domain/character-continuity";
import { buildShotContext, type ShotContext } from "@/domain/context";
import { buildCriteria, buildReferenceSet } from "@/domain/continuity/criteria";
import { approvalSnapshot, computeShotParts, storyboardFreshness } from "@/domain/fingerprint";
import { candidateInputBasis, candidateInputStaleness } from "@/domain/generated-production-frame";
import { assembleGenerationPackage, shotChangedSinceAttempt } from "@/domain/generation-package";
import {
  deriveProductionFrameReferenceCandidates,
  evaluateCompatibility,
} from "@/domain/generation/compatibility";
import { buildPromptPlan, renderPromptPlan } from "@/domain/generation/prompt-plan";
import type { GenerationModel } from "@/domain/generation/schemas";
import { fingerprint } from "@/domain/hash";
import { runPreflight } from "@/domain/preflight";
import { productionFrameFreshness, type ProductionFrame } from "@/domain/production-frame";
import type { ProjectData } from "@/domain/schemas";
import { MockProvider } from "@/generation/providers/mock";
import { referenceLegend, runwayImageTags } from "@/generation/providers/runway/image-families";
import { catalogModel } from "@/domain/generation/models/catalog";
import {
  addImage,
  addLook,
  assignLook,
  attachLocks,
  characterByName,
  lockFor,
  lookOf,
  uploadIdentity,
  uploadLookRef,
  yumekoIvory,
} from "./character-continuity-fixtures";
import { seed, shotByCode } from "./helpers";
import { attach, draftFor, newUploadAsset, storeImage, T } from "./production-frame-fixtures";

/**
 * Phase 2G.4 Character Continuity Locks: pure domain rules plus the memory repository. Fictional data, in memory: no
 * provider call, no 3D set, no GPU, no network.
 */

const models = new MockProvider().listModels();
const model = (id: string): GenerationModel => models.find((m) => m.modelId === id)!;
const textOnly = (): GenerationModel => {
  const m = structuredClone(model("mock-image-1"));
  m.modelId = "mock-image-text-only";
  m.capabilities.modalities = ["text_to_image"];
  m.capabilities.references.referenceImages = false;
  m.capabilities.references.maxReferences = 0;
  return m;
};
const ctxOf = (data: ProjectData, code = "3A") => buildShotContext(data, shotByCode(data, code).id);
const pkgOf = (data: ProjectData, code = "3A") =>
  assembleGenerationPackage(ctxOf(data, code), new Date("2026-10-22T00:00:00Z"));

/** The characters / looks part formulas exactly as they were BEFORE Phase 2G.4 (the no-Lock compatibility oracle). */
function legacyCharacterParts(ctx: ShotContext) {
  return {
    characters: fingerprint(
      ctx.characters.map((c) => ({
        assignment: c.assignment,
        physicalDescription: c.character?.physicalDescription ?? null,
        identityRefs: c.identityRefs.map((r) => [r.slot, r.assetId, r.locked]).sort(),
      })),
    ),
    looks: fingerprint(
      ctx.characters.map((c) =>
        c.look
          ? {
              id: c.look.id,
              wardrobe: c.look.wardrobe,
              shoes: c.look.shoes,
              jewelry: c.look.jewelry,
              hair: c.look.hair,
              makeup: c.look.makeup,
              grooming: c.look.grooming,
              bodyNotes: c.look.bodyNotes,
              accessories: c.look.accessories,
              referenceAssetIds: c.look.referenceAssetIds,
              locked: c.look.locked,
            }
          : null,
      ),
    ),
  };
}

/** Seed + Yumeko's Ivory Suit setup on Shot 3A, with Lock A created (and optionally selected). */
function lockedSetup(o: { select?: boolean; code?: string } = {}) {
  const data = seed();
  const code = o.code ?? "3A";
  const setup = yumekoIvory(data, code);
  const lockA = lockFor(data, "Yumeko", setup.ivory, { name: "Yumeko — Ivory Suit v1" });
  attachLocks(data, [lockA], o.select === false ? [] : [{ code, lock: lockA }]);
  return { data, code, lockA, ...setup };
}

// ───────────────────────── the Lock itself ─────────────────────────

describe("Character Continuity Lock: an immutable snapshot of approved appearance", () => {
  it("freezes facts BY VALUE, the real identity images in slot order and the Look images; copies no bytes", () => {
    const data = seed();
    const assetsBefore = data.assets.length;
    const { front, profile, ivory, ivoryRef } = yumekoIvory(data);
    const uploads = data.assets.length - assetsBefore; // 3 uploads, made by the fixture
    const lock = lockFor(data, "Yumeko", ivory, { name: "Yumeko — Ivory Suit" });
    expect(data.assets.length).toBe(assetsBefore + uploads); // creating the Lock added no Asset
    expect(characterContinuityLockSchema.parse(lock)).toEqual(lock);
    const yumeko = characterByName(data, "Yumeko");
    expect(lock).toMatchObject({
      schemaVersion: CHARACTER_CONTINUITY_LOCK_SCHEMA,
      characterId: yumeko.id,
      sourceLookId: ivory.id,
      name: "Yumeko — Ivory Suit",
    });
    expect(lock.facts).toEqual({
      schema: CHARACTER_CONTINUITY_FACTS_SCHEMA,
      characterId: yumeko.id,
      characterName: "Yumeko",
      physicalDescription: yumeko.physicalDescription,
      continuityRules: yumeko.continuityRules,
      sourceLookId: ivory.id,
      look: {
        name: "Ivory Suit",
        wardrobe: "ivory tailored suit, wide lapels",
        shoes: "ivory pumps",
        jewelry: "pearl earrings",
        hair: "low chignon",
        makeup: "soft matte, muted rose lip",
        grooming: "",
        bodyNotes: "",
        accessories: "",
      },
    });
    // the seed's three-quarter / full-body placeholders are NOT image evidence
    expect(lock.references.map((r) => [r.position, r.role, r.identitySlot, r.assetId])).toEqual([
      [0, "identity", "front", front.id],
      [1, "identity", "profile", profile.id],
      [2, "look", null, ivoryRef.id],
    ]);
    expect(lock.references[0]).toMatchObject({ assetChecksum: front.checksum, width: 768, height: 1024 });
    expect(lockCoverage(lock)).toMatchObject({ identityCount: 2, lookCount: 1, level: "rich" });
  });

  it("placeholders are skipped and reported; a Lock with no images still records its facts (coverage none)", () => {
    const data = seed();
    const look = lookOf(data, "Takumi");
    const r = draftCharacterContinuityLock({
      id: "l",
      now: T,
      userId: null,
      projectId: data.project.id,
      name: "Takumi — Navy",
      character: characterByName(data, "Takumi"),
      look,
      identityRefs: data.identityRefs.filter((x) => x.characterId === characterByName(data, "Takumi").id),
      assets: data.assets,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft.references).toEqual([]);
    expect(r.skipped.length).toBeGreaterThan(0);
    expect(lockCoverage(r.draft).level).toBe("none");
    expect(checkLockImage({ ...newUploadAsset("p"), objectPath: null }).ok).toBe(false);
    expect(checkLockImage({ ...newUploadAsset("p"), type: "reference" }).ok).toBe(false);
  });

  it("an intentional no-Look Lock records look: null (nothing invented)", () => {
    const data = seed();
    uploadIdentity(data, "Yumeko", "front");
    const lock = lockFor(data, "Yumeko", null);
    expect(lock.sourceLookId).toBeNull();
    expect(lock.facts.look).toBeNull();
    expect(lock.references.every((r) => r.role === "identity")).toBe(true);
  });

  it("validation: same Project, the Look must be the Character's own, identity refs must be the Character's", () => {
    const data = seed();
    const yumeko = characterByName(data, "Yumeko");
    const seanLook = lookOf(data, "Sean");
    const base = {
      id: "l",
      now: T,
      userId: null,
      projectId: data.project.id,
      name: "x",
      character: yumeko,
      look: null,
      identityRefs: [],
      assets: data.assets,
    };
    expect(draftCharacterContinuityLock({ ...base, look: seanLook }).ok).toBe(false);
    expect(draftCharacterContinuityLock({ ...base, character: { ...yumeko, projectId: "other" } }).ok).toBe(
      false,
    );
    expect(
      draftCharacterContinuityLock({ ...base, look: { ...lookOf(data, "Yumeko"), projectId: "other" } }).ok,
    ).toBe(false);
    const seanRef = data.identityRefs.find((r) => r.characterId === characterByName(data, "Sean").id)!;
    expect(draftCharacterContinuityLock({ ...base, identityRefs: [seanRef] }).ok).toBe(false);
    expect(draftCharacterContinuityLock({ ...base, name: "  " }).ok).toBe(false);
    // an image of another project is never frozen
    const foreign = newUploadAsset("other-project", { label: "foreign" });
    data.assets.push(foreign);
    const ref = data.identityRefs.find((r) => r.characterId === yumeko.id && r.slot === "front")!;
    ref.assetId = foreign.id;
    const r = draftCharacterContinuityLock({ ...base, identityRefs: [ref] });
    expect(r.ok && r.draft.references.length).toBe(0);
  });

  it("fingerprint: same bytes + facts = same Lock; wardrobe / hair / identity image change = new Lock; no timestamps or name", () => {
    const data = seed();
    const { ivory } = yumekoIvory(data);
    const a = lockFor(data, "Yumeko", ivory, { name: "A", now: "2026-01-01T00:00:00Z", id: "x" });
    const b = lockFor(data, "Yumeko", ivory, { name: "B", now: "2027-01-01T00:00:00Z", id: "y" });
    expect(b.lockFingerprint).toBe(a.lockFingerprint);
    expect(a.lockFingerprint).toBe(
      characterContinuityLockFingerprint(a.characterId, a.sourceLookId, a.facts, a.references),
    );
    ivory.wardrobe = "black evening gown";
    const wardrobe = lockFor(data, "Yumeko", ivory);
    expect(wardrobe.lockFingerprint).not.toBe(a.lockFingerprint);
    ivory.wardrobe = "ivory tailored suit, wide lapels";
    ivory.hair = "loose waves";
    expect(lockFor(data, "Yumeko", ivory).lockFingerprint).not.toBe(a.lockFingerprint);
    ivory.hair = "low chignon";
    expect(lockFor(data, "Yumeko", ivory).lockFingerprint).toBe(a.lockFingerprint);
    // a different image in the front slot
    uploadIdentity(data, "Yumeko", "front", "yumeko-front-v2");
    expect(lockFor(data, "Yumeko", ivory).lockFingerprint).not.toBe(a.lockFingerprint);
  });

  it("the same image bytes under a different Asset id is the same appearance basis", () => {
    const data = seed();
    const { front, ivory } = yumekoIvory(data);
    const a = lockFor(data, "Yumeko", ivory);
    const copy = addImage(data, "same-bytes");
    copy.checksum = front.checksum;
    copy.width = front.width;
    copy.height = front.height;
    data.identityRefs.find((r) => r.assetId === front.id)!.assetId = copy.id;
    expect(lockFor(data, "Yumeko", ivory).lockFingerprint).toBe(a.lockFingerprint);
  });
});

// ───────────────────────── the reference cap: refuse, never truncate ─────────────────────────

describe(`Continuity Lock reference cap (${MAX_LOCK_REFERENCES}): an oversized basis is refused whole`, () => {
  /** Yumeko with `identity` uploaded identity images (additional slot) and a Look holding `look` uploaded images. */
  function wide(identity: number, look: number) {
    const data = seed();
    const ids = Array.from({ length: identity }, (_, i) =>
      uploadIdentity(data, "Yumeko", "additional", `cap-identity-${i}`),
    );
    const wideLook = addLook(data, "Yumeko", "Wide");
    const looks = Array.from({ length: look }, (_, i) => uploadLookRef(data, wideLook, `cap-look-${i}`));
    return { data, ids, looks, wideLook };
  }
  const draftWide = (data: ProjectData, look: ProjectData["looks"][number]) => {
    const yumeko = characterByName(data, "Yumeko");
    return draftCharacterContinuityLock({
      id: "cap",
      now: T,
      userId: null,
      projectId: data.project.id,
      name: "Yumeko — Wide",
      character: yumeko,
      look,
      identityRefs: data.identityRefs.filter((r) => r.characterId === yumeko.id),
      assets: data.assets,
    });
  };

  it("the seed's own Yumeko identity entries are placeholders (the counts below are the uploads alone)", () => {
    const { data, wideLook } = wide(0, 0);
    const r = draftWide(data, wideLook);
    expect(r.ok && r.draft.references.length).toBe(0);
  });

  it(`A. exactly ${MAX_LOCK_REFERENCES} valid unique images: the Lock freezes all of them, positions 0..${MAX_LOCK_REFERENCES - 1}`, () => {
    const { data, ids, looks, wideLook } = wide(4, 60);
    const r = draftWide(data, wideLook);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft.references).toHaveLength(MAX_LOCK_REFERENCES);
    expect(r.draft.references.map((x) => x.position)).toEqual([...Array(MAX_LOCK_REFERENCES).keys()]);
    expect(r.draft.references.map((x) => x.assetId)).toEqual([...ids, ...looks].map((a) => a.id));
    expect(lockCoverage(r.draft)).toMatchObject({ identityCount: 4, lookCount: 60 });
    // the fingerprint still hashes every frozen reference
    expect(r.draft.lockFingerprint).toBe(
      characterContinuityLockFingerprint(
        r.draft.characterId,
        r.draft.sourceLookId,
        r.draft.facts,
        r.draft.references,
      ),
    );
  });

  it(`B. ${MAX_LOCK_REFERENCES + 1} valid unique images: refused, naming both counts; no Lock is drafted`, () => {
    const { data, wideLook } = wide(5, 60);
    const r = draftWide(data, wideLook);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toBe(
      `This appearance has 65 usable reference images. A Continuity Lock supports at most 64. Remove some Identity or Look references before creating the Lock.`,
    );
    expect(r).not.toHaveProperty("draft");
  });

  it(`C. ${MAX_LOCK_REFERENCES + 1} source entries that dedupe to ${MAX_LOCK_REFERENCES} unique images: accepted; identity outranks Look`, () => {
    const { data, ids, wideLook } = wide(5, 59);
    // the Look also lists one of the identity images: the same Asset is frozen once, as identity
    wideLook.referenceAssetIds = [...wideLook.referenceAssetIds, ids[2].id];
    expect(ids.length + wideLook.referenceAssetIds.length).toBe(MAX_LOCK_REFERENCES + 1);
    const r = draftWide(data, wideLook);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft.references).toHaveLength(MAX_LOCK_REFERENCES);
    const shared = r.draft.references.filter((x) => x.assetId === ids[2].id);
    expect(shared).toHaveLength(1);
    expect(shared[0].role).toBe("identity");
  });

  it(`D. more than ${MAX_LOCK_REFERENCES} source entries but ≤ ${MAX_LOCK_REFERENCES} usable: accepted; the unusable ones are reported as skipped`, () => {
    const { data, wideLook } = wide(0, 60);
    for (let i = 0; i < 10; i++) {
      const broken = uploadLookRef(data, wideLook, `cap-unusable-${i}`);
      broken.objectPath = null; // no stored file: not image evidence
    }
    expect(wideLook.referenceAssetIds.length).toBe(70);
    const r = draftWide(data, wideLook);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft.references).toHaveLength(60);
    expect(r.skipped.filter((s) => s.role === "look")).toHaveLength(10);
  });

  it("E. overflow is never reported as skipped and never yields a truncated Lock", () => {
    // placeholders exist too (the seed's), yet the refusal counts only the usable images and drafts nothing
    const { data, wideLook } = wide(10, 60);
    const r = draftWide(data, wideLook);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain("70 usable reference images");
    expect(r.message).toContain("at most 64");
    expect(r.message).not.toMatch(/not frozen|unusable|skipped/i);
    expect(r).not.toHaveProperty("skipped");
    expect(r).not.toHaveProperty("draft");
  });
});

// ───────────────────────── memory repository parity ─────────────────────────

describe("memory repository: create, dedupe, select, compare-and-set, invalidation", () => {
  async function repoSetup() {
    const data = seed();
    const setup = yumekoIvory(data, "6A");
    uploadIdentity(data, "Sean", "front");
    const repo = new MemoryRepository([data]);
    const pid = data.project.id;
    const shot = shotByCode(data, "6A");
    await repo.upsert(pid, "shots", shot);
    return { repo, data, pid, shot, ...setup };
  }

  it("dedupes identical creates (also 5 concurrent) and freezes the stored record", async () => {
    const { repo, data, ivory } = await repoSetup();
    const svc = repo.characterContinuity;
    const drafts = Array.from({ length: 5 }, (_, i) => lockFor(data, "Yumeko", ivory, { id: `lock-${i}` }));
    const results = await Promise.all(drafts.map((d) => svc.create(d)));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.lock.id)).size).toBe(1);
    expect((await svc.listForProject(data.project.id)).locks).toHaveLength(1);
    // returned values are copies: mutating one never rewrites the stored Lock
    results[0]!.lock.facts.look!.wardrobe = "tampered";
    expect((await svc.get(data.project.id, results[0]!.lock.id))!.facts.look!.wardrobe).toBe(
      "ivory tailored suit, wide lapels",
    );
    ivory.wardrobe = "changed later";
    const changed = await svc.create(lockFor(data, "Yumeko", ivory));
    expect(changed.created).toBe(true);
  });

  it("refuses a Lock whose image facts do not match the Asset", async () => {
    const { repo, data, ivory } = await repoSetup();
    const draft = lockFor(data, "Yumeko", ivory);
    draft.references[0]!.assetChecksum = "0".repeat(64);
    await expect(repo.characterContinuity.create(draft)).rejects.toBeInstanceOf(CharacterContinuityError);
  });

  it("select: same Character + same Look only; CAS; Look change and Character removal clear it", async () => {
    const { repo, data, pid, shot, ivory } = await repoSetup();
    const svc = repo.characterContinuity;
    const { lock: lockA } = await svc.create(lockFor(data, "Yumeko", ivory, { name: "A" }));
    const seanLook = lookOf(data, "Sean");
    const { lock: seanLock } = await svc.create(lockFor(data, "Sean", seanLook));
    const black = lookOf(data, "Yumeko", "Episode 1 — Formal Black");
    const { lock: blackLock } = await svc.create(lockFor(data, "Yumeko", black, { name: "Black" }));
    const yumeko = characterByName(data, "Yumeko").id;
    const sean = characterByName(data, "Sean").id;
    const sel = (lockId: string, characterId = yumeko, expected?: string | null) =>
      svc.selectForAssignment({
        projectId: pid,
        shotId: shot.id,
        characterId,
        continuityLockId: lockId,
        userId: null,
        now: T,
        expectedSelectedLockId: expected,
      });
    const codeOf = (p: Promise<unknown>) =>
      p.then(
        () => "ok",
        (e) => (e instanceof CharacterContinuityError ? e.code : String(e)),
      );
    expect(await codeOf(sel(lockA.id, yumeko, null))).toBe("ok");
    expect(await codeOf(sel(seanLock.id, yumeko))).toBe("wrong_character");
    expect(await codeOf(sel(blackLock.id, yumeko))).toBe("wrong_look");
    expect(await codeOf(sel(lockA.id, "not-assigned"))).toBe("not_found");
    expect(await codeOf(sel(lockA.id, yumeko, null))).toBe("conflict"); // the caller's view is stale
    expect(await codeOf(sel(seanLock.id, sean, null))).toBe("ok");
    expect(await svc.selectionsForShot(pid, shot.id)).toHaveLength(2);

    // an unrelated Shot edit keeps both selections
    const current = (await repo.loadProject("ojousama"))!.shots.find((s) => s.id === shot.id)!;
    await repo.upsert(pid, "shots", { ...current, title: "Renamed" });
    expect(await svc.selectionsForShot(pid, shot.id)).toHaveLength(2);

    // the Yumeko assignment changes Look: ONLY her selection is cleared
    await repo.upsert(pid, "shots", {
      ...current,
      characters: current.characters.map((c) => (c.characterId === yumeko ? { ...c, lookId: black.id } : c)),
    });
    expect((await svc.selectionsForShot(pid, shot.id)).map((s) => s.characterId)).toEqual([sean]);

    // Sean leaves the Shot: his selection disappears
    const after = (await repo.loadProject("ojousama"))!.shots.find((s) => s.id === shot.id)!;
    await repo.upsert(pid, "shots", {
      ...after,
      characters: after.characters.filter((c) => c.characterId !== sean),
    });
    expect(await svc.selectionsForShot(pid, shot.id)).toEqual([]);

    // clear is compare-and-set too
    await repo.upsert(pid, "shots", current);
    await sel(lockA.id, yumeko);
    await expect(
      svc.clearForAssignment({
        projectId: pid,
        shotId: shot.id,
        characterId: yumeko,
        expectedSelectedLockId: null,
      }),
    ).rejects.toBeInstanceOf(CharacterContinuityError);
    await svc.clearForAssignment({
      projectId: pid,
      shotId: shot.id,
      characterId: yumeko,
      expectedSelectedLockId: lockA.id,
    });
    expect(await svc.selectionsForShot(pid, shot.id)).toEqual([]);
    expect(await svc.usesAsset(lockA.references[0]!.assetId)).toBe(true);
  });
});

// ───────────────────────── appearance authority + freshness ─────────────────────────

describe("locked appearance authority and freshness", () => {
  it("a Shot with NO Lock hashes exactly as before 2G.4 (characters / looks parts)", () => {
    const data = seed();
    for (const code of ["1C", "3A", "4B", "6A"]) {
      const ctx = ctxOf(data, code);
      const parts = computeShotParts(ctx);
      const legacy = legacyCharacterParts(ctx);
      expect(parts.characters).toBe(legacy.characters);
      expect(parts.looks).toBe(legacy.looks);
      expect(ctx.characters.every((c) => c.appearance.source === "live")).toBe(true);
    }
    // a Lock that exists but is not selected changes nothing either
    const { data: d2, code } = lockedSetup({ select: false });
    expect(computeShotParts(ctxOf(d2, code)).looks).toBe(legacyCharacterParts(ctxOf(d2, code)).looks);
    expect(pkgOf(d2).references.characterContinuity).toBeUndefined();
  });

  it("with a Lock, identity / physical / wardrobe / hair / makeup / jewelry / Look refs come from the Lock", () => {
    const { data, lockA, ivory, front } = lockedSetup();
    // the source library is edited AFTER the Lock was made
    ivory.wardrobe = "black evening gown";
    ivory.hair = "loose waves";
    ivory.makeup = "smoky eye";
    ivory.jewelry = "diamond choker";
    const newRef = uploadLookRef(data, ivory, "new-look-ref");
    uploadIdentity(data, "Yumeko", "front", "yumeko-front-new");
    characterByName(data, "Yumeko").physicalDescription = "rewritten description";
    const ctx = ctxOf(data);
    const c = ctx.characters.find((x) => x.assignment.characterId === lockA.characterId)!;
    expect(c.continuityLock?.id).toBe(lockA.id);
    expect(c.appearance.source).toBe("continuity_lock");
    expect(c.appearance.physicalDescription).toBe(lockA.facts.physicalDescription);
    expect(c.appearance.look).toMatchObject({
      wardrobe: "ivory tailored suit, wide lapels",
      hair: "low chignon",
      makeup: "soft matte, muted rose lip",
      jewelry: "pearl earrings",
      locked: true,
    });
    expect(c.appearance.identityReferenceAssetIds[0]).toBe(front.id);
    expect(c.appearance.look?.referenceAssetIds).not.toContain(newRef.id);
    const pkg = pkgOf(data);
    const pc = pkg.characters.find((x) => x.characterId === lockA.characterId)!;
    expect(pc.look?.wardrobe).toBe("ivory tailored suit, wide lapels");
    expect(pc.physicalDescription).toBe(lockA.facts.physicalDescription);
    expect(pc.identityReferenceAssetIds).toEqual([front.id, lockA.references[1]!.assetId]);
    expect(pc.continuityLock).toEqual({
      lockId: lockA.id,
      name: lockA.name,
      lockFingerprint: lockA.lockFingerprint,
    });
    // performance stays live on the assignment
    shotByCode(data, "3A").characters[0]!.expression = "a guarded half-smile";
    expect(pkgOf(data).characters[0]!.expression).toBe("a guarded half-smile");
  });

  it("SOURCE EDIT AFTER LOCK: the locked Shot's truth, Storyboard and Production Frame stay fresh; an unlocked Shot changes", () => {
    const { data, ivory } = lockedSetup({ code: "3A" });
    // 5A also wears the Ivory Suit but WITHOUT a Lock
    assignLook(data, "5A", "Yumeko", ivory);
    const before3A = computeShotParts(ctxOf(data, "3A"));
    const before5A = computeShotParts(ctxOf(data, "5A"));
    const pkgBefore = pkgOf(data, "3A");
    // approve a storyboard and make a Production Frame of the LOCKED Shot now
    const approved = approvalSnapshot(ctxOf(data, "3A"));
    const shot = shotByCode(data, "3A");
    const frameAsset = storeImage(
      data,
      data.frames.find((f) => f.shotId === shot.id)?.assetId ?? addImage(data, "f").id,
      {
        width: shot.composition.aspectRatio === "16:9" ? 1920 : 1912,
        height: shot.composition.aspectRatio === "16:9" ? 1080 : 800,
        label: "pf-3a",
      },
    );
    const pf: ProductionFrame = { ...draftFor(data, "3A", { asset: frameAsset }), version: 1 };
    attach(data, [pf], pf);

    // edit the master Look: wardrobe, hair, and one reference image; and the identity library
    ivory.wardrobe = "black evening gown";
    ivory.hair = "loose waves";
    uploadLookRef(data, ivory, "second-ivory-ref");
    uploadIdentity(data, "Yumeko", "profile", "yumeko-profile-v2");

    const after3A = computeShotParts(ctxOf(data, "3A"));
    expect(after3A.characters).toBe(before3A.characters);
    expect(after3A.looks).toBe(before3A.looks);
    expect(
      storyboardFreshness(ctxOf(data, "3A"), {
        approvedFingerprint: approved.fingerprint,
        approvedSnapshot: approved.snapshot,
      }).status,
    ).toBe("fresh");
    expect(productionFrameFreshness(ctxOf(data, "3A"), pf).status).toBe("fresh");
    // the package's appearance is unchanged (only builtAt differs)
    const pkgAfter = pkgOf(data, "3A");
    expect(pkgAfter.characters).toEqual(pkgBefore.characters);
    expect(pkgAfter.references.characterContinuity).toEqual(pkgBefore.references.characterContinuity);

    // the UNLOCKED Shot using the same Look reflects the edit, as it always did
    const after5A = computeShotParts(ctxOf(data, "5A"));
    expect(after5A.looks).not.toBe(before5A.looks);
    expect(after5A.characters).not.toBe(before5A.characters);
    expect(pkgOf(data, "5A").characters[0]!.look?.wardrobe).toBe("black evening gown");
  });

  it("LOCK SWITCH A → B: characters / looks change; Storyboard, Production Frame and candidates go stale", () => {
    const { data, lockA, ivory } = lockedSetup();
    const approved = approvalSnapshot(ctxOf(data));
    const shot = shotByCode(data, "3A");
    const frameAsset = addImage(data, "pf", {
      width: shot.composition.aspectRatio === "16:9" ? 1920 : 1912,
      height: shot.composition.aspectRatio === "16:9" ? 1080 : 800,
    });
    const pf: ProductionFrame = { ...draftFor(data, "3A", { asset: frameAsset }), version: 1 };
    attach(data, [pf], pf);
    const pkgA = pkgOf(data);
    // a candidate generated under Lock A (its frozen package snapshot is the basis)
    const candidate = {
      id: "cand",
      request: { purpose: "production_frame", references: [] },
      packageSnapshot: JSON.parse(JSON.stringify(pkgA)) as Record<string, unknown>,
    };
    expect(candidateInputStaleness(ctxOf(data), candidate)).toBeNull();

    ivory.hair = "loose waves";
    const lockB = lockFor(data, "Yumeko", ivory, { name: "Yumeko — Ivory Suit v2" });
    attachLocks(data, [lockA, lockB], [{ code: "3A", lock: lockB }]);
    const parts = computeShotParts(ctxOf(data));
    expect(parts.looks).not.toBe(pkgA.provenance.parts.looks);
    expect(parts.characters).not.toBe(pkgA.provenance.parts.characters);
    expect(
      storyboardFreshness(ctxOf(data), {
        approvedFingerprint: approved.fingerprint,
        approvedSnapshot: approved.snapshot,
      }).status,
    ).toBe("stale");
    expect(productionFrameFreshness(ctxOf(data), pf)).toMatchObject({ status: "stale" });
    expect(candidateInputStaleness(ctxOf(data), candidate)?.changed).toEqual(
      expect.arrayContaining(["characters", "looks"]),
    );
    const pkgB = pkgOf(data);
    expect(pkgB.provenance.parts.overall).not.toBe(pkgA.provenance.parts.overall);
    expect(
      shotChangedSinceAttempt({ packageFingerprint: "", packageSnapshot: candidate.packageSnapshot }, pkgB)
        ?.changed,
    ).toBe(true);
  });

  it("an invalid stored selection blocks generation with a data-integrity error; no selection never blocks", () => {
    const { data, lockA } = lockedSetup();
    expect(
      runPreflight(ctxOf(data)).items.find((i) => i.ruleId === "character.continuity_lock")?.status,
    ).toBe("pass");
    // the assignment's Look changed underneath (only reachable through a data-integrity problem)
    assignLook(data, "3A", "Yumeko", lookOf(data, "Yumeko", "Episode 1 — Formal Black"));
    const ctx = ctxOf(data);
    const c = ctx.characters[0]!;
    expect(c.continuityLock).toBeNull();
    expect(c.continuityLockIssue).toMatchObject({ code: "wrong_look", continuityLockId: lockA.id });
    const item = runPreflight(ctx).items.find((i) => i.ruleId === "character.continuity_lock")!;
    expect(item.status).toBe("fail");
    expect(item.detail).toBe(CONTINUITY_LOCK_INTEGRITY_MESSAGE);
    // the invalid selection is named in the hash (never silently equal to "no selection")
    expect(computeShotParts(ctx).looks).not.toBe(legacyCharacterParts(ctx).looks);
    // Character no longer assigned: an orphan, also blocking
    shotByCode(data, "3A").characters = [];
    expect(
      runPreflight(ctxOf(data)).items.find((i) => i.ruleId === "character.continuity_lock")?.status,
    ).toBe("fail");
    // no selection at all: not applicable
    attachLocks(data, [lockA], []);
    expect(
      runPreflight(ctxOf(data)).items.find((i) => i.ruleId === "character.continuity_lock")?.status,
    ).toBe("na");
  });

  it("a Lock does not change who appears: the character count is the assignments'", () => {
    const { data } = lockedSetup();
    const ctx = ctxOf(data);
    expect(pkgOf(data).characters).toHaveLength(ctx.shot.characters.length);
  });
});

// ───────────────────────── GenerationPackage v5 ─────────────────────────

describe("GenerationPackage v5", () => {
  it("records each selected Lock by value, its images in assets, and Character-keyed sourceVersions", () => {
    const { data, lockA } = lockedSetup();
    const pkg = pkgOf(data);
    expect(pkg.version).toBe(5);
    expect(pkg.references.characterContinuity).toEqual([
      {
        characterId: lockA.characterId,
        characterName: "Yumeko",
        lockId: lockA.id,
        name: lockA.name,
        lockFingerprint: lockA.lockFingerprint,
        sourceLookId: lockA.sourceLookId,
        facts: lockA.facts,
        references: lockA.references,
      },
    ]);
    for (const r of lockA.references) expect(pkg.assets[r.assetId]?.checksum).toBe(r.assetChecksum);
    expect(pkg.provenance.sourceVersions.characterContinuityLocks).toEqual({
      [lockA.characterId]: { lockId: lockA.id, lockFingerprint: lockA.lockFingerprint },
    });
    const json = JSON.stringify(pkg);
    expect(json).not.toMatch(/https?:\/\/|token=|signature=/);
    expect(pkg.constraints.hard.join(" ")).toMatch(
      /frozen by Character Continuity Lock "Yumeko — Ivory Suit v1"/,
    );
  });

  it("without a Lock: no characterContinuity key, no characters[].continuityLock, no sourceVersions key", () => {
    const pkg = pkgOf(seed());
    expect(pkg.version).toBe(5);
    expect("characterContinuity" in pkg.references).toBe(false);
    expect(pkg.characters.every((c) => !("continuityLock" in c))).toBe(true);
    expect("characterContinuityLocks" in pkg.provenance.sourceVersions).toBe(false);
  });

  it("historical v4 / v3 / v2 snapshots stay readable as written (no backfill, no rewrite)", () => {
    const pkg = pkgOf(seed());
    for (const version of [4, 3, 2]) {
      const old = JSON.parse(JSON.stringify({ ...pkg, version, packageSchemaVersion: version })) as Record<
        string,
        unknown
      >;
      const frozen = JSON.stringify(old);
      const basis = candidateInputBasis({ request: { references: [] }, packageSnapshot: old });
      expect(basis.characterContinuityReferences).toEqual([]);
      expect(shotChangedSinceAttempt({ packageFingerprint: "f", packageSnapshot: old }, pkg)?.changed).toBe(
        false,
      );
      expect(JSON.stringify(old)).toBe(frozen);
    }
  });
});

// ───────────────────────── references: order, dedupe, multi-character, overflow ─────────────────────────

describe("generation references", () => {
  it("LOCKED: Production Frame · Storyboard · locked identity · locked Look · Location View · Location · lighting · Shot refs", () => {
    const { data, lockA, front, profile, ivoryRef } = lockedSetup({ code: "3A" });
    // live identity edits AFTER the Lock never reach the request (no double send)
    const liveFront = uploadIdentity(data, "Yumeko", "front", "live-front");
    const pkg = pkgOf(data);
    const refs = deriveProductionFrameReferenceCandidates(pkg);
    const roles = refs.map((r) => r.role);
    expect(refs.filter((r) => r.role === "identity").map((r) => r.assetId)).toEqual([front.id, profile.id]);
    expect(refs.filter((r) => r.role === "character_look").map((r) => r.assetId)).toEqual([ivoryRef.id]);
    expect(refs.map((r) => r.assetId)).not.toContain(liveFront.id);
    expect(roles.indexOf("identity")).toBeLessThan(roles.indexOf("character_look"));
    expect(refs.find((r) => r.assetId === front.id)?.label).toBe(
      `Yumeko identity — front (Continuity Lock "${lockA.name}")`,
    );
    expect(refs.find((r) => r.assetId === ivoryRef.id)?.label).toBe(
      `Yumeko Look "Ivory Suit" (Continuity Lock "${lockA.name}")`,
    );
    expect(new Set(refs.map((r) => r.assetId)).size).toBe(refs.length);
  });

  it("the same Asset as Production Frame and as a Lock image is sent ONCE, as production_frame", () => {
    const { data, front } = lockedSetup();
    const shot = shotByCode(data, "3A");
    // a (contrived) Production Frame whose image IS Yumeko's locked front identity image
    front.width = shot.composition.aspectRatio === "16:9" ? 1920 : 1912;
    front.height = shot.composition.aspectRatio === "16:9" ? 1080 : 800;
    const lock = lockFor(
      data,
      "Yumeko",
      data.looks.find((l) => l.name === "Ivory Suit")!,
    );
    attachLocks(data, [lock], [{ code: "3A", lock }]);
    const pf: ProductionFrame = { ...draftFor(data, "3A", { asset: front }), version: 1 };
    attach(data, [pf], pf);
    const refs = deriveProductionFrameReferenceCandidates(pkgOf(data));
    expect(refs.filter((r) => r.assetId === front.id)).toEqual([
      { assetId: front.id, role: "production_frame", label: "Current Production Frame" },
    ]);
  });

  it("MULTI-CHARACTER: assignment order, each person's images labelled as theirs, distinct Runway tags", () => {
    const data = seed();
    const { ivory } = yumekoIvory(data, "6A");
    uploadIdentity(data, "Sean", "front");
    uploadIdentity(data, "Sean", "profile");
    const seanLook = lookOf(data, "Sean");
    uploadLookRef(data, seanLook, "sean-suit");
    const yLock = lockFor(data, "Yumeko", ivory);
    const sLock = lockFor(data, "Sean", seanLook);
    attachLocks(
      data,
      [yLock, sLock],
      [
        { code: "6A", lock: yLock },
        { code: "6A", lock: sLock },
      ],
    );
    const pkg = pkgOf(data, "6A");
    expect(pkg.characters.map((c) => c.name)).toEqual(["Sean", "Yumeko"]); // the Shot's assignment order
    const refs = deriveProductionFrameReferenceCandidates(pkg);
    const ids = (lock: typeof yLock, role: "identity" | "look") =>
      lock.references.filter((r) => r.role === role).map((r) => r.assetId);
    expect(refs.filter((r) => r.role === "identity").map((r) => r.assetId)).toEqual([
      ...ids(sLock, "identity"),
      ...ids(yLock, "identity"),
    ]);
    expect(refs.filter((r) => r.role === "character_look").map((r) => r.assetId)).toEqual([
      ...ids(sLock, "look"),
      ...ids(yLock, "look"),
    ]);
    for (const r of refs) {
      const owner = sLock.references.some((x) => x.assetId === r.assetId) ? "Sean" : "Yumeko";
      expect(r.label.startsWith(`${owner} `)).toBe(true);
    }
    const tags = runwayImageTags(refs);
    expect(tags.filter((t) => t.startsWith("SeanIdentity"))).toHaveLength(2);
    expect(tags.filter((t) => t.startsWith("YumekoIdentity"))).toHaveLength(2);
    expect(tags).toEqual(expect.arrayContaining(["SeanLook", "YumekoLook"]));
    const legend = referenceLegend(catalogModel("runway", "gpt_image_2_5_flare")!, refs, tags);
    expect(legend).toMatch(/@SeanIdentity is Sean identity — front \(Continuity Lock/);
    expect(legend).toMatch(/@YumekoLook is Yumeko Look "Ivory Suit"/);
    // the prompt plan names whose images are whose
    const plan = renderPromptPlan(buildPromptPlan(pkg));
    expect(plan).toMatch(/Sean identity reference images: front, profile/);
    expect(plan).toMatch(/Yumeko identity reference images: front, profile/);
  });

  it("REFERENCE OVERFLOW: two locked Characters + a Location View beyond capacity BLOCK (nothing truncated)", () => {
    const data = seed();
    const { ivory } = yumekoIvory(data, "6A");
    uploadIdentity(data, "Sean", "front");
    uploadIdentity(data, "Sean", "three_quarter");
    uploadIdentity(data, "Sean", "profile");
    const yLock = lockFor(data, "Yumeko", ivory);
    const sLock = lockFor(data, "Sean", lookOf(data, "Sean"));
    attachLocks(
      data,
      [yLock, sLock],
      [
        { code: "6A", lock: yLock },
        { code: "6A", lock: sLock },
      ],
    );
    const pkg = pkgOf(data, "6A");
    const small = structuredClone(model("mock-image-1"));
    small.capabilities.references.maxReferences = 4;
    const report = evaluateCompatibility(pkg, small, { purpose: "production_frame" });
    expect(report.compatible).toBe(false);
    expect(report.errors.map((e) => e.id)).toContain("references.too_many");
    expect(deriveProductionFrameReferenceCandidates(pkg).length).toBe(6);
  });

  it("TEXT-ONLY model: the Lock's facts are in the prompt; disclosure says the Character images are not supplied", () => {
    const { data, lockA } = lockedSetup();
    const pkg = pkgOf(data);
    const report = evaluateCompatibility(pkg, textOnly(), { purpose: "production_frame" });
    expect(report.used.references).toEqual([]);
    const disclosure = report.ignoredFeatures.find((f) => f.id === "references.character_continuity");
    expect(disclosure?.impact).toMatch(/Character reference images not supplied to this model/);
    const plan = renderPromptPlan(buildPromptPlan(pkg));
    expect(plan).toMatch(/Character Continuity Lock "Yumeko — Ivory Suit v1"/);
    expect(plan).toMatch(/wardrobe: ivory tailored suit, wide lapels/);
    expect(plan).toMatch(/hair: low chignon/);
    expect(plan).toMatch(new RegExp(`physical identity: ${lockA.facts.physicalDescription.slice(0, 20)}`));
  });
});

// ───────────────────────── continuity QA reference preparation ─────────────────────────

describe("continuity QA: the selected Lock is the reference basis (pure preparation, no analyzer call)", () => {
  it("identity / wardrobe / hair / makeup / jewelry judge against the Lock, not the newly edited library", () => {
    const { data, lockA, ivory, front, profile, ivoryRef } = lockedSetup();
    ivory.wardrobe = "black evening gown";
    ivory.hair = "loose waves";
    ivory.makeup = "smoky eye";
    ivory.jewelry = "diamond choker";
    const newLookRef = uploadLookRef(data, ivory, "edited-look-ref");
    const newFront = uploadIdentity(data, "Yumeko", "front", "edited-front");
    const pkg = pkgOf(data);
    const refs = buildReferenceSet(pkg, null);
    const identity = refs.items.filter((i) => i.role === "identity").map((i) => i.assetId);
    const look = refs.items.filter((i) => i.role === "look").map((i) => i.assetId);
    expect(identity).toEqual([front.id, profile.id]);
    expect(look).toEqual([ivoryRef.id]);
    expect([...identity, ...look]).not.toContain(newFront.id);
    expect([...identity, ...look]).not.toContain(newLookRef.id);
    const criteria = buildCriteria({ pkg, adaptation: null, protectedComposition: [], deliverySize: null });
    const id = lockA.characterId;
    const by = (k: string) => criteria.find((c) => c.key === `${k}:${id}`)!;
    expect(by("identity").sourceRef).toMatch(/Character Continuity Lock "Yumeko — Ivory Suit v1"/);
    expect(by("wardrobe").expected).toBe("ivory tailored suit, wide lapels");
    expect(by("hair").expected).toBe("low chignon");
    expect(by("makeup").expected).toBe("soft matte, muted rose lip");
    expect(by("jewelry").expected).toBe("pearl earrings");
  });

  it("without a Lock the existing IdentityRefs / Look references keep working, unchanged", () => {
    const data = seed();
    const { ivory } = yumekoIvory(data);
    const pkg = pkgOf(data);
    const refs = buildReferenceSet(pkg, null);
    expect(refs.items.filter((i) => i.role === "look").map((i) => [i.assetId, i.label])).toEqual(
      ivory.referenceAssetIds.map((a) => [a, `Yumeko Look "Ivory Suit"`]),
    );
    expect(refs.items.filter((i) => i.role === "identity").every((i) => i.label === "Yumeko identity")).toBe(
      true,
    );
  });
});

describe("asset usage", () => {
  it("a Lock pins every image it froze (cannot be deleted from under it)", () => {
    const { data, lockA } = lockedSetup();
    for (const r of lockA.references) {
      const usage = findAssetUsage(data, r.assetId);
      expect(usage.inUse).toBe(true);
      expect(
        usage.direct.some((u) => u.kind === "character_continuity_lock" && u.entityId === lockA.id),
      ).toBe(true);
    }
  });
});
