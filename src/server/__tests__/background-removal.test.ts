import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRepository } from "@/data/memory-repository";
import type { Asset } from "@/domain/schemas";
import { prepareBackgroundRemoval } from "@/generation/background-removal";
import { readGenerationConfig } from "@/generation/config";
import { decodePng } from "@/generation/matting/png";
import { busyFixturePng, portraitFixture, portraitFixturePng } from "@/generation/matting/fixture";
import { MockProvider } from "@/generation/providers/mock";
import { OpenAIImageProvider } from "@/generation/providers/openai-image/adapter";
import { FakeOpenAIImageTransport } from "@/generation/providers/openai-image/fake-transport";
import { PrismMattingProvider } from "@/generation/providers/prism-matting/adapter";
import { ModelRegistry } from "@/generation/registry";
import { LocalDiskSink } from "@/generation/sink";
import { GenerationWorker } from "@/generation/worker";

/**
 * Phase 5B-I3 acceptance: Remove Background on a Character image through the REAL server action, queue, worker, sink
 * and delete path. The registry also holds the OpenAI image provider on a FAKE transport, to prove it is never called.
 */
vi.setConfig({ testTimeout: 60_000 });
const env = {
  NODE_ENV: "test",
  PRISM_STUDIO_MOCK_STAGE_DELAY_MS: "0",
  PRISM_STUDIO_ENABLE_MOCK_PROVIDER: "1",
  PRISM_STUDIO_PROVIDER_OPENAI_IMAGE_API_KEY: "sk-proj-TESTKEYDONOTUSE1234567890abcdefABCDEF",
  PRISM_STUDIO_GENERATION_PROVIDERS: "openai-image",
};
const world = vi.hoisted(() => ({
  repo: null as unknown,
  registry: null as unknown,
  sinkRoot: "",
}));
const fakeOpenAI = new FakeOpenAIImageTransport();
function registry() {
  const config = readGenerationConfig(env);
  return new ModelRegistry(
    [
      new MockProvider({ stageDelayMs: 0 }),
      new OpenAIImageProvider({ env, transportFactory: () => fakeOpenAI }),
      new PrismMattingProvider(),
    ],
    config,
    env,
  );
}

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
  const e = {
    NODE_ENV: "test",
    PRISM_STUDIO_MOCK_STAGE_DELAY_MS: "0",
    PRISM_STUDIO_ENABLE_MOCK_PROVIDER: "1",
    PRISM_STUDIO_GENERATION_PROVIDERS: "openai-image",
  };
  return {
    getGenerationRepo: async () => (world.repo as MemoryRepository).generation,
    getGenerationConfig: () => read(e),
    getRegistry: () => world.registry,
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

let repo: MemoryRepository;
let sink: LocalDiskSink;
let t = Date.now();
world.sinkRoot = mkdtempSync(path.join(tmpdir(), "prism-i3-"));
afterAll(() => rmSync(world.sinkRoot, { recursive: true, force: true }));
beforeEach(() => {
  repo = new MemoryRepository();
  world.repo = repo;
  world.registry = registry();
  sink = new LocalDiskSink(world.sinkRoot);
  fakeOpenAI.calls.length = 0;
});

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries({ projectSlug: "ojousama", ...fields })) f.set(k, v);
  return f;
};
const data = async () => (await repo.loadProject("ojousama"))!;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

async function work(ticks = 6) {
  const config = readGenerationConfig(env);
  const worker = new GenerationWorker({
    store: repo.generation,
    registry: world.registry as ModelRegistry,
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

/** Stores PNG bytes as a real project Asset and attaches it to the Character as an additional reference. */
async function storedReference(characterId: string, bytes: Uint8Array, label: string): Promise<Asset> {
  const d = await data();
  const template = d.assets[0]!;
  const id = randomUUID();
  const objectPath = `${d.project.id}/fixtures/${id}.png`;
  await sink.put(objectPath, bytes);
  const img = decodePng(bytes);
  const asset: Asset = {
    ...template,
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
    width: img.width,
    height: img.height,
    durationMs: null,
    metadata: {},
  } as Asset;
  await repo.upsert(d.project.id, "assets", asset);
  await repo.upsert(d.project.id, "identityRefs", {
    id: randomUUID(),
    characterId,
    slot: "additional",
    assetId: id,
    label,
    metadata: {},
    locked: false,
  });
  return asset;
}

const cutouts = async (characterId: string) =>
  (await repo.generation.listSubjectImageAttempts({ kind: "character", characterId })).filter(
    (v) => (v.attempt.modelSettings as { purpose?: string }).purpose === "background_removal",
  );

async function yumekoCutout() {
  const yumeko = (await data()).characters.find((c) => c.name === "Yumeko")!;
  const sourceBytes = portraitFixturePng();
  const source = await storedReference(yumeko.id, sourceBytes, "Yumeko portrait");
  const r = await removeBackground(
    form({ subjectKind: "character", subjectId: yumeko.id, sourceAssetId: source.id }),
  );
  expect(r).toMatchObject({ ok: true });
  await work();
  const [v] = await cutouts(yumeko.id);
  return { yumeko, source, sourceBytes, view: v! };
}

describe("5B-I3 Remove Background — Yumeko portrait acceptance", () => {
  it("1–9: an owned image becomes a NEW transparent PNG Asset; the source is unchanged; lineage is recorded", async () => {
    const { source, sourceBytes, view } = await yumekoCutout();
    expect(view.attempt.status).toBe("succeeded");
    expect(view.attempt.provider).toBe("prism-matting");
    const out = view.outputs[0]!.asset;
    // 3 new asset
    expect(out.id).not.toBe(source.id);
    // 4 source unchanged (row and stored bytes)
    expect((await data()).assets.find((a) => a.id === source.id)).toEqual(source);
    expect(sha((await sink.get(source.objectPath!))!)).toBe(source.checksum);
    // 5–8 alpha, MIME, checksum, dimensions
    const bytes = (await sink.get(out.objectPath!))!;
    expect(out.mime).toBe("image/png");
    expect(out.checksum).toBe(sha(bytes));
    expect([out.width, out.height]).toEqual([source.width, source.height]);
    expect(bytes[25]).toBe(6); // IHDR colour type 6 = RGBA
    expect(out.metadata).toMatchObject({ hasAlpha: true });
    const cut = decodePng(bytes);
    const src = decodePng(sourceBytes);
    let transparent = 0;
    let soft = 0;
    let rgbChanged = 0;
    for (let i = 0; i < cut.width * cut.height; i++) {
      const a = cut.data[i * 4 + 3]!;
      if (a === 0) transparent++;
      else if (a < 255) soft++;
      for (let c = 0; c < 3; c++) if (cut.data[i * 4 + c] !== src.data[i * 4 + c]) rgbChanged++;
    }
    expect(transparent).toBeGreaterThan(0);
    expect(soft).toBeGreaterThan(0); // soft edges (antialiased hair strands), not a binary mask
    expect(rgbChanged).toBe(0); // NOT a redraw: every source pixel colour is kept
    // the enclosed near-background collar stays opaque (the fill only reaches pixels connected to the border)
    const fx = portraitFixture();
    const collar = (Math.round(fx.height * 0.62) * fx.width + fx.width / 2) * 4 + 3;
    expect(cut.data[collar]).toBe(255);
    // 9 lineage: source → operation → cutout
    expect(view.attempt.modelSettings).toMatchObject({
      purpose: "background_removal",
      backgroundRemovalSourceAssetId: source.id,
    });
    expect(view.attempt.inputAssetIds).toEqual([source.id]);
    expect(out.metadata).toMatchObject({
      generation: { attemptId: view.attempt.id, provider: "prism-matting" },
    });
    expect(view.costs.find((c) => c.kind === "actual")?.amount).toBe(0);
  });

  it("2: an image that is not this character's, or not in this project, is refused", async () => {
    const d = await data();
    const [a, b] = d.characters;
    const other = await storedReference(b!.id, portraitFixturePng(64, 80), "other");
    expect(
      await removeBackground(form({ subjectKind: "character", subjectId: a!.id, sourceAssetId: other.id })),
    ).toMatchObject({
      ok: false,
      error: "That image does not belong to this character.",
    });
    expect(
      await removeBackground(
        form({ subjectKind: "character", subjectId: a!.id, sourceAssetId: randomUUID() }),
      ),
    ).toMatchObject({ ok: false });
    // a project-scoped guard at the domain level too: another project's asset never qualifies
    const foreign = { ...other, id: randomUUID(), projectId: randomUUID() } as Asset;
    const p = prepareBackgroundRemoval({
      data: { ...d, assets: [...d.assets, foreign] },
      characterId: a!.id,
      sourceAssetId: foreign.id,
      registry: world.registry as ModelRegistry,
      userId: null,
      idempotencyKey: "k-foreign",
      config: readGenerationConfig(env),
    });
    expect(p).toEqual({ ok: false, reasons: ["That image no longer exists in this project."] });
    expect(await cutouts(a!.id)).toEqual([]);
  });

  it("10–11 + generation input: the cutout promotes to Character Reference and Look, and feeds a later generation", async () => {
    const { yumeko, view } = await yumekoCutout();
    const out = view.outputs[0]!.asset;
    expect(
      await saveAsCharacterReference(
        form({ characterId: yumeko.id, attemptId: view.attempt.id, slot: "additional", label: "Cutout" }),
      ),
    ).toMatchObject({ ok: true });
    const d1 = await data();
    const look = d1.looks.find((l) => l.characterId === yumeko.id)!;
    if (look.locked) await repo.upsert(d1.project.id, "looks", { ...look, locked: false });
    expect(await saveAsLookReference(form({ lookId: look.id, attemptId: view.attempt.id }))).toMatchObject({
      ok: true,
    });
    const d2 = await data();
    expect(d2.identityRefs.some((r) => r.characterId === yumeko.id && r.assetId === out.id)).toBe(true);
    expect(d2.looks.find((l) => l.id === look.id)!.referenceAssetIds).toContain(out.id);
    // nothing canonical was replaced automatically: the existing front reference (if any) is untouched
    expect(d2.identityRefs.filter((r) => r.slot === "front")).toEqual(
      d1.identityRefs.filter((r) => r.slot === "front"),
    );
    // a later image generation sends the cutout as a reference
    expect(
      await startSubjectImage(
        form({
          subjectKind: "character",
          subjectId: yumeko.id,
          intent: "portrait",
          model: "mock/mock-image-1",
          aspectRatio: "1:1",
        }),
      ),
    ).toMatchObject({ ok: true });
    const generated = (
      await repo.generation.listSubjectImageAttempts({ kind: "character", characterId: yumeko.id })
    )[0]!;
    expect(generated.attempt.inputAssetIds).toContain(out.id);
  });

  it("12–13: a referenced cutout cannot be deleted; once unreferenced it can, and its operation stays as history", async () => {
    const { yumeko, view } = await yumekoCutout();
    const out = view.outputs[0]!.asset;
    await saveAsCharacterReference(
      form({ characterId: yumeko.id, attemptId: view.attempt.id, slot: "additional", label: "Cutout" }),
    );
    expect(await deleteAsset(form({ assetId: out.id }))).toMatchObject({
      ok: false,
      error: expect.stringContaining("in use"),
    });
    const d = await data();
    await repo.remove(d.project.id, "identityRefs", d.identityRefs.find((r) => r.assetId === out.id)!.id);
    expect(await deleteAsset(form({ assetId: out.id }))).toMatchObject({ ok: true });
    const kept = (await repo.generation.getSubjectImageAttempt(view.attempt.id))!;
    expect(kept.attempt).toMatchObject({ status: "succeeded", outputAssetId: null });
    expect(kept.attempt.modelSettings).toMatchObject({ purpose: "background_removal" });
  });

  it("14: a failed removal (busy background) destroys nothing and makes no Asset", async () => {
    const yumeko = (await data()).characters.find((c) => c.name === "Yumeko")!;
    const busy = await storedReference(yumeko.id, busyFixturePng(), "busy");
    const before = (await data()).assets.length;
    expect(
      await removeBackground(
        form({ subjectKind: "character", subjectId: yumeko.id, sourceAssetId: busy.id }),
      ),
    ).toMatchObject({ ok: true });
    await work();
    const [v] = await cutouts(yumeko.id);
    expect(v!.attempt.status).toBe("failed");
    expect(v!.job?.lastErrorCode).toBe("matting_background_not_plain");
    expect(v!.outputs).toEqual([]);
    expect((await data()).assets).toHaveLength(before);
    expect((await data()).assets.find((a) => a.id === busy.id)).toEqual(busy);
    expect(sha((await sink.get(busy.objectPath!))!)).toBe(busy.checksum);
  });

  it("15: a replayed request and extra worker ticks never duplicate the completed output; a lost result is recomputed identically", async () => {
    const yumeko = (await data()).characters.find((c) => c.name === "Yumeko")!;
    const source = await storedReference(yumeko.id, portraitFixturePng(), "Yumeko portrait");
    const f = form({
      subjectKind: "character",
      subjectId: yumeko.id,
      sourceAssetId: source.id,
      idempotencyKey: "cutout-replay-key-1",
    });
    expect(await removeBackground(f)).toMatchObject({ ok: true });
    expect(await removeBackground(f)).toMatchObject({ ok: true });
    await work(10);
    const views = await cutouts(yumeko.id);
    expect(views).toHaveLength(1);
    expect(views[0]!.outputs).toHaveLength(1);
    // deterministic: a fresh adapter (a restarted worker) recomputes byte-identical output from the same source
    const ingested = (await sink.get(views[0]!.outputs[0]!.asset.objectPath!))!;
    const request = views[0]!.attempt.request as unknown as Parameters<
      PrismMattingProvider["fetchResult"]
    >[1];
    const again = await new PrismMattingProvider().fetchResult(
      {
        providerJobId: "matting-lost",
        model: request.modelId,
        pollCount: 0,
        submittedAt: null,
        idempotencyKey: "k",
      },
      request,
      {
        now: () => new Date(),
        assets: {
          read: async (id: string) =>
            id === source.id
              ? { bytes: (await sink.get(source.objectPath!))!, mime: "image/png", filename: "s.png" }
              : null,
        },
      },
    );
    expect(sha(Buffer.from((again.outputs[0]!.source as { base64: string }).base64, "base64"))).toBe(
      sha(ingested),
    );
  });

  it("16: background removal is free and local — no paid provider is called, and the spend gate does not block it", async () => {
    const r = world.registry as ModelRegistry;
    const m = r.model("prism-matting", "plain-background-keyer-1")!;
    expect(r.billsMoney(m)).toBe(false);
    expect(r.spendPolicy().enabled).toBe(false); // paid generation is OFF in this test environment
    await yumekoCutout();
    expect(fakeOpenAI.calls).toHaveLength(0);
    // and a real provider without the local marker still bills (fail-safe)
    expect(r.billsMoney(r.model("openai-image", "gpt-image-2.5-flare")!)).toBe(true);
  });

  it("the matting engine is never offered as a generation / edit model", async () => {
    const { subjectImageState } = await import("../subject-images");
    const yumeko = (await data()).characters.find((c) => c.name === "Yumeko")!;
    const state = await subjectImageState({ kind: "character", characterId: yumeko.id }, await data());
    expect(state.models.some((m) => m.provider === "prism-matting")).toBe(false);
  });
});
