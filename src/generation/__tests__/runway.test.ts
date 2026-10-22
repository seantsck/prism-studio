import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildShotContext } from "@/domain/context";
import { approvalSnapshot } from "@/domain/fingerprint";
import { GenerationProviderError } from "@/domain/generation/errors";
import type { GenerationRequest, PromptPlan } from "@/domain/generation/schemas";
import { MOCK_VIDEO_WEBM_BASE64 } from "../providers/mock-video-fixture";
import {
  RunwayProvider,
  gen45Model,
  type RunwayClientLike,
  type RunwayTask,
} from "../providers/runway/adapter";
import { compileRunwayPrompt } from "../providers/runway/compile";
import { mapRunwayError } from "../providers/runway/errors";
import { RUNWAY_PRICING } from "../providers/runway/config";
import { ModelRegistry } from "../registry";
import { silentLogger } from "../log";
import { evaluateShotForModel } from "../submission";
import { GenerationWorker } from "../worker";
import { encodeMockPng } from "../providers/mock-image";
import type { ProviderContext } from "../provider";
import { makeHarness, type Harness } from "./helpers";

// ───────────────────────── a fake Runway at the SDK boundary ─────────────────────────

class FakeRunway {
  created: Array<{ kind: "t2v" | "i2v"; body: Record<string, unknown> }> = [];
  deleted: string[] = [];
  retrieves = 0;
  nextId = 1;
  /** Status script per task id; the last entry repeats. */
  script = new Map<string, RunwayTask[]>();
  /** Default script applied to newly created tasks. */
  defaultScript: (id: string, outputUrl: string) => RunwayTask[] = (id, url) => [
    { id, status: "PENDING" },
    { id, status: "THROTTLED" },
    { id, status: "RUNNING", progress: 0.4 },
    { id, status: "SUCCEEDED", output: [url], cost: { credits: 48 } },
  ];
  createError: unknown[] = [];
  retrieveError: unknown[] = [];
  outputUrl = "http://127.0.0.1:1/never";
  /** When set, retrieve() returns this regardless of script (cancel-race control). */
  force: ((id: string) => RunwayTask | null) | null = null;

  client(): RunwayClientLike {
    const create = (kind: "t2v" | "i2v") => async (body: Record<string, unknown>) => {
      const err = this.createError.shift();
      if (err) throw err;
      this.created.push({ kind, body });
      const id = `task_${this.nextId++}`;
      this.script.set(id, this.defaultScript(id, this.outputUrl));
      return { id, estimatedCost: { credits: 48 } };
    };
    return {
      textToVideo: { create: create("t2v") },
      imageToVideo: { create: create("i2v") },
      textToImage: {
        create: async () => {
          throw new Error("the video adapter suite never calls textToImage");
        },
      },
      tasks: {
        retrieve: async (id) => {
          this.retrieves += 1;
          const err = this.retrieveError.shift();
          if (err) throw err;
          const forced = this.force?.(id);
          if (forced) return forced;
          const steps = this.script.get(id);
          if (!steps) throw Object.assign(new Error("not found"), { status: 404 });
          const next = steps.length > 1 ? steps.shift()! : steps[0]!;
          return next;
        },
        delete: async (id) => {
          this.deleted.push(id);
          this.script.set(id, [{ id, status: "CANCELLED", cost: { credits: 0 } }]);
          return undefined;
        },
      },
    };
  }
}

const ENV = {
  NODE_ENV: "test",
  PRISM_STUDIO_GENERATION_PROVIDERS: "runway",
  RUNWAYML_API_SECRET: "key_test_0123456789abcdef0123456789",
  PRISM_STUDIO_ALLOW_PAID_GENERATION: "true",
  PRISM_STUDIO_MAX_GENERATION_USD: "5",
};

const plan = (extra: PromptPlan["sections"] = []): PromptPlan => ({
  version: 1,
  sections: [
    { key: "subject", title: "Subject", lines: ["1A — Doorway", "Yumeko hesitates at the door"] },
    {
      key: "action",
      title: "Action",
      lines: ["begins: hand on the handle", "0.5s: she exhales", "ends: door opens"],
    },
    { key: "camera", title: "Camera", lines: ["lens: 35mm", "movement: slow push-in"] },
    { key: "timing", title: "Timing", lines: ["duration 4s (manual)"] },
    { key: "performance", title: "Performance", lines: ['Yumeko: "I will not go."', "emotion: fear (7/10)"] },
    { key: "negative_constraints", title: "Negative constraints", lines: ["no text overlays"] },
    ...extra,
  ],
});

const request = (over: Partial<GenerationRequest> = {}): GenerationRequest => ({
  schemaVersion: 1,
  modality: "text_to_video",
  provider: "runway",
  modelId: "gen4.5",
  prompt: { positive: "x", negative: "" },
  durationMs: 4000,
  resolution: null,
  aspectRatio: "16:9",
  fps: null,
  seed: null,
  references: [],
  startFrameAssetId: null,
  endFrameAssetId: null,
  audioAssetIds: [],
  providerOptions: {},
  idempotencyKey: "runway-test-key-0001",
  ...over,
});

const ctx = (over: Partial<ProviderContext> = {}): ProviderContext => ({
  now: () => new Date("2026-10-13T00:00:00Z"),
  assets: { read: async () => null },
  ...over,
});

const make = (fake = new FakeRunway()) => ({
  fake,
  provider: new RunwayProvider({ env: ENV, clientFactory: () => fake.client() }),
});

// ───────────────────────── capabilities, compile, validate ─────────────────────────

describe("Runway Gen-4.5 capabilities and request compilation", () => {
  const { provider } = make();
  const model = gen45Model();

  it("declares verified capabilities, including NO create idempotency", () => {
    const c = model.capabilities;
    expect(model.provider).toBe("runway");
    expect(model.modelId).toBe("gen4.5");
    expect(c.modalities).toEqual(["text_to_video", "image_to_video"]);
    expect(c.video).toMatchObject({ minDurationMs: 2000, maxDurationMs: 10_000, durationStepMs: 1000 });
    expect(c.operational).toMatchObject({ cancellation: true, idempotency: false, webhook: false });
    expect(c.references).toMatchObject({
      startFrame: true,
      endFrame: false,
      referenceImages: false,
      maxReferences: 0,
    });
    expect(c.audio).toEqual({
      nativeDialogueAudio: false,
      audioConditioning: false,
      lipSync: false,
      referenceAudio: false,
      soundGeneration: false,
    });
    expect(c.commercial.unitCost).toBeCloseTo(0.12, 4); // 12 credits/s × $0.01
  });

  it("estimates cost from versioned pricing configuration", () => {
    const e = provider.estimateCost(request({ durationMs: 5000 }), model);
    expect(e).toMatchObject({ amount: 0.6, currency: "USD", units: 60 });
    expect(e.basis).toContain(RUNWAY_PRICING.version);
    expect(provider.estimateCost(request({ durationMs: 2000 }), model).amount).toBe(0.24);
    expect(provider.estimateCost(request({ durationMs: null }), model).amount).toBeNull();
  });

  it("compiles prose in priority order, within 1000 chars, without JSON or negative/timing/dialogue text", () => {
    const c = compileRunwayPrompt(plan());
    expect(c.text.length).toBeLessThanOrEqual(1000);
    expect(c.text.startsWith("Subject:")).toBe(true); // natural reading order
    expect(c.text).toContain("Action: begins: hand on the handle");
    expect(c.text).not.toContain("{");
    expect(c.text).not.toContain("I will not go");
    expect(c.text).not.toContain("no text overlays");
    expect(c.omissions).toEqual([]);
    expect(c.notes.join(" ")).toMatch(/dialogue/i);
  });

  it("reports (never silently drops) content that does not fit the prompt limit", () => {
    const long = Array.from({ length: 40 }, (_, i) => `Lighting detail number ${i} with some extra wording`);
    const heavy = plan([{ key: "lighting", title: "Lighting", lines: long }]);
    const c = compileRunwayPrompt(heavy);
    expect(c.text.length).toBeLessThanOrEqual(1000);
    expect(c.omissions.find((o) => o.section === "lighting")?.omittedLines).toBeGreaterThan(0);
    // the high-priority action survives the squeeze
    expect(c.text).toContain("Action:");
    const ignored = provider.additionalIgnoredFeatures(request(), heavy);
    expect(ignored.map((f) => f.id)).toEqual(["prompt.length"]);
    expect(ignored[0]!.impact).toMatch(/lighting/i);
    expect(provider.additionalIgnoredFeatures(request(), plan())).toEqual([]);
  });

  it("blocks 4.5 s (no silent rounding), unsupported ratios, missing first frame and unknown models", () => {
    const r45 = provider.validateRequest(request({ durationMs: 4500 }), model);
    expect(r45.ok).toBe(false);
    expect(r45.errors.join(" ")).toMatch(/will not round/);
    expect(provider.validateRequest(request({ durationMs: 5000 }), model).ok).toBe(true);
    expect(provider.validateRequest(request({ durationMs: 1000 }), model).ok).toBe(false);
    expect(provider.validateRequest(request({ durationMs: 11_000 }), model).ok).toBe(false);

    const t2v43 = provider.validateRequest(request({ aspectRatio: "4:3" }), model);
    expect(t2v43.errors.join(" ")).toMatch(/not available for text-to-video/);
    const i2v43 = provider.validateRequest(
      request({ modality: "image_to_video", aspectRatio: "4:3", startFrameAssetId: "a" }),
      model,
    );
    expect(i2v43.ok).toBe(true);

    const noFrame = provider.validateRequest(request({ modality: "image_to_video" }), model);
    expect(noFrame.errors.join(" ")).toMatch(/first frame/);

    const unknown = provider.validateRequest(request(), { ...model, modelId: "gen4_turbo" });
    expect(unknown.ok).toBe(false);
  });

  it("the inspectable summary carries no secrets, no image data and no signed URLs", () => {
    const s = provider.compileRequest(
      request({ modality: "image_to_video", startFrameAssetId: "11111111-1111-1111-1111-111111111111" }),
      plan(),
    );
    const text = JSON.stringify(s);
    expect(text).not.toContain(ENV.RUNWAYML_API_SECRET);
    expect(text).not.toContain("data:image");
    expect(text).not.toMatch(/https?:\/\//);
    expect(s.fields).toMatchObject({ model: "gen4.5", duration: 4, ratio: "1280:720", outputFormat: "mp4" });
    expect(s.attachments).toEqual([{ role: "first_frame", assetId: "11111111-1111-1111-1111-111111111111" }]);
  });

  it("is registered as an adapter but unavailable until enabled, configured AND paid generation is on", () => {
    const base = { NODE_ENV: "test" } as Record<string, string>;
    const reg = (env: Record<string, string>, paid: { enabled: boolean; maxUsd: number | null }) =>
      new ModelRegistry(
        [new RunwayProvider({ env })],
        {
          enabledProviders: (env.PRISM_STUDIO_GENERATION_PROVIDERS ?? "").split(",").filter(Boolean),
          paid,
        } as never,
        env,
      );
    const m = model;
    expect(reg(base, { enabled: false, maxUsd: null }).availabilityOf(m)).toMatchObject({
      enabled: false,
      available: false,
      missingConfig: ["RUNWAYML_API_SECRET"],
    });
    const configured = { ...base, PRISM_STUDIO_GENERATION_PROVIDERS: "runway", RUNWAYML_API_SECRET: "k" };
    expect(reg(configured, { enabled: false, maxUsd: null }).availabilityOf(m)).toMatchObject({
      enabled: true,
      configured: true,
      paidGenerationEnabled: false,
      available: false,
    });
    const a = reg(configured, { enabled: true, maxUsd: 1 }).availabilityOf(m);
    expect(a).toMatchObject({ available: true, paidGenerationEnabled: true });
    // the browser-facing availability never contains the credential
    expect(JSON.stringify(a)).not.toContain('"k"');
  });
});

// ───────────────────────── adapter I/O against the fake ─────────────────────────

describe("Runway adapter I/O (fake SDK boundary, no network, no credits)", () => {
  it("submits text-to-video without waiting and returns the task id immediately", async () => {
    const { fake, provider } = make();
    const sub = await provider.submit(request({ durationMs: 5000, seed: 42 }), plan(), ctx());
    expect(sub).toMatchObject({ providerJobId: "task_1", state: "queued", providerStatus: "PENDING" });
    expect(fake.created).toHaveLength(1);
    expect(fake.created[0]!.kind).toBe("t2v");
    expect(fake.created[0]!.body).toMatchObject({
      model: "gen4.5",
      duration: 5,
      ratio: "1280:720",
      seed: 42,
    });
    expect(String(fake.created[0]!.body.promptText).length).toBeLessThanOrEqual(1000);
    expect(fake.retrieves).toBe(0);
  });

  it("image-to-video: embeds the first frame as a data URI, checksum-verified bytes only", async () => {
    const { fake, provider } = make();
    const png = encodeMockPng(32, 18, 3);
    const sub = await provider.submit(
      request({ modality: "image_to_video", startFrameAssetId: "asset-1" }),
      plan(),
      ctx({ assets: { read: async () => ({ bytes: png, mime: "image/png", filename: "f.png" }) } }),
    );
    expect(sub.providerJobId).toBe("task_1");
    const body = fake.created[0]!.body as { promptImage: Array<{ position: string; uri: string }> };
    expect(body.promptImage[0]!.position).toBe("first");
    expect(body.promptImage[0]!.uri.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("large first frames use a short-lived signed URL; with none available the request is refused", async () => {
    const big = new Uint8Array(4_000_000);
    const read = async () => ({ bytes: big, mime: "image/png", filename: "f.png" });
    const a = make();
    await a.provider.submit(
      request({ modality: "image_to_video", startFrameAssetId: "asset-1" }),
      plan(),
      ctx({ assets: { read, signedUrl: async () => "https://signed.example.com/f.png?token=x" } }),
    );
    const body = a.fake.created[0]!.body as { promptImage: Array<{ uri: string }> };
    expect(body.promptImage[0]!.uri).toMatch(/^https:\/\/signed\.example\.com\//);

    const b = make();
    await expect(
      b.provider.submit(
        request({ modality: "image_to_video", startFrameAssetId: "asset-1" }),
        plan(),
        ctx({ assets: { read } }),
      ),
    ).rejects.toMatchObject({ code: "runway_input_too_large", category: "invalid_request" });
    expect(b.fake.created).toHaveLength(0);
  });

  it("refuses unsupported first-frame types before calling Runway", async () => {
    const { fake, provider } = make();
    await expect(
      provider.submit(
        request({ modality: "image_to_video", startFrameAssetId: "a" }),
        plan(),
        ctx({
          assets: { read: async () => ({ bytes: new Uint8Array(10), mime: "image/gif", filename: "f.gif" }) },
        }),
      ),
    ).rejects.toMatchObject({ code: "runway_input_type" });
    expect(fake.created).toHaveLength(0);
  });

  it("maps every Runway task state; THROTTLED is queued, not failed", async () => {
    const { fake, provider } = make();
    fake.defaultScript = (id) => [
      { id, status: "PENDING" },
      { id, status: "THROTTLED" },
      { id, status: "RUNNING", progress: 0.5 },
      { id, status: "SUCCEEDED", output: ["https://x.example/o.mp4"], cost: { credits: 24 } },
    ];
    await provider.submit(request(), plan(), ctx());
    const poll = (n: number) =>
      provider.poll(
        { providerJobId: "task_1", model: "gen4.5", pollCount: n, submittedAt: null, idempotencyKey: "k" },
        ctx(),
      );
    expect(await poll(0)).toMatchObject({ state: "queued", providerStatus: "PENDING", failure: null });
    const throttled = await poll(1);
    expect(throttled).toMatchObject({ state: "queued", providerStatus: "THROTTLED" });
    expect(await poll(2)).toMatchObject({ state: "processing", progress: 0.5 });
    expect(await poll(3)).toMatchObject({ state: "succeeded", retryAfterMs: null });
    // non-aggressive cadence that backs off
    const early = await (async () => {
      fake.script.set("t", [{ id: "t", status: "PENDING" }]);
      return provider.poll(
        { providerJobId: "t", model: "gen4.5", pollCount: 0, submittedAt: null, idempotencyKey: "k" },
        ctx(),
      );
    })();
    const later = await (async () => {
      fake.script.set("t", [{ id: "t", status: "PENDING" }]);
      return provider.poll(
        { providerJobId: "t", model: "gen4.5", pollCount: 6, submittedAt: null, idempotencyKey: "k" },
        ctx(),
      );
    })();
    expect(early.retryAfterMs).toBeGreaterThanOrEqual(5000);
    expect(later.retryAfterMs!).toBeGreaterThan(early.retryAfterMs!);
  });

  it("maps task failures: safety → content_rejected; internal → provider_unavailable; others permanent", async () => {
    const { fake, provider } = make();
    const poll = async (code: string | undefined) => {
      fake.script.set("t", [
        { id: "t", status: "FAILED", failure: "secret detail", failureCode: code, cost: { credits: 0 } },
      ]);
      return provider.poll(
        { providerJobId: "t", model: "gen4.5", pollCount: 0, submittedAt: null, idempotencyKey: "k" },
        ctx(),
      );
    };
    const safety = await poll("SAFETY.INPUT.TEXT");
    expect(safety.state).toBe("failed");
    expect(safety.failure).toMatchObject({ category: "content_rejected", code: "SAFETY.INPUT.TEXT" });
    expect(safety.failure!.message).not.toContain("secret detail");
    expect((await poll("INTERNAL.BAD_OUTPUT.CODE01")).failure?.category).toBe("provider_unavailable");
    expect((await poll(undefined)).failure?.category).toBe("permanent");
  });

  it("maps HTTP/SDK errors into the taxonomy without leaking provider payloads", () => {
    const e = (status: number | undefined, extra: Record<string, unknown> = {}) =>
      mapRunwayError(Object.assign(new Error('{"error":"SECRET-PAYLOAD"}'), { status, ...extra }));
    expect(e(429, { headers: { "retry-after": "7" } })).toMatchObject({
      category: "rate_limit",
      options: { retryAfterMs: 7000 },
    });
    expect(e(429, { error: { message: "daily limit reached" } })).toMatchObject({
      category: "quota",
      retryable: false,
    });
    expect(e(500)).toMatchObject({ category: "provider_unavailable", retryable: true });
    expect(e(401)).toMatchObject({ category: "auth", retryable: false });
    expect(e(400, { error: { error: "content moderation: policy" } })).toMatchObject({
      category: "content_rejected",
    });
    expect(e(400, { error: { error: "insufficient credits" } })).toMatchObject({ category: "quota" });
    expect(e(400)).toMatchObject({ category: "invalid_request", retryable: false });
    expect(
      mapRunwayError(Object.assign(new Error("x"), { name: "APIConnectionTimeoutError" })),
    ).toMatchObject({
      category: "timeout",
    });
    expect(mapRunwayError(new Error("socket hang up"))).toMatchObject({ category: "transient" });
    for (const err of [e(500), e(400), e(429), e(undefined)]) {
      expect(err.message).not.toContain("SECRET-PAYLOAD");
      expect(err).toBeInstanceOf(GenerationProviderError);
    }
  });

  it("cancel: never deletes finished work; reports completion; confirms real cancellation", async () => {
    const ref = { providerJobId: "t", model: "gen4.5", pollCount: 0, submittedAt: null, idempotencyKey: "k" };
    // already succeeded → keep the output, do not delete
    const a = make();
    a.fake.script.set("t", [{ id: "t", status: "SUCCEEDED", output: ["u"], cost: { credits: 48 } }]);
    expect(await a.provider.cancel(ref, ctx())).toEqual({ confirmed: false, completed: true });
    expect(a.fake.deleted).toEqual([]);
    // running → delete → confirmed by a second look
    const b = make();
    b.fake.script.set("t", [{ id: "t", status: "RUNNING" }]);
    expect(await b.provider.cancel(ref, ctx())).toEqual({ confirmed: true });
    expect(b.fake.deleted).toEqual(["t"]);
    // race: finished between the look and the delete → preserved
    const c = make();
    let calls = 0;
    c.fake.force = () => {
      calls += 1;
      return calls === 1
        ? { id: "t", status: "RUNNING" }
        : { id: "t", status: "SUCCEEDED", output: ["u"], cost: { credits: 48 } };
    };
    expect(await c.provider.cancel(ref, ctx())).toEqual({ confirmed: false, completed: true });
  });

  it("the result keeps the output URL as transport only and reports provider cost, never inventing one", async () => {
    const { fake, provider } = make();
    fake.script.set("t", [
      {
        id: "t",
        status: "SUCCEEDED",
        output: ["https://x.cloudfront.net/o.mp4?Signature=abc"],
        cost: { credits: 48 },
      },
    ]);
    const ref = { providerJobId: "t", model: "gen4.5", pollCount: 0, submittedAt: null, idempotencyKey: "k" };
    const r = await provider.fetchResult(ref, request({ durationMs: 4000 }), ctx());
    expect(r.cost).toMatchObject({ amount: 0.48, currency: "USD", units: 48 });
    expect(r.outputs[0]!.source).toEqual({
      type: "url",
      url: "https://x.cloudfront.net/o.mp4?Signature=abc",
    });
    expect(JSON.stringify(r.provenance)).not.toContain("Signature");
    expect(JSON.stringify(r.provenance)).not.toContain("cloudfront");
    fake.script.set("u", [{ id: "u", status: "SUCCEEDED", output: ["https://x.cloudfront.net/o.mp4"] }]);
    const unknown = await provider.fetchResult({ ...ref, providerJobId: "u" }, request(), ctx());
    expect(unknown.cost.amount).toBeNull();
    expect(provider.allowedOutputHosts()).toContain("*.cloudfront.net");
  });
});

// ───────────────────────── through the real worker ─────────────────────────

describe("Runway through the generic worker (fake provider, loopback output server)", () => {
  let server: http.Server;
  let base = "";
  let forbidFirstDownload = false;
  const webm = Buffer.from(MOCK_VIDEO_WEBM_BASE64, "base64");

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/out.webm") {
        if (forbidFirstDownload) {
          forbidFirstDownload = false;
          res.writeHead(403);
          return res.end();
        }
        res.writeHead(200, { "content-type": "video/webm", "content-length": webm.length });
        return res.end(webm);
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const png = encodeMockPng(32, 18, 9);

  /** Harness with a fake-backed Runway adapter, readable first frames for the seed shots, and a 16:9 shot. */
  async function setup(opts: { env?: Record<string, string>; codes?: string[] } = {}) {
    const fake = new FakeRunway();
    fake.defaultScript = (id) => [
      { id, status: "PENDING" },
      { id, status: "THROTTLED" },
      { id, status: "RUNNING", progress: 0.5 },
      { id, status: "SUCCEEDED", output: [`${base}/out.webm`], cost: { credits: 48 } },
    ];
    // The fixture clip is WebM: present it as such (the real adapter asks for mp4).
    const real = new RunwayProvider({ env: { ...ENV, ...opts.env }, clientFactory: () => fake.client() });
    const adapter = Object.create(real) as RunwayProvider;
    adapter.fetchResult = async (ref, req, c) => {
      const r = await real.fetchResult(ref, req, c);
      return {
        ...r,
        outputs: r.outputs.map((o) => ({
          ...o,
          filename: o.filename.replace(/\.mp4$/, ".webm"),
          mime: "video/webm",
        })),
      };
    };
    const h = makeHarness(
      { ...ENV, ...opts.env, PRISM_STUDIO_MOCK_STAGE_DELAY_MS: "0" },
      { extraAdapters: [adapter] },
    );
    const data = await h.data();
    for (const code of opts.codes ?? ["1A"]) {
      const shot = data.shots.find((s) => s.shotCode === code)!;
      const startId = (await import("@/domain/context").then(
        (m) => m.buildShotContext(data, shot.id).approvedFrame?.assetId ?? null,
      )) as string | null;
      const asset = data.assets.find((a) => a.id === startId);
      if (asset) {
        const path = `runway-test/${asset.id}.png`;
        await h.sink.put(path, png);
        await h.repo.upsert(data.project.id, "assets", {
          ...asset,
          objectPath: path,
          mime: "image/png",
          byteSize: png.length,
          checksum: createHash("sha256").update(png).digest("hex"),
          storageProvider: "local",
          bucket: null,
        });
      }
      await h.repo.upsert(data.project.id, "shots", {
        ...shot,
        composition: { ...shot.composition, aspectRatio: "16:9" },
        updatedAt: new Date(h.clock.now.getTime() - 1000).toISOString(),
      });
      // The aspect ratio is part of the camera setup: re-approve the frame so it is not stale for this test.
      const after = await h.data();
      const shotCtx = buildShotContext(after, shot.id);
      if (shotCtx.approvedFrame) {
        const snap = approvalSnapshot(shotCtx);
        await h.repo.upsert(after.project.id, "frames", {
          ...shotCtx.approvedFrame,
          approvedFingerprint: snap.fingerprint,
          approvedSnapshot: snap.snapshot,
        });
      }
    }
    const worker = (config = h.config, registry: ModelRegistry = h.registry) =>
      new GenerationWorker({
        store: h.repo.generation,
        registry,
        sink: h.sink,
        config,
        logger: silentLogger,
        clock: () => h.clock.now,
        workerId: "runway-test",
        retryPolicy: { baseDelayMs: 100, maxDelayMs: 1000, jitter: 0 },
        random: () => 0,
        heartbeatMs: 0,
        unsafeAllowLoopbackHttp: true,
      });
    return { h, fake, worker };
  }

  const drive = async (h: Harness, worker: GenerationWorker, jobId: string, ticks = 30) => {
    for (let i = 0; i < ticks; i++) {
      const job = await h.repo.generation.getJob(jobId);
      if (job && ["succeeded", "failed", "cancelled"].includes(job.status)) return job;
      await worker.tick();
      h.clock.advance(6000);
    }
    return (await h.repo.generation.getJob(jobId))!;
  };

  it("the spend gate blocks before anything is queued while paid generation is off", async () => {
    const { h } = await setup({ env: { PRISM_STUDIO_ALLOW_PAID_GENERATION: "false" } });
    const data = await h.data();
    const shot = data.shots.find((s) => s.shotCode === "1A")!;
    const ev = evaluateShotForModel({
      data,
      shotId: shot.id,
      registry: h.registry,
      provider: "runway",
      modelId: "gen4.5",
    });
    expect(ev.gate.allowed).toBe(false);
    expect(ev.gate.blockers.map((b) => b.code)).toContain("spend.disabled");
    expect(ev.availability?.paidGenerationEnabled).toBe(false);
  });

  it("an estimate above the per-generation limit is blocked, not silently allowed", async () => {
    const { h } = await setup({ env: { PRISM_STUDIO_MAX_GENERATION_USD: "0.10" } });
    const data = await h.data();
    const shot = data.shots.find((s) => s.shotCode === "1A")!;
    const ev = evaluateShotForModel({
      data,
      shotId: shot.id,
      registry: h.registry,
      provider: "runway",
      modelId: "gen4.5",
    });
    expect(ev.estimate?.amount).toBeCloseTo(0.48, 4);
    expect(ev.gate.blockers.map((b) => b.code)).toContain("spend.over_limit");
  });

  it("Shot 1A (4 s, 16:9): submit → PENDING → THROTTLED → RUNNING → SUCCEEDED → private asset, one task, actual cost", async () => {
    const { h, fake, worker } = await setup();
    const { jobId, attemptId, prepared } = await h.submit("1A", "gen4.5", { provider: "runway" });
    expect(prepared.evaluation.gate.blockers).toEqual([]);
    expect(jobId).toBeTruthy();
    const job = await drive(h, worker(), jobId!);
    expect(job.status).toBe("succeeded");
    expect(job.providerJobId).toBe("task_1");
    expect(fake.created).toHaveLength(1); // THROTTLED never caused a resubmission
    const view = (await h.repo.generation.getAttemptView(attemptId!))!;
    expect(view.outputs).toHaveLength(1);
    expect(view.outputs[0]!.asset.source).toBe("provider_output");
    expect(view.costs.map((c) => [c.kind, c.amount])).toEqual(
      expect.arrayContaining([
        ["estimated", 0.48],
        ["actual", 0.48],
      ]),
    );
    // the frozen history holds no image bytes and no URLs
    const frozen = JSON.stringify(view.attempt);
    expect(frozen).not.toContain("data:image");
    expect(frozen).not.toContain("127.0.0.1");
    const events = (await h.repo.generation.listJobEvents(jobId!)).map((e) => e.note).join(" ");
    expect(events).not.toContain("data:image");
    expect(events).not.toContain("127.0.0.1");
    // outbound request really contained the first frame as a data URI
    const sent = fake.created[0]!.body as { promptImage: Array<{ uri: string }> };
    expect(sent.promptImage[0]!.uri.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("an ambiguous submission failure is NEVER blindly repeated (no idempotency at Runway)", async () => {
    const { h, fake, worker } = await setup();
    fake.createError.push(Object.assign(new Error("timeout"), { name: "APIConnectionTimeoutError" }));
    const { jobId, attemptId } = await h.submit("1A", "gen4.5", { provider: "runway" });
    const job = await drive(h, worker(), jobId!, 6);
    expect(job.status).toBe("failed");
    expect(job.lastErrorCode).toBe("submission_outcome_unknown");
    expect(fake.created).toHaveLength(0); // the one create call threw; no second one was made
    const view = (await h.repo.generation.getAttemptView(attemptId!))!;
    expect(view.costs.map((c) => c.kind)).toContain("unknown");
  });

  it("a definitive rejection (429) is retried with backoff; content rejection is not", async () => {
    const a = await setup();
    a.fake.createError.push(
      Object.assign(new Error("slow down"), { status: 429, headers: { "retry-after": "2" } }),
    );
    const sa = await a.h.submit("1A", "gen4.5", { provider: "runway" });
    const ja = await drive(a.h, a.worker(), sa.jobId!);
    expect(ja.status).toBe("succeeded");
    expect(a.fake.created).toHaveLength(1);

    const b = await setup();
    b.fake.defaultScript = (id) => [
      { id, status: "FAILED", failureCode: "SAFETY.INPUT.TEXT", failure: "x", cost: { credits: 0 } },
    ];
    const sb = await b.h.submit("1A", "gen4.5", { provider: "runway" });
    const jb = await drive(b.h, b.worker(), sb.jobId!);
    expect(jb.status).toBe("failed");
    expect(jb.lastErrorCategory).toBe("content_rejected");
    expect(jb.attemptCount).toBe(1); // no retry storm
    expect(b.fake.created).toHaveLength(1);
  });

  it("re-checks the spend gate at execution time: nothing is sent when the estimate exceeds the limit", async () => {
    const { h, fake } = await setup();
    const { jobId } = await h.submit("1A", "gen4.5", { provider: "runway" });
    // the limit was lowered after the job was queued
    const tightened = { ...h.config, paid: { enabled: true, maxUsd: 0.1 } };
    const registry = new ModelRegistry(h.registry.adapters(), tightened, ENV);
    const w = new GenerationWorker({
      store: h.repo.generation,
      registry,
      sink: h.sink,
      config: tightened,
      logger: silentLogger,
      clock: () => h.clock.now,
      heartbeatMs: 0,
    });
    await w.tick();
    const job = (await h.repo.generation.getJob(jobId!))!;
    expect(job.status).toBe("failed");
    expect(job.lastErrorCode).toBe("spend_gate_blocked");
    expect(fake.created).toHaveLength(0);
  });

  it("a provider switched off after queueing receives no submission (kill switch)", async () => {
    const { h, fake } = await setup();
    const { jobId } = await h.submit("1A", "gen4.5", { provider: "runway" });
    const closed = { ...h.config, paid: { enabled: false, maxUsd: null } };
    const registry = new ModelRegistry(h.registry.adapters(), closed, ENV);
    const w = new GenerationWorker({
      store: h.repo.generation,
      registry,
      sink: h.sink,
      config: closed,
      logger: silentLogger,
      clock: () => h.clock.now,
      heartbeatMs: 0,
    });
    await w.tick();
    expect((await h.repo.generation.getJob(jobId!))!.status).toBe("failed");
    expect(fake.created).toHaveLength(0);
  });

  it("a cancel that loses the race to completion keeps the paid output", async () => {
    const { h, fake, worker } = await setup();
    const { jobId, attemptId } = await h.submit("1A", "gen4.5", { provider: "runway" });
    const w = worker();
    await w.tick(); // submit
    h.clock.advance(6000);
    await w.tick(); // PENDING
    await h.repo.generation.requestCancel(jobId!, h.clock.now.toISOString());
    // by the time the worker looks, Runway has already finished
    fake.force = (id) => ({ id, status: "SUCCEEDED", output: [`${base}/out.webm`], cost: { credits: 48 } });
    const job = await drive(h, w, jobId!, 8);
    expect(job.status).toBe("succeeded");
    expect(fake.deleted).toEqual([]);
    const view = (await h.repo.generation.getAttemptView(attemptId!))!;
    expect(view.outputs).toHaveLength(1);
  });

  it("a genuine cancel is confirmed by Runway before Prism says so", async () => {
    const { h, fake, worker } = await setup();
    fake.defaultScript = (id) => [{ id, status: "RUNNING", progress: 0.2 }];
    const { jobId } = await h.submit("1A", "gen4.5", { provider: "runway" });
    const w = worker();
    await w.tick();
    h.clock.advance(6000);
    await w.tick();
    await h.repo.generation.requestCancel(jobId!, h.clock.now.toISOString());
    const job = await drive(h, w, jobId!, 6);
    expect(job.status).toBe("cancelled");
    expect(job.cancelOutcome).toBe("confirmed");
    expect(fake.deleted).toEqual(["task_1"]);
  });

  it("an expired/forbidden output URL is retried with a fresh task lookup, then ingested", async () => {
    const { h, fake, worker } = await setup();
    forbidFirstDownload = true;
    const { jobId } = await h.submit("1A", "gen4.5", { provider: "runway" });
    const job = await drive(h, worker(), jobId!, 40);
    expect(job.status).toBe("succeeded");
    expect(fake.created).toHaveLength(1);
  });

  it("respects the provider's concurrency: a second job waits instead of flooding Runway", async () => {
    const { h, fake, worker } = await setup({ codes: ["1A", "2B"] });
    fake.defaultScript = (id) => [{ id, status: "RUNNING", progress: 0.1 }];
    const first = await h.submit("1A", "gen4.5", { provider: "runway" });
    const second = await h.submit("2B", "gen4.5", { provider: "runway" });
    expect(first.jobId && second.jobId).toBeTruthy();
    const w = worker();
    for (let i = 0; i < 4; i++) {
      await w.tick();
      h.clock.advance(6000);
    }
    expect(fake.created).toHaveLength(1); // maxConcurrency 1: the second is held back
    const waiting = (await h.repo.generation.getJob(second.jobId!))!;
    expect(waiting.status).toBe("queued");
    expect(waiting.attemptCount).toBe(0); // waiting does not consume the retry budget
  });
});
