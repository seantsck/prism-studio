import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRepository } from "@/data/memory-repository";
import { buildShotContext } from "@/domain/context";
import { approvalSnapshot } from "@/domain/fingerprint";
import { assembleGenerationPackage } from "@/domain/generation-package";
import { deriveReferenceCandidates } from "@/domain/generation/compatibility";
import type { Asset } from "@/domain/schemas";
import { visualBibleReadiness, visualRoleOf } from "@/domain/visual-bible";
import { readGenerationConfig } from "@/generation/config";
import { portraitFixturePng } from "@/generation/matting/fixture";
import { decodePng } from "@/generation/matting/png";
import { createRegistry } from "@/generation/registry";
import { LocalDiskSink } from "@/generation/sink";
import { prepareSubmission } from "@/generation/submission";
import { GenerationWorker } from "@/generation/worker";

/**
 * Phase 5B-I4: the Character Visual Bible through the REAL server actions, queue, worker, sink and delete path, on
 * the Ojou-sama project (memory, fixtures, free mock models; no paid generation).
 */
vi.setConfig({ testTimeout: 60_000 });
const env = {
  NODE_ENV: "test",
  PRISM_STUDIO_MOCK_STAGE_DELAY_MS: "0",
  PRISM_STUDIO_ENABLE_MOCK_PROVIDER: "1",
};
const world = vi.hoisted(() => ({ repo: null as unknown }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/server/auth", () => ({ requireUser: async () => ({ kind: "memory", id: "tester" }) }));
vi.mock("@/server/repo", async () => {
  const { UserFacingError } = await import("@/server/action-result");
  return {
    getRepo: async () => world.repo,
    requireProjectFresh: async (slug: string) => {
      const r = world.repo as MemoryRepository;
      const data = await r.loadProject(slug);
      if (!data) throw new UserFacingError("That project no longer exists.");
      const pf = await r.productionFrames.listForProject(data.project.id);
      const lv = await r.locationViews.listForProject(data.project.id);
      const cc = await r.characterContinuity.listForProject(data.project.id);
      return {
        ...data,
        productionFrames: pf.frames,
        productionFrameSelections: pf.selections,
        locationViews: lv.views,
        shotLocationViewSelections: lv.selections,
        characterContinuityLocks: cc.locks,
        shotCharacterContinuitySelections: cc.selections,
      };
    },
  };
});
vi.mock("@/server/generation", async () => {
  const { readGenerationConfig: read } = await import("@/generation/config");
  const { createRegistry: create } = await import("@/generation/registry");
  const e = {
    NODE_ENV: "test",
    PRISM_STUDIO_MOCK_STAGE_DELAY_MS: "0",
    PRISM_STUDIO_ENABLE_MOCK_PROVIDER: "1",
  };
  return {
    getGenerationRepo: async () => (world.repo as MemoryRepository).generation,
    getGenerationConfig: () => read(e),
    getRegistry: () => create(e, read(e)),
  };
});
vi.mock("@/server/media-qa", () => ({ getMediaQaRepo: async () => ({ assetPins: async () => [] }) }));
vi.mock("@/server/previs", () => ({
  getPrevisRepo: async () => ({
    spatialPassUsesAsset: async () => false,
    reconstructionUsesAsset: async () => false,
  }),
}));
vi.mock("@/server/ingest-upload", () => ({
  discardUpload: vi.fn(async () => {}),
  hasFile: () => false,
  ingestUpload: vi.fn(),
}));

import { deleteAsset } from "../actions";
import {
  removeBackground,
  saveAsCharacterReference,
  saveAsLookReference,
  startSubjectImage,
} from "../subject-image-actions";
import {
  addExpressionReference,
  clearVisualBibleDesignation,
  setCanonicalIdentity,
  setCharacterCutout,
} from "../visual-bible-actions";

const sinkRoot = mkdtempSync(path.join(tmpdir(), "prism-i4-"));
afterAll(() => rmSync(sinkRoot, { recursive: true, force: true }));
let repo: MemoryRepository;
let sink: LocalDiskSink;
let t = Date.now();
beforeEach(() => {
  repo = new MemoryRepository();
  world.repo = repo;
  sink = new LocalDiskSink(sinkRoot);
});
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries({ projectSlug: "ojousama", ...fields })) f.set(k, v);
  return f;
};
const data = async () => (await repo.loadProject("ojousama"))!;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const byName = async (name: string) => (await data()).characters.find((c) => c.name === name)!;
const lookOf = async (characterId: string) => {
  const d = await data();
  const l = d.looks.find((x) => x.characterId === characterId)!;
  if (l.locked) await repo.upsert(d.project.id, "looks", { ...l, locked: false });
  return l;
};

async function work(ticks = 8) {
  const config = readGenerationConfig(env);
  const worker = new GenerationWorker({
    store: repo.generation,
    registry: createRegistry(env, config),
    sink,
    config,
    logger: { info() {}, warn() {}, error() {} },
    clock: () => new Date(t),
  });
  for (let i = 0; i < ticks; i++) {
    await worker.tick(5);
    t += 2000;
  }
}

/** A stored image attached to the Character as an ordinary identity reference ("uploaded"). */
async function uploaded(
  characterId: string,
  label: string,
  slot: "front" | "three_quarter" | "profile" | "full_body" | "additional" = "additional",
  w = 96,
  h = 120,
): Promise<Asset> {
  const d = await data();
  const bytes = portraitFixturePng(w, h);
  const id = randomUUID();
  const objectPath = `${d.project.id}/fixtures/${id}.png`;
  await sink.put(objectPath, bytes);
  const asset = {
    ...d.assets[0]!,
    id,
    projectId: d.project.id,
    type: "image",
    purpose: "identity_ref",
    source: "upload",
    name: `${label}.png`,
    originalFilename: `${label}.png`,
    storageProvider: "local",
    bucket: null,
    objectPath,
    mime: "image/png",
    byteSize: bytes.length,
    checksum: sha(bytes),
    width: decodePng(bytes).width,
    height: decodePng(bytes).height,
    durationMs: null,
    metadata: {},
  } as Asset;
  await repo.upsert(d.project.id, "assets", asset);
  const existing = d.identityRefs.find(
    (r) => r.characterId === characterId && r.slot === slot && slot !== "additional",
  );
  await repo.upsert(d.project.id, "identityRefs", {
    id: existing?.id ?? randomUUID(),
    characterId,
    slot,
    assetId: id,
    label,
    metadata: {},
    locked: false,
  });
  return asset;
}

/** A Look reference stored and attached to the Look. */
async function lookImage(characterId: string, label: string): Promise<Asset> {
  const a = await uploaded(characterId, label);
  const d = await data();
  const look = d.looks.find((l) => l.characterId === characterId)!;
  // the Look keeps its lock state (a Shot's generation gate requires its Looks locked)
  await repo.upsert(d.project.id, "looks", { ...look, referenceAssetIds: [...look.referenceAssetIds, a.id] });
  return a;
}

const canonicalOf = async (characterId: string) =>
  (await data()).identityRefs.find((r) => r.characterId === characterId && visualRoleOf(r) === "canonical");

describe("5B-I4 Character Visual Bible", () => {
  it("canonical identity: set explicitly; replacement needs explicit confirmation; generation never replaces it", async () => {
    const y = await byName("Yumeko");
    const a = await uploaded(y.id, "Yumeko portrait A");
    const b = await uploaded(y.id, "Yumeko portrait B");
    expect(await setCanonicalIdentity(form({ characterId: y.id, assetId: a.id }))).toMatchObject({
      ok: true,
    });
    expect((await canonicalOf(y.id))?.assetId).toBe(a.id);
    expect(visualBibleReadiness(await data(), y.id).canonicalAssetId).toBe(a.id);
    // replacing needs an explicit confirmation
    expect(await setCanonicalIdentity(form({ characterId: y.id, assetId: b.id }))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/already has a canonical identity/),
    });
    expect((await canonicalOf(y.id))?.assetId).toBe(a.id);
    expect(
      await setCanonicalIdentity(form({ characterId: y.id, assetId: b.id, confirmReplace: "1" })),
    ).toMatchObject({ ok: true });
    const d = await data();
    expect(
      d.identityRefs.filter((r) => r.characterId === y.id && visualRoleOf(r) === "canonical"),
    ).toHaveLength(1);
    expect((await canonicalOf(y.id))?.assetId).toBe(b.id);
    expect(d.assets.some((x) => x.id === a.id)).toBe(true); // the old image stays in the library
    // generation never touches the canonical identity
    await startSubjectImage(
      form({
        subjectKind: "character",
        subjectId: y.id,
        intent: "portrait",
        model: "mock/mock-image-1",
        aspectRatio: "1:1",
      }),
    );
    await work();
    expect((await canonicalOf(y.id))?.assetId).toBe(b.id);
  });

  it("refuses an image of another Character or outside the project; sources stay immutable", async () => {
    const y = await byName("Yumeko");
    const s = await byName("Sean");
    const seanImg = await uploaded(s.id, "Sean portrait");
    const before = structuredClone((await data()).assets.find((x) => x.id === seanImg.id));
    expect(await setCanonicalIdentity(form({ characterId: y.id, assetId: seanImg.id }))).toMatchObject({
      ok: false,
      error: "That image does not belong to this character.",
    });
    expect(await setCanonicalIdentity(form({ characterId: y.id, assetId: randomUUID() }))).toMatchObject({
      ok: false,
    });
    expect(await setCanonicalIdentity(form({ characterId: s.id, assetId: seanImg.id }))).toMatchObject({
      ok: true,
    });
    expect((await data()).assets.find((x) => x.id === seanImg.id)).toEqual(before);
    expect(sha((await sink.get(seanImg.objectPath!))!)).toBe(seanImg.checksum);
  });

  it("refuses an asset of ANOTHER project, for every designation", async () => {
    const d = await data();
    const y = d.characters.find((c) => c.name === "Yumeko")!;
    const otherId = randomUUID();
    await repo.createProject(
      { ...d.project, id: otherId, slug: "other-project", title: "Other" },
      { ...d.bible, projectId: otherId },
    );
    const foreign = { ...(await uploaded(y.id, "probe")), id: randomUUID(), projectId: otherId };
    await repo.upsert(otherId, "assets", { ...foreign, metadata: { hasAlpha: true } });
    const f = (extra: Record<string, string>) =>
      form({ characterId: y.id, assetId: foreign.id, confirmReplace: "1", ...extra });
    for (const action of [setCanonicalIdentity, setCharacterCutout])
      expect(await action(f({}))).toMatchObject({
        ok: false,
        error: "That image does not belong to this character.",
      });
    expect(await addExpressionReference(f({ expression: "happy" }))).toMatchObject({ ok: false });
    expect((await data()).identityRefs.some((r) => r.assetId === foreign.id)).toBe(false);
  });

  it("supporting references, Look references, expressions and the cutout fill the readiness checklist", async () => {
    const y = await byName("Yumeko");
    const look = await lookOf(y.id);
    const canonical = await uploaded(y.id, "Yumeko canonical");
    await setCanonicalIdentity(form({ characterId: y.id, assetId: canonical.id }));
    await uploaded(y.id, "Yumeko 3/4", "three_quarter");
    await uploaded(y.id, "Yumeko full body", "full_body");
    // a generated portrait becomes the front reference and a Look reference through the EXISTING actions
    await startSubjectImage(
      form({
        subjectKind: "character",
        subjectId: y.id,
        intent: "portrait",
        model: "mock/mock-image-1",
        aspectRatio: "1:1",
      }),
    );
    await work();
    const gen = (
      await repo.generation.listSubjectImageAttempts({ kind: "character", characterId: y.id })
    )[0]!;
    // the seeded front slot is locked: the creator unlocks it explicitly before replacing its image
    const d0 = await data();
    const front = d0.identityRefs.find((r) => r.characterId === y.id && r.slot === "front");
    if (front?.locked) await repo.upsert(d0.project.id, "identityRefs", { ...front, locked: false });
    expect(
      await saveAsCharacterReference(form({ characterId: y.id, attemptId: gen.attempt.id, slot: "front" })),
    ).toMatchObject({ ok: true });
    expect(await saveAsLookReference(form({ lookId: look.id, attemptId: gen.attempt.id }))).toMatchObject({
      ok: true,
    });
    // expressions: a suggested and a custom name
    expect(
      await addExpressionReference(form({ characterId: y.id, assetId: canonical.id, expression: "Happy" })),
    ).toMatchObject({ ok: true });
    expect(
      await addExpressionReference(
        form({ characterId: y.id, assetId: canonical.id, expression: "quietly furious" }),
      ),
    ).toMatchObject({ ok: true });
    // the cutout must be transparent: the canonical (opaque) is refused; a background-removal output is accepted
    expect(await setCharacterCutout(form({ characterId: y.id, assetId: canonical.id }))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/transparent PNG/),
    });
    expect(
      await removeBackground(
        form({ subjectKind: "character", subjectId: y.id, sourceAssetId: canonical.id }),
      ),
    ).toMatchObject({ ok: true });
    await work();
    const cut = (
      await repo.generation.listSubjectImageAttempts({ kind: "character", characterId: y.id })
    ).find((v) => (v.attempt.modelSettings as { purpose?: string }).purpose === "background_removal")!;
    expect(cut.attempt.status).toBe("succeeded");
    expect(await setCharacterCutout(form({ characterId: y.id, attemptId: cut.attempt.id }))).toMatchObject({
      ok: true,
    });
    const vb = visualBibleReadiness(await data(), y.id);
    const done = Object.fromEntries(vb.items.map((i) => [i.key, i.done]));
    expect(done).toEqual({
      canonical: true,
      look: true,
      front: true,
      three_quarter: true,
      profile: false, // guidance, not a gate
      full_body: true,
      cutout: true,
      expressions: true,
    });
    expect(vb.items.find((i) => i.key === "profile")!.suggestion).toMatch(/profile reference/);
    expect(vb.expressions.map((e) => e.expression).sort()).toEqual(["happy", "quietly furious"]);
    expect(vb.cutoutAssetId).toBe(cut.outputs[0]!.asset.id);
  });

  it("a designated cutout is pinned against deletion; removing the designation restores the normal rules", async () => {
    const y = await byName("Yumeko");
    const src = await uploaded(y.id, "Yumeko portrait");
    await removeBackground(form({ subjectKind: "character", subjectId: y.id, sourceAssetId: src.id }));
    await work();
    const cut = (
      await repo.generation.listSubjectImageAttempts({ kind: "character", characterId: y.id })
    )[0]!;
    const out = cut.outputs[0]!.asset;
    await setCharacterCutout(form({ characterId: y.id, attemptId: cut.attempt.id }));
    expect(await deleteAsset(form({ assetId: out.id }))).toMatchObject({
      ok: false,
      error: expect.stringContaining("in use"),
    });
    const ref = (await data()).identityRefs.find(
      (r) => r.characterId === y.id && visualRoleOf(r) === "cutout",
    )!;
    expect(await clearVisualBibleDesignation(form({ characterId: y.id, refId: ref.id }))).toMatchObject({
      ok: true,
    });
    expect(await deleteAsset(form({ assetId: out.id }))).toMatchObject({ ok: true });
  });

  it("a later Character image generation leads with canonical identity, then the selected Look, then other references", async () => {
    const y = await byName("Yumeko");
    const look = await lookOf(y.id);
    const other = await uploaded(y.id, "Yumeko extra", "three_quarter");
    const lookRef = await lookImage(y.id, "Yumeko gown");
    const canonical = await uploaded(y.id, "Yumeko canonical");
    await setCanonicalIdentity(form({ characterId: y.id, assetId: canonical.id }));
    await startSubjectImage(
      form({
        subjectKind: "character",
        subjectId: y.id,
        intent: "full_body",
        lookId: look.id,
        model: "mock/mock-image-1",
        aspectRatio: "1:1",
      }),
    );
    const gen = (
      await repo.generation.listSubjectImageAttempts({ kind: "character", characterId: y.id })
    )[0]!;
    const refs = (gen.attempt.request as { references: Array<{ assetId: string; role: string }> }).references;
    expect(refs[0]).toMatchObject({ assetId: canonical.id, role: "identity" });
    expect(refs[1]).toMatchObject({ assetId: lookRef.id, role: "character_look" });
    expect(refs.map((r) => r.assetId)).toContain(other.id);
    expect(gen.attempt.modelSettings).toMatchObject({ intent: "full_body" });
  });
});

describe("5B-I4 Ojou-sama acceptance: Shots consume the Visual Bible automatically", () => {
  async function ojousamaBible() {
    const out: Record<string, { canonical: Asset; look: Asset }> = {};
    for (const name of ["Yumeko", "Sean", "Takumi"]) {
      const c = await byName(name);
      const look = await lookImage(c.id, `${name} look`);
      const canonical = await uploaded(c.id, `${name} canonical`);
      expect(await setCanonicalIdentity(form({ characterId: c.id, assetId: canonical.id }))).toMatchObject({
        ok: true,
      });
      out[name] = { canonical, look };
    }
    return out;
  }

  it("Yumeko, Sean and Takumi each have a canonical identity and their Look (Formal / Charcoal / Navy) with references", async () => {
    await ojousamaBible();
    const d = await data();
    for (const [name, lookWord] of [
      ["Yumeko", "Formal"],
      ["Sean", "Charcoal"],
      ["Takumi", "Navy"],
    ] as const) {
      const c = d.characters.find((x) => x.name === name)!;
      const vb = visualBibleReadiness(d, c.id);
      expect(vb.canonicalAssetId).not.toBeNull();
      expect(vb.looks.find((l) => l.look.name.includes(lookWord))?.storedReferences).toBeGreaterThan(0);
    }
  });

  it("a Shot with Yumeko sends her canonical identity first and her selected Look next — no manual attaching", async () => {
    const bible = await ojousamaBible();
    const d = await data();
    const y = d.characters.find((c) => c.name === "Yumeko")!;
    const shot = d.shots.find((s) => s.characters.some((a) => a.characterId === y.id && a.lookId))!;
    const pkg = assembleGenerationPackage(buildShotContext(d, shot.id));
    const entry = pkg.characters.find((c) => c.characterId === y.id)!;
    expect(entry.canonicalIdentityAssetId).toBe(bible.Yumeko!.canonical.id);
    const candidates = deriveReferenceCandidates(pkg);
    const mine = candidates.filter((c) =>
      [bible.Yumeko!.canonical.id, bible.Yumeko!.look.id].includes(c.assetId),
    );
    expect(mine.map((c) => [c.assetId, c.role])).toEqual([
      [bible.Yumeko!.canonical.id, "identity"],
      [bible.Yumeko!.look.id, "character_look"],
    ]);
    // a Production Frame candidate request on a 2-reference model keeps the highest-priority images, explicitly
    const config = readGenerationConfig(env);
    await repo.upsert(d.project.id, "shots", {
      ...shot,
      composition: { ...shot.composition, aspectRatio: "16:9" },
      updatedAt: new Date(t - 1000).toISOString(),
    });
    const fresh = await data();
    const prepared = prepareSubmission({
      data: fresh,
      shotId: shot.id,
      registry: createRegistry(env, config),
      provider: "mock",
      modelId: "mock-image-lite",
      acknowledged: [],
      purpose: "production_frame",
      userId: null,
      idempotencyKey: "i4-shot-key",
      config,
    });
    const ignored = prepared.evaluation.compatibility?.ignoredFeatures.map((f) => f.id) ?? [];
    const final = prepareSubmission({
      data: fresh,
      shotId: shot.id,
      registry: createRegistry(env, config),
      provider: "mock",
      modelId: "mock-image-lite",
      acknowledged: ignored,
      purpose: "production_frame",
      userId: null,
      idempotencyKey: "i4-shot-key",
      config,
    });
    expect(final.input, final.evaluation.gate.blockers.map((b) => b.message).join(" ")).not.toBeNull();
    const sent = (final.input!.attempt.request as { references: Array<{ assetId: string }> }).references.map(
      (r) => r.assetId,
    );
    expect(sent).toHaveLength(2);
    expect(sent[0]).toBe(bible.Yumeko!.canonical.id);
    // the provenance says what was NOT sent (ignored features acknowledged, nothing silently dropped)
    expect(final.input!.attempt.inputAssetIds).toContain(bible.Yumeko!.canonical.id);
  });

  it("changing the canonical identity makes the Shot's earlier approval stale (it is part of the identity fingerprint)", async () => {
    const y = await byName("Yumeko");
    const a = await uploaded(y.id, "A");
    const b = await uploaded(y.id, "B");
    const d0 = await data();
    const shot = d0.shots.find((s) => s.characters.some((x) => x.characterId === y.id))!;
    await setCanonicalIdentity(form({ characterId: y.id, assetId: a.id }));
    const f1 = approvalSnapshot(buildShotContext(await data(), shot.id)).fingerprint;
    await setCanonicalIdentity(form({ characterId: y.id, assetId: b.id, confirmReplace: "1" }));
    const f2 = approvalSnapshot(buildShotContext(await data(), shot.id)).fingerprint;
    expect(f2).not.toBe(f1);
  });
});
