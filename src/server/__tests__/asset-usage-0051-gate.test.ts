import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRepository } from "@/data/memory-repository";
import { readGenerationConfig } from "@/generation/config";
import { submitCandidateSet } from "@/generation/candidate-set";
import { createRegistry } from "@/generation/registry";
import { LocalDiskSink } from "@/generation/sink";
import { GenerationWorker } from "@/generation/worker";

/**
 * 0051 SHARED-DATABASE COMPATIBILITY GATE (Phase 5B-I1). A generated Character / Location image is deletable exactly
 * when nothing in the project references it; its own generation attempt is provenance (kept, output nulled), not a
 * use. Shot / Production Frame / Storyboard behaviour is unchanged: a Shot attempt's output stays pinned.
 * The Postgres twin (the `assets_release_subject_image_outputs` trigger) is proven by `scripts/db-generation-subjects.mts`.
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
    // the real requireProjectFresh attaches Production Frames, Location Views and Continuity Locks (server/repo.ts)
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
// the other delete pins (media QA lineage, spatial bundles, reconstructions) are not under test here
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
import { createLocationViewFromReference } from "../location-view-actions";
import {
  saveAsCharacterReference,
  saveAsLocationReference,
  startSubjectImage,
} from "../subject-image-actions";

const sinkRoot = mkdtempSync(path.join(tmpdir(), "prism-0051-gate-"));
afterAll(() => rmSync(sinkRoot, { recursive: true, force: true }));

let repo: MemoryRepository;
let t = Date.now();
beforeEach(() => {
  repo = new MemoryRepository();
  world.repo = repo;
});

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries({ projectSlug: "ojousama", ...fields })) f.set(k, v);
  return f;
};
const data = async () => (await repo.loadProject("ojousama"))!;

async function runWorker() {
  const config = readGenerationConfig(env);
  const worker = new GenerationWorker({
    store: repo.generation,
    registry: createRegistry(env, config),
    sink: new LocalDiskSink(sinkRoot),
    config,
    logger: { info() {}, warn() {}, error() {} },
    clock: () => new Date(t),
  });
  for (let i = 0; i < 12; i++) {
    await worker.tick(5);
    t += 2000;
  }
}

/** Generate one image for a Character or Location and return its attempt id and output Asset id. */
async function generated(subjectKind: "character" | "location", subjectId: string) {
  const intent = subjectKind === "character" ? "portrait" : "establishing_view";
  const r = await startSubjectImage(
    form({ model: "mock/mock-image-1", aspectRatio: "1:1", subjectKind, subjectId, intent }),
  );
  expect(r).toMatchObject({ ok: true });
  await runWorker();
  const views = await repo.generation.listSubjectImageAttempts(
    subjectKind === "character"
      ? { kind: "character", characterId: subjectId }
      : { kind: "location", locationId: subjectId },
  );
  const v = views[0]!;
  expect(v.attempt.status).toBe("succeeded");
  return { attemptId: v.attempt.id, assetId: v.outputs[0]!.asset.id };
}

const del = (assetId: string) => deleteAsset(form({ assetId }));
const refused = { ok: false, error: expect.stringContaining("in use") };

async function unlockLocation(id: string) {
  const d = await data();
  const loc = d.locations.find((l) => l.id === id)!;
  await repo.upsert(d.project.id, "locations", { ...loc, locked: false });
}

describe("0051 shared-database compatibility gate — asset usage", () => {
  it("1 + 5: an unreferenced generated Character image may be deleted; its attempt is kept with no output", async () => {
    const yumeko = (await data()).characters.find((c) => c.name === "Yumeko")!;
    const { attemptId, assetId } = await generated("character", yumeko.id);
    expect(await del(assetId)).toMatchObject({ ok: true });
    expect((await data()).assets.some((a) => a.id === assetId)).toBe(false);
    const kept = await repo.generation.getSubjectImageAttempt(attemptId);
    expect(kept).not.toBeNull();
    expect(kept!.attempt).toMatchObject({ status: "succeeded", outputAssetId: null });
    expect(kept!.outputs).toEqual([]);
  });

  it("2 + 5: a referenced Character image (reference slot, Look) may not be deleted; removing the references frees it", async () => {
    const d0 = await data();
    const yumeko = d0.characters.find((c) => c.name === "Yumeko")!;
    const { attemptId, assetId } = await generated("character", yumeko.id);
    // as a Character reference (an unlocked, new slot)
    expect(
      await saveAsCharacterReference(
        form({ characterId: yumeko.id, attemptId, slot: "additional", label: "gen" }),
      ),
    ).toMatchObject({ ok: true });
    expect(await del(assetId)).toMatchObject(refused);
    // also as a Look reference
    const d1 = await data();
    const look = d1.looks.find((l) => l.characterId === yumeko.id)!;
    await repo.upsert(d1.project.id, "looks", {
      ...look,
      locked: false,
      referenceAssetIds: [...look.referenceAssetIds, assetId],
    });
    // drop the Character reference: the Look still pins it
    const d2 = await data();
    const ref = d2.identityRefs.find((r) => r.assetId === assetId)!;
    await repo.remove(d2.project.id, "identityRefs", ref.id);
    expect(await del(assetId)).toMatchObject({ ok: false, error: expect.stringContaining("Look") });
    // drop the Look reference: nothing references it any more
    const d3 = await data();
    const l3 = d3.looks.find((l) => l.id === look.id)!;
    await repo.upsert(d3.project.id, "looks", {
      ...l3,
      referenceAssetIds: l3.referenceAssetIds.filter((x) => x !== assetId),
    });
    expect(await del(assetId)).toMatchObject({ ok: true });
  });

  it("a generated Character image sent as an INPUT to a later image attempt stays pinned by that attempt", async () => {
    const yumeko = (await data()).characters.find((c) => c.name === "Yumeko")!;
    const first = await generated("character", yumeko.id);
    expect(
      await saveAsCharacterReference(
        form({ characterId: yumeko.id, attemptId: first.attemptId, slot: "additional", label: "gen" }),
      ),
    ).toMatchObject({ ok: true });
    await generated("character", yumeko.id); // the new reference is sent with this request
    const second = (
      await repo.generation.listSubjectImageAttempts({ kind: "character", characterId: yumeko.id })
    )[0]!;
    expect(second.attempt.inputAssetIds).toContain(first.assetId);
    const d = await data();
    await repo.remove(
      d.project.id,
      "identityRefs",
      d.identityRefs.find((r) => r.assetId === first.assetId)!.id,
    );
    expect(await del(first.assetId)).toMatchObject({
      ok: false,
      error: expect.stringContaining('Character "Yumeko" · image attempt'),
    });
  });

  it("3 + 4 + 5: Location image - unreferenced deletable; a Location reference pins it until removed", async () => {
    const loc = (await data()).locations[0]!;
    const free = await generated("location", loc.id);
    expect(await del(free.assetId)).toMatchObject({ ok: true });

    const used = await generated("location", loc.id);
    await unlockLocation(loc.id);
    expect(
      await saveAsLocationReference(form({ locationId: loc.id, attemptId: used.attemptId })),
    ).toMatchObject({
      ok: true,
    });
    expect(await del(used.assetId)).toMatchObject(refused);
    const d1 = await data();
    const l1 = d1.locations.find((l) => l.id === loc.id)!;
    await repo.upsert(d1.project.id, "locations", {
      ...l1,
      referenceAssetIds: l1.referenceAssetIds.filter((x) => x !== used.assetId),
    });
    expect(await del(used.assetId)).toMatchObject({ ok: true });
    expect((await repo.generation.getSubjectImageAttempt(used.attemptId))!.attempt.outputAssetId).toBeNull();
  });

  it("4: a Location View made from a generated Location image pins it (views are immutable)", async () => {
    const loc = (await data()).locations[0]!;
    const used = await generated("location", loc.id);
    await unlockLocation(loc.id);
    expect(
      await saveAsLocationReference(form({ locationId: loc.id, attemptId: used.attemptId })),
    ).toMatchObject({
      ok: true,
    });
    expect(
      await createLocationViewFromReference(
        form({
          locationId: loc.id,
          assetId: used.assetId,
          lv_name: "Generated view",
          lv_kind: "establishing",
        }),
      ),
    ).toMatchObject({ ok: true });
    const d1 = await data();
    const l1 = d1.locations.find((l) => l.id === loc.id)!;
    await repo.upsert(d1.project.id, "locations", {
      ...l1,
      referenceAssetIds: l1.referenceAssetIds.filter((x) => x !== used.assetId),
    });
    expect(await del(used.assetId)).toMatchObject({
      ok: false,
      error: expect.stringContaining("Location View"),
    });
  });

  it("6: Shot behaviour is unchanged — a Shot attempt's output (Production Frame workflow) is never deletable", async () => {
    const d0 = await data();
    const shot = d0.shots.find((s) => s.shotCode === "1A")!;
    await repo.upsert(d0.project.id, "shots", {
      ...shot,
      composition: { ...shot.composition, aspectRatio: "16:9" },
      updatedAt: new Date(t - 1000).toISOString(),
    });
    const config = readGenerationConfig(env);
    await submitCandidateSet({
      data: await data(),
      shotId: shot.id,
      registry: createRegistry(env, config),
      config,
      generation: repo.generation,
      candidates: repo.candidates,
      selections: [{ provider: "mock", modelId: "mock-image-1" }],
      acknowledgeAll: true,
      confirmedTotalUsd: null,
      title: "Production Frame candidate",
      purpose: "",
      userId: null,
      projectRevision: null,
      generationPurpose: "production_frame",
      now: new Date(t),
    });
    await runWorker();
    const d1 = await data();
    const a = d1.attempts.find((x) => x.shotId === shot.id && x.status === "succeeded" && x.outputAssetId)!;
    expect(await del(a.outputAssetId!)).toMatchObject({
      ok: false,
      error: expect.stringContaining(`Shot 1A · attempt ${a.attemptNumber} output`),
    });
    // the Shot attempt still owns its output (nothing was released)
    expect((await repo.generation.getAttemptView(a.id))!.outputs.length).toBeGreaterThan(0);
    // and a seeded Storyboard frame's image is still refused
    const frame = d1.frames.find((f) => f.assetId)!;
    expect(await del(frame.assetId!)).toMatchObject(refused);
  });
});
