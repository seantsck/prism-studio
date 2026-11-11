import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRepository } from "@/data/memory-repository";
import type { Asset } from "@/domain/schemas";
import { HOSTED_MATTING_ENGINE, prepareBackgroundRemoval } from "@/generation/background-removal";
import { readGenerationConfig } from "@/generation/config";
import { busyFixturePng, portraitFixturePng } from "@/generation/matting/fixture";
import { decodePng } from "@/generation/matting/png";
import { MockProvider } from "@/generation/providers/mock";
import { PhotoroomProvider } from "@/generation/providers/photoroom/adapter";
import { PHOTOROOM_SECRET_ENV } from "@/generation/providers/photoroom/config";
import { FakePhotoroomTransport } from "@/generation/providers/photoroom/fake-transport";
import { PhotoroomTransportError } from "@/generation/providers/photoroom/transport";
import { PrismMattingProvider } from "@/generation/providers/prism-matting/adapter";
import { ModelRegistry } from "@/generation/registry";
import { LocalDiskSink } from "@/generation/sink";
import { GenerationWorker } from "@/generation/worker";

/**
 * Phase 5B-I3b: local first, then an EXPLICIT High Quality Removal through Photoroom — on the FAKE transport only.
 * Nothing here reaches Photoroom; nothing is billed.
 */
vi.setConfig({ testTimeout: 60_000 });
const KEY = "sandbox_TESTKEYDONOTUSE_photoroom_1234567890";
const PAID = {
  NODE_ENV: "test",
  PRISM_STUDIO_MOCK_STAGE_DELAY_MS: "0",
  PRISM_STUDIO_ENABLE_MOCK_PROVIDER: "1",
  PRISM_STUDIO_GENERATION_PROVIDERS: "photoroom",
  PRISM_STUDIO_ALLOW_PAID_GENERATION: "true",
  PRISM_STUDIO_MAX_GENERATION_USD: "1",
};
const world = vi.hoisted(() => ({
  repo: null as unknown,
  registry: null as unknown,
  env: {} as Record<string, string>,
}));
let fake: FakePhotoroomTransport;

function registryFor(env: Record<string, string>) {
  return new ModelRegistry(
    [
      new MockProvider({ stageDelayMs: 0 }),
      new PrismMattingProvider(),
      new PhotoroomProvider({ env, transportFactory: () => fake }),
    ],
    readGenerationConfig(env),
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
      const data = await (world.repo as MemoryRepository).loadProject(slug);
      if (!data) throw new UserFacingError("That project no longer exists.");
      return data;
    },
  };
});
vi.mock("@/server/generation", async () => {
  const { readGenerationConfig: read } = await import("@/generation/config");
  return {
    getGenerationRepo: async () => (world.repo as MemoryRepository).generation,
    getGenerationConfig: () => read(world.env),
    getRegistry: () => world.registry,
  };
});

import { removeBackground } from "../subject-image-actions";
import { setCharacterCutout } from "../visual-bible-actions";

const sinkRoot = mkdtempSync(path.join(tmpdir(), "prism-i3b-"));
afterAll(() => rmSync(sinkRoot, { recursive: true, force: true }));
let repo: MemoryRepository;
let sink: LocalDiskSink;
let t = Date.now();

function useEnv(env: Record<string, string>) {
  world.env = env;
  world.registry = registryFor(env);
}
beforeEach(() => {
  repo = new MemoryRepository();
  world.repo = repo;
  fake = new FakePhotoroomTransport();
  sink = new LocalDiskSink(sinkRoot);
  // the web: worker-backed Photoroom, NO key
  useEnv({ ...PAID, PRISM_STUDIO_WORKER_BACKED_PROVIDERS: "photoroom" });
});

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries({ projectSlug: "ojousama", subjectKind: "character", ...fields }))
    f.set(k, v);
  return f;
};
const data = async () => (await repo.loadProject("ojousama"))!;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** The worker: its own registry, which holds the key (unless a test removes it). */
async function work(opts: { withKey?: boolean; ticks?: number } = {}) {
  const env = { ...PAID, ...(opts.withKey === false ? {} : { [PHOTOROOM_SECRET_ENV]: KEY }) };
  const worker = new GenerationWorker({
    store: repo.generation,
    registry: registryFor(env),
    sink,
    config: readGenerationConfig(env),
    logger: { info() {}, warn() {}, error() {} },
    clock: () => new Date(t),
  });
  for (let i = 0; i < (opts.ticks ?? 6); i++) {
    await worker.tick(5);
    t += 2000;
  }
}

async function stored(characterId: string, bytes: Uint8Array, label: string): Promise<Asset> {
  const d = await data();
  const id = randomUUID();
  const objectPath = `${d.project.id}/fixtures/${id}.png`;
  await sink.put(objectPath, bytes);
  const img = decodePng(bytes);
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
const yumeko = async () => (await data()).characters.find((c) => c.name === "Yumeko")!;

async function busyRefusedLocally() {
  const y = await yumeko();
  const busy = await stored(y.id, busyFixturePng(), "busy portrait");
  expect(await removeBackground(form({ subjectId: y.id, sourceAssetId: busy.id }))).toMatchObject({
    ok: true,
  });
  await work();
  const [local] = await cutouts(y.id);
  return { y, busy, local: local! };
}

describe("5B-I3b local first, hosted only on request", () => {
  it("1–2: an easy (plain-background) image stays local and makes NO external request", async () => {
    const y = await yumeko();
    const src = await stored(y.id, portraitFixturePng(), "portrait");
    expect(await removeBackground(form({ subjectId: y.id, sourceAssetId: src.id }))).toMatchObject({
      ok: true,
    });
    await work();
    const [v] = await cutouts(y.id);
    expect(v!.attempt).toMatchObject({ status: "succeeded", provider: "prism-matting" });
    expect(fake.calls).toHaveLength(0);
  });

  it("3–4: a busy image is refused locally and Photoroom is NOT called automatically", async () => {
    const { local } = await busyRefusedLocally();
    expect(local.attempt).toMatchObject({ status: "failed", provider: "prism-matting" });
    expect(local.job?.lastErrorCode).toBe("matting_background_not_plain");
    expect(fake.calls).toHaveLength(0);
    expect(await cutouts(local.attempt.characterId!)).toHaveLength(1);
  });

  it("5 + 10–12: the explicit High Quality Removal queues Photoroom; the result is a PNG with alpha; source untouched; lineage kept", async () => {
    const { y, busy } = await busyRefusedLocally();
    const hq = { subjectId: y.id, sourceAssetId: busy.id, quality: "high", confirmedTotalUsd: "0.02" };
    expect(await removeBackground(form(hq))).toMatchObject({ ok: true });
    const queued = (await cutouts(y.id))[0]!;
    expect(queued.attempt).toMatchObject({
      provider: "photoroom",
      model: "photoroom-remove-background",
      status: "queued",
    });
    await work();
    expect(fake.calls).toHaveLength(1);
    const v = (await cutouts(y.id))[0]!;
    expect(v.attempt.status).toBe("succeeded");
    const out = v.outputs[0]!.asset;
    const bytes = (await sink.get(out.objectPath!))!;
    expect(out).toMatchObject({
      mime: "image/png",
      width: busy.width,
      height: busy.height,
      checksum: sha(bytes),
    });
    expect(bytes[25]).toBe(6);
    expect(out.metadata).toMatchObject({
      hasAlpha: true,
      generation: { provider: "photoroom", attemptId: v.attempt.id },
    });
    // source untouched
    expect((await data()).assets.find((a) => a.id === busy.id)).toEqual(busy);
    expect(sha((await sink.get(busy.objectPath!))!)).toBe(busy.checksum);
    // lineage + provenance: matting, the provider's process — not Prism's local guarantee
    expect(v.attempt.modelSettings).toMatchObject({
      purpose: "background_removal",
      backgroundRemovalSourceAssetId: busy.id,
    });
    expect(v.attempt.inputAssetIds).toEqual([busy.id]);
    // cost: estimated and actual at the configured price
    expect(v.costs.find((c) => c.kind === "estimated")?.amount).toBe(0.02);
    expect(v.costs.find((c) => c.kind === "actual")?.amount).toBe(0.02);
  });

  it("records foregroundPreservation = provider-process, and RGB identity only as verified from the bytes", async () => {
    const env = { ...PAID, [PHOTOROOM_SECRET_ENV]: KEY };
    const p = new PhotoroomProvider({ env, transportFactory: () => fake });
    const src = portraitFixturePng(64, 80);
    const request = {
      schemaVersion: 1,
      modality: "image_to_image",
      purpose: "background_removal",
      provider: "photoroom",
      modelId: "photoroom-remove-background",
      prompt: { positive: "x", negative: "" },
      durationMs: null,
      resolution: null,
      aspectRatio: null,
      fps: null,
      seed: null,
      references: [{ assetId: "a1", role: "identity", order: 0, label: "s" }],
      startFrameAssetId: null,
      endFrameAssetId: null,
      audioAssetIds: [],
      providerOptions: {},
      idempotencyKey: "k",
    } as Parameters<PhotoroomProvider["submit"]>[0];
    const ctx = {
      now: () => new Date(),
      assets: { read: async () => ({ bytes: src, mime: "image/png", filename: "s.png" }) },
    };
    const sub = await p.submit(request, { version: 1, sections: [] }, ctx);
    const r = await p.fetchResult(
      { providerJobId: sub.providerJobId, model: "m", pollCount: 0, submittedAt: null, idempotencyKey: "k" },
      request,
    );
    expect(r.provenance.settings).toMatchObject({
      classification: "matting",
      output: { foregroundPreservation: "provider-process", rgbUnchangedVerified: true },
    });
    expect(JSON.stringify(r.provenance)).not.toMatch(/rgbUnchanged":true/);
  });

  it("6: a cross-character or out-of-project source is refused for High Quality Removal too", async () => {
    const d = await data();
    const [a, b] = d.characters;
    const other = await stored(b!.id, busyFixturePng(), "other");
    expect(
      await removeBackground(
        form({ subjectId: a!.id, sourceAssetId: other.id, quality: "high", confirmedTotalUsd: "0.02" }),
      ),
    ).toMatchObject({ ok: false, error: "That image does not belong to this character." });
    const foreign = { ...other, id: randomUUID(), projectId: randomUUID() } as Asset;
    expect(
      prepareBackgroundRemoval({
        data: { ...d, assets: [...d.assets, foreign] },
        characterId: a!.id,
        sourceAssetId: foreign.id,
        registry: world.registry as ModelRegistry,
        userId: null,
        idempotencyKey: "k-foreign",
        config: readGenerationConfig(world.env),
        engine: HOSTED_MATTING_ENGINE,
      }),
    ).toEqual({ ok: false, reasons: ["That image no longer exists in this project."] });
    expect(fake.calls).toHaveLength(0);
  });

  it("7–8: the web queues WITHOUT the key; the worker without the key fails closed and calls nothing", async () => {
    const r = world.registry as ModelRegistry;
    const m = r.model("photoroom", "photoroom-remove-background")!;
    expect(r.availabilityOf(m)).toMatchObject({ available: true, missingConfig: [] });
    const worker = registryFor(PAID);
    expect(worker.availabilityOf(worker.model("photoroom", "photoroom-remove-background")!)).toMatchObject({
      available: false,
      missingConfig: ["PRISM_STUDIO_PROVIDER_PHOTOROOM_API_KEY"],
    });
    const { y, busy } = await busyRefusedLocally();
    await removeBackground(
      form({ subjectId: y.id, sourceAssetId: busy.id, quality: "high", confirmedTotalUsd: "0.02" }),
    );
    await work({ withKey: false });
    const v = (await cutouts(y.id))[0]!;
    expect(v.attempt.provider).toBe("photoroom");
    expect(v.attempt.status).toBe("failed");
    expect(fake.calls).toHaveLength(0);
  });

  it("7: the key is never in browser code, NEXT_PUBLIC names, persisted attempts or job errors", async () => {
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const f of readdirSync(dir)) {
        const p = path.join(dir, f);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (/\.(ts|tsx)$/.test(f) && !p.includes("__tests__")) out.push(p);
      }
      return out;
    };
    const browser = [...walk("src/app"), ...walk("src/components")].filter((p) =>
      /PHOTOROOM_API_KEY|PHOTOROOM_SECRET_ENV|http-transport|x-api-key/.test(readFileSync(p, "utf8")),
    );
    expect(browser).toEqual([]);
    for (const p of walk("src"))
      expect(/NEXT_PUBLIC_[A-Z_]*PHOTOROOM/.test(readFileSync(p, "utf8")), p).toBe(false);
    const { y, busy } = await busyRefusedLocally();
    await removeBackground(
      form({ subjectId: y.id, sourceAssetId: busy.id, quality: "high", confirmedTotalUsd: "0.02" }),
    );
    fake.failures.push(new PhotoroomTransportError(401, "http_401", "Unauthorized", false));
    await work();
    const views = await cutouts(y.id);
    expect(JSON.stringify({ views, data: await data() })).not.toContain(KEY);
  });

  it("9: the spend gate and the explicit price confirmation are enforced", async () => {
    const { y, busy } = await busyRefusedLocally();
    const base = { subjectId: y.id, sourceAssetId: busy.id, quality: "high" };
    // no confirmation / a wrong price → refused, nothing queued
    expect(await removeBackground(form(base))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/Confirm the price/),
    });
    expect(await removeBackground(form({ ...base, confirmedTotalUsd: "0.01" }))).toMatchObject({ ok: false });
    // paid generation off → refused
    useEnv({
      ...PAID,
      PRISM_STUDIO_ALLOW_PAID_GENERATION: "false",
      PRISM_STUDIO_WORKER_BACKED_PROVIDERS: "photoroom",
    });
    expect(await removeBackground(form({ ...base, confirmedTotalUsd: "0.02" }))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/Paid generation is switched off/),
    });
    // a cap below the price → refused
    useEnv({
      ...PAID,
      PRISM_STUDIO_MAX_GENERATION_USD: "0.01",
      PRISM_STUDIO_WORKER_BACKED_PROVIDERS: "photoroom",
    });
    expect(await removeBackground(form({ ...base, confirmedTotalUsd: "0.02" }))).toMatchObject({ ok: false });
    // the configured price is the single source: a different contract price changes only configuration
    useEnv({
      ...PAID,
      PRISM_STUDIO_PHOTOROOM_USD_PER_IMAGE: "0.03",
      PRISM_STUDIO_WORKER_BACKED_PROVIDERS: "photoroom",
    });
    expect(await removeBackground(form({ ...base, confirmedTotalUsd: "0.02" }))).toMatchObject({ ok: false });
    expect(await removeBackground(form({ ...base, confirmedTotalUsd: "0.03" }))).toMatchObject({ ok: true });
    expect((await cutouts(y.id)).filter((v) => v.attempt.provider === "photoroom")).toHaveLength(1);
    expect(fake.calls).toHaveLength(0);
  });

  it("13: a provider error fails the attempt, stores nothing and leaves the source untouched", async () => {
    const { y, busy } = await busyRefusedLocally();
    const before = (await data()).assets.length;
    fake.failures.push(new PhotoroomTransportError(400, "http_400", "Bad image", false));
    await removeBackground(
      form({ subjectId: y.id, sourceAssetId: busy.id, quality: "high", confirmedTotalUsd: "0.02" }),
    );
    await work();
    const v = (await cutouts(y.id))[0]!;
    expect(v.attempt.status).toBe("failed");
    expect(v.outputs).toEqual([]);
    expect((await data()).assets).toHaveLength(before);
    expect((await data()).assets.find((a) => a.id === busy.id)).toEqual(busy);
    expect(sha((await sink.get(busy.objectPath!))!)).toBe(busy.checksum);
  });

  it("14 + retry safety: a replayed request and extra ticks never duplicate the paid call; an ambiguous call is never re-sent", async () => {
    const { y, busy } = await busyRefusedLocally();
    const hq = form({
      subjectId: y.id,
      sourceAssetId: busy.id,
      quality: "high",
      confirmedTotalUsd: "0.02",
      idempotencyKey: "hq-replay-key-1",
    });
    expect(await removeBackground(hq)).toMatchObject({ ok: true });
    expect(await removeBackground(hq)).toMatchObject({ ok: true });
    await work({ ticks: 10 });
    expect(fake.calls).toHaveLength(1);
    expect((await cutouts(y.id)).filter((v) => v.attempt.provider === "photoroom")).toHaveLength(1);

    // ambiguous (timeout): exactly one call, then the attempt stops with a clear reason for the operator
    fake.failures.push(new PhotoroomTransportError(null, "timeout", "timeout", true));
    const hq2 = form({
      subjectId: y.id,
      sourceAssetId: busy.id,
      quality: "high",
      confirmedTotalUsd: "0.02",
      idempotencyKey: "hq-ambiguous-key-1",
    });
    await removeBackground(hq2);
    await work({ ticks: 8 });
    expect(fake.calls).toHaveLength(2);
    const amb = (await cutouts(y.id)).find((v) => v.job?.idempotencyKey === "hq-ambiguous-key-1")!;
    expect(amb.attempt.status).toBe("failed");
    expect(amb.job?.lastErrorCode).toBe("submission_outcome_unknown");
  });

  it("I4 integration: a local or a Photoroom cutout may be designated as the Character cutout (replacement confirmed)", async () => {
    const { y, busy } = await busyRefusedLocally();
    // local cutout of an easy image
    const plain = await stored(y.id, portraitFixturePng(), "portrait");
    await removeBackground(form({ subjectId: y.id, sourceAssetId: plain.id }));
    // explicit High Quality Removal of the busy one
    await removeBackground(
      form({ subjectId: y.id, sourceAssetId: busy.id, quality: "high", confirmedTotalUsd: "0.02" }),
    );
    await work();
    expect(fake.calls).toHaveLength(1);
    const done = (await cutouts(y.id)).filter((v) => v.attempt.status === "succeeded");
    const local = done.find((v) => v.attempt.provider === "prism-matting")!;
    const hosted = done.find((v) => v.attempt.provider === "photoroom")!;
    const designation = async () =>
      (await data()).identityRefs.filter(
        (r) => r.characterId === y.id && (r.metadata as { visualRole?: string }).visualRole === "cutout",
      );
    const vb = (attemptId: string, extra: Record<string, string> = {}) => {
      const f = new FormData();
      for (const [k, v] of Object.entries({
        projectSlug: "ojousama",
        characterId: y.id,
        attemptId,
        ...extra,
      }))
        f.set(k, v);
      return f;
    };
    expect(await setCharacterCutout(vb(local.attempt.id))).toMatchObject({ ok: true });
    expect((await designation()).map((r) => r.assetId)).toEqual([local.outputs[0]!.asset.id]);
    // the hosted cutout replaces it only with confirmation; designation never calls a provider
    expect(await setCharacterCutout(vb(hosted.attempt.id))).toMatchObject({ ok: false });
    expect(await setCharacterCutout(vb(hosted.attempt.id, { confirmReplace: "1" }))).toMatchObject({
      ok: true,
    });
    expect((await designation()).map((r) => r.assetId)).toEqual([hosted.outputs[0]!.asset.id]);
    expect(fake.calls).toHaveLength(1);
    // the opaque source is still refused as a cutout (transparency is read from the bytes, not the form)
    const f = new FormData();
    for (const [k, v] of Object.entries({ projectSlug: "ojousama", characterId: y.id, assetId: busy.id }))
      f.set(k, v);
    f.set("confirmReplace", "1");
    expect(await setCharacterCutout(f)).toMatchObject({
      ok: false,
      error: "A cutout must be a transparent PNG. Remove the background first.",
    });
  });
});
