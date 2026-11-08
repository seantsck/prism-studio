import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRepository } from "@/data/memory-repository";
import { buildShotContext } from "@/domain/context";
import { candidateInputStaleness } from "@/domain/generated-production-frame";
import { shotEditableAssetIds } from "@/domain/generation/image-edit";
import { submitCandidateSet } from "@/generation/candidate-set";
import { readGenerationConfig } from "@/generation/config";
import { createRegistry } from "@/generation/registry";
import { LocalDiskSink } from "@/generation/sink";
import { GenerationWorker } from "@/generation/worker";

/**
 * Phase 5B-I2 acceptance through the REAL server actions, the real queue and worker, and the FREE mock image models:
 * Edit Image (Character, Location, Shot), lineage, promotion (Character reference, Look, Location reference, Location
 * View, Storyboard / Production Frame flows), and the transparency refusal. No provider; no paid call.
 */
vi.setConfig({ testTimeout: 60_000 });
const env = {
  NODE_ENV: "test",
  PRISM_STUDIO_MOCK_STAGE_DELAY_MS: "0",
  PRISM_STUDIO_ENABLE_MOCK_PROVIDER: "1",
};
const world = vi.hoisted(() => ({ repo: null as unknown, created: [] as FormData[] }));
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
      return {
        ...data,
        productionFrames: pf.frames,
        productionFrameSelections: pf.selections,
        locationViews: lv.views,
        shotLocationViewSelections: lv.selections,
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
vi.mock("@/server/candidate-actions", () => ({
  createCandidateSet: async (fd: FormData) => {
    world.created.push(fd);
    return { ok: true };
  },
}));

import { startShotImage } from "../shot-image-actions";
import {
  saveAsCharacterReference,
  saveAsLocationView,
  saveAsLookReference,
  startSubjectImage,
} from "../subject-image-actions";

const sinkRoot = mkdtempSync(path.join(tmpdir(), "prism-i2-edit-"));
afterAll(() => rmSync(sinkRoot, { recursive: true, force: true }));

let repo: MemoryRepository;
let t = Date.now();
beforeEach(() => {
  repo = new MemoryRepository();
  world.repo = repo;
  world.created.length = 0;
});
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries({ projectSlug: "ojousama", ...fields })) f.set(k, v);
  return f;
};
const data = async () => (await repo.loadProject("ojousama"))!;
async function work() {
  const config = readGenerationConfig(env);
  const worker = new GenerationWorker({
    store: repo.generation,
    registry: createRegistry(env, config),
    sink: new LocalDiskSink(sinkRoot),
    config,
    logger: { info() {}, warn() {}, error() {} },
    clock: () => new Date(t),
  });
  for (let i = 0; i < 10; i++) {
    await worker.tick(5);
    t += 2000;
  }
}
const characterViews = async (characterId: string) =>
  repo.generation.listSubjectImageAttempts({ kind: "character", characterId });
const locationViews = async (locationId: string) =>
  repo.generation.listSubjectImageAttempts({ kind: "location", locationId });

describe("5B-I2 Edit Image — Character", () => {
  it("source → edit attempt → NEW image; the source is unchanged; the result promotes to Character reference and Look", async () => {
    const d0 = await data();
    const yumeko = d0.characters.find((c) => c.name === "Yumeko")!;
    const gen = {
      subjectKind: "character",
      subjectId: yumeko.id,
      intent: "portrait",
      model: "mock/mock-image-1",
      aspectRatio: "1:1",
    };
    expect(await startSubjectImage(form(gen))).toMatchObject({ ok: true });
    await work();
    const [first] = await characterViews(yumeko.id);
    const source = first!.outputs[0]!.asset;
    const before = structuredClone((await data()).assets.find((a) => a.id === source.id));

    const r = await startSubjectImage(
      form({ ...gen, sourceAssetId: source.id, instruction: "change the coat to dark green" }),
    );
    expect(r).toMatchObject({ ok: true });
    await work();
    const edited = (await characterViews(yumeko.id))[0]!;
    expect(edited.attempt.id).not.toBe(first!.attempt.id);
    expect(edited.attempt.status).toBe("succeeded");
    // lineage: source → attempt → output
    expect(edited.attempt.modelSettings).toMatchObject({ editSourceAssetId: source.id });
    expect(edited.attempt.inputAssetIds).toContain(source.id);
    expect(edited.attempt.request).toMatchObject({ modality: "image_to_image" });
    expect(
      (edited.attempt.request as { references: Array<{ assetId: string; order: number }> }).references[0],
    ).toMatchObject({
      assetId: source.id,
      order: 0,
    });
    expect(edited.attempt.prompt).toMatch(/change the coat to dark green/);
    const output = edited.outputs[0]!.asset;
    expect(output.id).not.toBe(source.id);
    // the source Asset is byte-for-byte the same row
    expect((await data()).assets.find((a) => a.id === source.id)).toEqual(before);

    // promotion through the EXISTING actions
    expect(
      await saveAsCharacterReference(
        form({ characterId: yumeko.id, attemptId: edited.attempt.id, slot: "additional" }),
      ),
    ).toMatchObject({ ok: true });
    const d1 = await data();
    const look = d1.looks.find((l) => l.characterId === yumeko.id)!;
    if (look.locked) await repo.upsert(d1.project.id, "looks", { ...look, locked: false });
    expect(await saveAsLookReference(form({ lookId: look.id, attemptId: edited.attempt.id }))).toMatchObject({
      ok: true,
    });
    const d2 = await data();
    expect(d2.identityRefs.some((x) => x.assetId === output.id)).toBe(true);
    expect(d2.looks.find((l) => l.id === look.id)!.referenceAssetIds).toContain(output.id);
  });

  it("refuses an edit source that is not this subject's image, and an empty instruction", async () => {
    const d0 = await data();
    const [a, b] = d0.characters;
    const gen = {
      subjectKind: "character",
      subjectId: b!.id,
      intent: "portrait",
      model: "mock/mock-image-1",
      aspectRatio: "1:1",
    };
    expect(await startSubjectImage(form(gen))).toMatchObject({ ok: true });
    await work();
    const foreign = (await characterViews(b!.id))[0]!.outputs[0]!.asset.id;
    expect(
      await startSubjectImage(form({ ...gen, subjectId: a!.id, sourceAssetId: foreign, instruction: "x" })),
    ).toMatchObject({ ok: false, error: "That image does not belong to this subject." });
    expect(await startSubjectImage(form({ ...gen, sourceAssetId: foreign, instruction: "" }))).toMatchObject({
      ok: false,
      error: "Describe the edit.",
    });
  });

  it("Transparent background is refused, never faked, for a model without native transparency", async () => {
    const d0 = await data();
    const yumeko = d0.characters.find((c) => c.name === "Yumeko")!;
    const before = (await characterViews(yumeko.id)).length;
    expect(
      await startSubjectImage(
        form({
          subjectKind: "character",
          subjectId: yumeko.id,
          intent: "portrait",
          model: "mock/mock-image-1",
          aspectRatio: "1:1",
          transparent: "1",
        }),
      ),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/cannot make transparent backgrounds/) });
    expect(await characterViews(yumeko.id)).toHaveLength(before);
  });
});

describe("5B-I2 Edit Image — Location", () => {
  it("an edited Location image is a new image and becomes a Location View through the existing view action", async () => {
    const d0 = await data();
    const loc = d0.locations[0]!;
    if (loc.locked) await repo.upsert(d0.project.id, "locations", { ...loc, locked: false });
    const gen = {
      subjectKind: "location",
      subjectId: loc.id,
      intent: "establishing_view",
      model: "mock/mock-image-1",
      aspectRatio: "1:1",
    };
    expect(await startSubjectImage(form(gen))).toMatchObject({ ok: true });
    await work();
    const source = (await locationViews(loc.id))[0]!.outputs[0]!.asset;
    expect(
      await startSubjectImage(form({ ...gen, sourceAssetId: source.id, instruction: "make it dusk" })),
    ).toMatchObject({ ok: true });
    await work();
    const edited = (await locationViews(loc.id))[0]!;
    expect(edited.attempt.modelSettings).toMatchObject({ editSourceAssetId: source.id });
    const out = edited.outputs[0]!.asset;
    expect(
      await saveAsLocationView(
        form({ locationId: loc.id, attemptId: edited.attempt.id, lv_name: "Dusk view" }),
      ),
    ).toMatchObject({ ok: true });
    const views = (await repo.locationViews.listForProject(d0.project.id)).views;
    expect(views.some((v) => v.assetId === out.id && v.name === "Dusk view")).toBe(true);
    expect((await data()).locations.find((l) => l.id === loc.id)!.referenceAssetIds).toContain(out.id);
  });

  it("Use as Location View respects the Location lock", async () => {
    const d0 = await data();
    const loc = d0.locations[0]!;
    await repo.upsert(d0.project.id, "locations", { ...loc, locked: false });
    expect(
      await startSubjectImage(
        form({
          subjectKind: "location",
          subjectId: loc.id,
          intent: "background",
          model: "mock/mock-image-1",
          aspectRatio: "1:1",
        }),
      ),
    ).toMatchObject({ ok: true });
    await work();
    const v = (await locationViews(loc.id))[0]!;
    const d1 = await data();
    await repo.upsert(d1.project.id, "locations", {
      ...d1.locations.find((l) => l.id === loc.id)!,
      locked: true,
    });
    expect(await saveAsLocationView(form({ locationId: loc.id, attemptId: v.attempt.id }))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/locked/),
    });
  });
});

describe("5B-I2 Edit Image — Shot (the existing Production Frame candidate workflow)", () => {
  it("the action delegates ONE model with the edit and the transparency flag; nothing else changes", async () => {
    expect(
      await startShotImage(
        form({
          shotId: "s1",
          kind: "edit",
          model: "mock/mock-image-1",
          sourceAssetId: "a1",
          instruction: "rain",
          transparent: "1",
        }),
      ),
    ).toEqual({ ok: true });
    const fd = world.created[0]!;
    expect(fd.get("generationPurpose")).toBe("production_frame");
    expect(JSON.parse(String(fd.get("selections")))).toEqual([
      {
        provider: "mock",
        modelId: "mock-image-1",
        background: "transparent",
        edit: { sourceAssetId: "a1", instruction: "rain" },
      },
    ]);
    expect(
      await startShotImage(
        form({ shotId: "s1", kind: "edit", model: "mock/mock-image-1", instruction: "rain" }),
      ),
    ).toMatchObject({
      ok: false,
      error: "Choose the image to edit.",
    });
  });

  it("an edited still is a NEW Production Frame candidate: source first, instruction in the plan, lineage recorded", async () => {
    const config = readGenerationConfig(env);
    const registry = createRegistry(env, config);
    const d0 = await data();
    const shot = d0.shots.find((s) => s.shotCode === "1A")!;
    await repo.upsert(d0.project.id, "shots", {
      ...shot,
      composition: { ...shot.composition, aspectRatio: "16:9" },
      updatedAt: new Date(t - 1000).toISOString(),
    });
    const base = {
      shotId: shot.id,
      registry,
      config,
      generation: repo.generation,
      candidates: repo.candidates,
      acknowledgeAll: true,
      confirmedTotalUsd: null,
      title: "Production Frame candidate",
      purpose: "",
      userId: null,
      projectRevision: null,
      generationPurpose: "production_frame" as const,
    };
    await submitCandidateSet({
      ...base,
      data: await data(),
      selections: [{ provider: "mock", modelId: "mock-image-1" }],
      now: new Date(t),
    });
    await work();
    const d1 = await data();
    const still = d1.attempts.find(
      (a) => a.shotId === shot.id && a.status === "succeeded" && a.outputAssetId,
    )!;
    const sourceId = still.outputAssetId!;
    expect(shotEditableAssetIds(d1, shot.id).has(sourceId)).toBe(true);
    // another Shot can never edit this Shot's still (createCandidateSet refuses it with this set)
    const other = d1.shots.find((s) => s.shotCode === "1B")!;
    expect(shotEditableAssetIds(d1, other.id).has(sourceId)).toBe(false);
    const sourceBefore = structuredClone(d1.assets.find((a) => a.id === sourceId));

    await submitCandidateSet({
      ...base,
      data: d1,
      selections: [
        {
          provider: "mock",
          modelId: "mock-image-1",
          edit: { sourceAssetId: sourceId, instruction: "add falling snow" },
        },
      ],
      now: new Date(t),
    });
    await work();
    const d2 = await data();
    const edited = d2.attempts
      .filter((a) => a.shotId === shot.id)
      .sort((x, y) => y.attemptNumber - x.attemptNumber)[0]!;
    expect(edited.id).not.toBe(still.id);
    expect(edited.status).toBe("succeeded");
    expect(edited.modelSettings).toMatchObject({ purpose: "production_frame", editSourceAssetId: sourceId });
    expect(edited.requestModality).toBe("image_to_image");
    expect((edited.request as { references: Array<{ assetId: string }> }).references[0]!.assetId).toBe(
      sourceId,
    );
    expect(JSON.stringify(edited.promptPlan)).toMatch(/Edit the first image: add falling snow/);
    expect(edited.inputAssetIds).toContain(sourceId);
    expect(edited.outputAssetId).not.toBe(sourceId);
    expect(d2.assets.find((a) => a.id === sourceId)).toEqual(sourceBefore);
    // still a Production Frame candidate (the existing promotion flows apply to it unchanged)
    expect(shotEditableAssetIds(d2, shot.id).has(edited.outputAssetId!)).toBe(true);
    // regression: the edit source is NOT a Production Frame reference, so the existing promotion guard does not read the
    // edit as "generated from a Production Frame that is no longer canonical"
    expect(
      (edited.request as { references: Array<{ assetId: string; role: string }> }).references[0]!.role,
    ).toBe("other");
    expect(candidateInputStaleness(buildShotContext(d2, shot.id), edited)).toBeNull();
  });

  it("transparency on a Shot still is refused for a model without it (the planner blocks the set)", async () => {
    const config = readGenerationConfig(env);
    const d0 = await data();
    const shot = d0.shots.find((s) => s.shotCode === "1A")!;
    await repo.upsert(d0.project.id, "shots", {
      ...shot,
      composition: { ...shot.composition, aspectRatio: "16:9" },
      updatedAt: new Date(t - 1000).toISOString(),
    });
    await expect(
      submitCandidateSet({
        data: await data(),
        shotId: shot.id,
        registry: createRegistry(env, config),
        config,
        generation: repo.generation,
        candidates: repo.candidates,
        selections: [{ provider: "mock", modelId: "mock-image-1", background: "transparent" }],
        acknowledgeAll: true,
        confirmedTotalUsd: null,
        title: "x",
        purpose: "",
        userId: null,
        projectRevision: null,
        generationPurpose: "production_frame",
        now: new Date(t),
      }),
    ).rejects.toThrow(/cannot make transparent backgrounds/);
  });
});
