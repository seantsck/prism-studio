import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenerationProviderError } from "@/domain/generation/errors";
import {
  generationResultSchema,
  type GenerationResult,
  type ProviderOutput,
} from "@/domain/generation/schemas";
import { sniffUpload } from "@/lib/upload-policy";
import { readGenerationConfig, missingConfig, providerEnvName } from "../config";
import { IngestError, ingestOutputs } from "../ingest";
import { memoryLogger } from "../log";
import { MockProvider } from "../providers/mock";
import { encodeMockPng } from "../providers/mock-image";
import { MOCK_VIDEO_WEBM_BASE64 } from "../providers/mock-video-fixture";
import { ModelRegistry, createRegistry } from "../registry";
import { LocalDiskSink } from "../sink";
import type { GenerationProviderAdapter } from "../provider";
import { makeHarness } from "./helpers";

const png = encodeMockPng(64, 36, 7);
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

function result(outputs: ProviderOutput[]): GenerationResult {
  return generationResultSchema.parse({
    outputs,
    provenance: {
      provider: "mock",
      model: "m",
      providerJobId: "j",
      providerRequestId: null,
      providerModelVersion: null,
      seed: 1,
      startedAt: null,
      completedAt: null,
      actualDurationMs: null,
      actualResolution: null,
      actualFps: null,
      finishReason: "completed",
      usedInputs: [],
      settings: {},
      metadata: {},
    },
    cost: { amount: 0.1, currency: "USD", basis: "test", units: 1 },
  });
}
const out = (over: Partial<ProviderOutput> & Pick<ProviderOutput, "source">): ProviderOutput => ({
  role: "primary",
  position: 0,
  kind: "image",
  filename: "out.png",
  mime: "image/png",
  reported: { width: null, height: null, durationMs: null, fps: null },
  ...over,
});

describe("output ingestion", () => {
  const root = mkdtempSync(path.join(tmpdir(), "prism-ingest-"));
  const sink = new LocalDiskSink(root);
  const PROJECT = "11111111-1111-4111-8111-111111111111";
  const ctx = (over = {}) => ({
    projectId: PROJECT,
    attemptId: "22222222-2222-4222-8222-222222222222",
    ownerUserId: "33333333-3333-4333-8333-333333333333",
    provider: "mock",
    model: "m",
    providerJobId: "job-1",
    sink,
    allowedHosts: [] as string[],
    limits: { maxBytes: 100_000, timeoutMs: 1000, maxRedirects: 1 },
    now: () => new Date("2026-01-01T00:00:00Z"),
    ...over,
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("stores a valid PNG privately and describes it from the BYTES, not the provider's claims", async () => {
    const r = await ingestOutputs(
      result([
        out({
          source: { type: "bytes", base64: b64(png) },
          reported: { width: 9999, height: 9999, durationMs: null, fps: null },
        }),
      ]),
      ctx(),
    );
    const o = r.outputs[0]!;
    expect(o.asset.type).toBe("image");
    expect(o.asset.width).toBe(64); // inspected, not the reported 9999
    expect(o.asset.height).toBe(36);
    expect(o.asset.mime).toBe("image/png");
    expect(o.asset.purpose).toBe("generation_output");
    expect(o.asset.source).toBe("provider_output");
    expect(o.asset.objectPath).toMatch(new RegExp(`^${PROJECT}/[0-9a-f-]{36}/out\\.png$`));
    expect(await sink.get(o.asset.objectPath!)).toBeTruthy();
    expect(o.asset.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("accepts the WebM fixture as video and reads its duration from the container", async () => {
    const r = await ingestOutputs(
      result([
        out({
          kind: "video",
          filename: "clip.webm",
          mime: "video/webm",
          source: { type: "bytes", base64: MOCK_VIDEO_WEBM_BASE64 },
        }),
      ]),
      ctx(),
    );
    expect(r.outputs[0]!.asset.type).toBe("video");
    expect(r.outputs[0]!.asset.durationMs).toBeGreaterThan(4000);
    expect(sniffUpload(new Uint8Array(Buffer.from(MOCK_VIDEO_WEBM_BASE64, "base64")))?.kind).toBe("video");
  });

  it("rejects HTML masquerading as an image, executables, and wrong kinds", async () => {
    const html = Buffer.from("<html><script>alert(1)</script>" + " ".repeat(40));
    const exe = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(64)]);
    for (const bytes of [html, exe]) {
      await expect(
        ingestOutputs(result([out({ source: { type: "bytes", base64: bytes.toString("base64") } })]), ctx()),
      ).rejects.toMatchObject({ kind: "permanent", code: "output_invalid" });
    }
    // declared image but the bytes are a video container
    await expect(
      ingestOutputs(
        result([out({ kind: "image", source: { type: "bytes", base64: MOCK_VIDEO_WEBM_BASE64 } })]),
        ctx(),
      ),
    ).rejects.toBeInstanceOf(IngestError);
  });

  it("rejects oversized outputs before storing anything", async () => {
    const big = Buffer.concat([Buffer.from(png), Buffer.alloc(200_000)]);
    await expect(
      ingestOutputs(result([out({ source: { type: "bytes", base64: big.toString("base64") } })]), ctx()),
    ).rejects.toMatchObject({ code: "too_large" });
  });

  it("refuses provider URLs outside the adapter's allow-list (no SSRF through output descriptors)", async () => {
    for (const url of ["http://169.254.169.254/x.png", "https://internal.corp/x.png", "file:///etc/passwd"]) {
      await expect(
        ingestOutputs(
          result([out({ source: { type: "url", url } })]),
          ctx({ allowedHosts: ["cdn.provider.example"] }),
        ),
      ).rejects.toMatchObject({ kind: "permanent" });
    }
  });

  it("a failure on the second output leaves NOTHING stored from the first", async () => {
    const stored: string[] = [];
    const spy = {
      name: "local" as const,
      bucket: null,
      put: async (p: string) => void stored.push(p),
      get: async () => null,
      remove: async (p: string) => void stored.splice(stored.indexOf(p), 1),
    };
    await expect(
      ingestOutputs(
        result([
          out({ source: { type: "bytes", base64: b64(png) } }),
          out({
            position: 1,
            role: "variant",
            source: { type: "bytes", base64: Buffer.from("garbage-not-a-file").toString("base64") },
          }),
        ]),
        ctx({ sink: spy }),
      ),
    ).rejects.toBeInstanceOf(IngestError);
    expect(stored).toEqual([]);
  });

  describe("download path (loopback server, test-only override)", () => {
    let server: http.Server;
    let base = "";
    beforeAll(async () => {
      server = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(Buffer.from(png));
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(() => new Promise<void>((r) => server.close(() => r())));

    it("downloads, validates and stores a URL output; keeps no URL in the asset", async () => {
      const r = await ingestOutputs(
        result([out({ source: { type: "url", url: `${base}/o.png` } })]),
        ctx({ unsafeAllowLoopbackHttp: true }),
      );
      expect(r.outputs[0]!.asset.width).toBe(64);
      expect(JSON.stringify(r.outputs[0]!.asset)).not.toContain("127.0.0.1");
    });
  });
});

describe("mock provider (fixtures)", () => {
  const provider = new MockProvider({ stageDelayMs: 0 });
  const plan = {
    version: 1 as const,
    sections: [{ key: "subject" as const, title: "Subject", lines: ["Yumeko at the table"] }],
  };
  const request = {
    schemaVersion: 1 as const,
    modality: "image_to_video" as const,
    provider: "mock",
    modelId: "mock-video-1",
    prompt: { positive: "Subject: Yumeko at the table", negative: "no extra people" },
    durationMs: 4500,
    resolution: { width: 1920, height: 1080 },
    aspectRatio: "16:9",
    fps: 24,
    seed: 42,
    references: [{ assetId: "a1", role: "identity" as const, order: 0, label: "Yumeko identity" }],
    startFrameAssetId: "f1",
    endFrameAssetId: null,
    audioAssetIds: ["au1"],
    providerOptions: {},
    idempotencyKey: "fixture-key-0001",
  };
  const ctx = { now: () => new Date("2026-01-01T00:00:00Z"), assets: { read: async () => null } };

  it("compiles the request to a stable, secret-free summary (snapshot)", () => {
    const c = provider.compileRequest(request, plan);
    expect(c).toMatchInlineSnapshot(`
      {
        "attachments": [
          {
            "assetId": "f1",
            "role": "start_frame",
          },
          {
            "assetId": "a1",
            "note": "Yumeko identity",
            "role": "reference:identity",
          },
          {
            "assetId": "au1",
            "role": "audio",
          },
        ],
        "endpoint": "mock:/v1/video (image_to_video)",
        "fields": {
          "aspect_ratio": "16:9",
          "duration_seconds": 4.5,
          "fps": 24,
          "idempotency_key": "fixture-key-0001",
          "model": "mock-video-1",
          "negative_prompt": "no extra people",
          "prompt": "Subject: Yumeko at the table",
          "resolution": "1920x1080",
          "seed": 42,
        },
        "notes": [
          "Mock adapter: the prompt is rendered section by section; no network call is made.",
        ],
      }
    `);
  });

  it("is stateless across 'processes': poll() only needs the job id", async () => {
    const sub = await provider.submit(request, plan, ctx);
    const another = new MockProvider({ stageDelayMs: 0 }); // a different worker instance
    const status = await another.poll(
      {
        providerJobId: sub.providerJobId,
        model: "mock-video-1",
        pollCount: 0,
        submittedAt: null,
        idempotencyKey: request.idempotencyKey,
      },
      { ...ctx, now: () => new Date("2026-01-01T00:00:05Z") },
    );
    expect(status.state).toBe("succeeded");
  });

  it("walks queued → processing → succeeded with a stage delay", async () => {
    const slow = new MockProvider({ stageDelayMs: 1000 });
    const sub = await slow.submit(request, plan, ctx);
    const at = (ms: number) => ({ ...ctx, now: () => new Date(Date.parse("2026-01-01T00:00:00Z") + ms) });
    const ref = {
      providerJobId: sub.providerJobId,
      model: "mock-video-1",
      pollCount: 0,
      submittedAt: null,
      idempotencyKey: "k",
    };
    expect((await slow.poll(ref, at(100))).state).toBe("queued");
    expect((await slow.poll(ref, at(1500))).state).toBe("processing");
    expect((await slow.poll(ref, at(2500))).state).toBe("succeeded");
  });

  it("scripted failures use classified errors", async () => {
    const sub = await provider.submit({ ...request, modelId: "mock-video-rejects" }, plan, ctx);
    const ref = {
      providerJobId: sub.providerJobId,
      model: "mock-video-rejects",
      pollCount: 0,
      submittedAt: null,
      idempotencyKey: "k",
    };
    await expect(
      provider.poll(ref, { ...ctx, now: () => new Date("2026-01-01T00:00:05Z") }),
    ).rejects.toMatchObject({
      category: "content_rejected",
    });
    const flaky = await provider.submit({ ...request, modelId: "mock-video-flaky" }, plan, ctx);
    await expect(
      provider.poll({ ...ref, providerJobId: flaky.providerJobId, model: "mock-video-flaky" }, ctx),
    ).rejects.toBeInstanceOf(GenerationProviderError);
  });

  it("rejects a malformed job id without leaking it", async () => {
    await expect(
      provider.poll(
        {
          providerJobId: "mock_!!!",
          model: "mock-video-1",
          pollCount: 0,
          submittedAt: null,
          idempotencyKey: "k",
        },
        ctx,
      ),
    ).rejects.toMatchObject({ category: "invalid_request" });
  });

  it("outputs are real PNG/WebM files with deterministic content", async () => {
    const sub = await provider.submit(request, plan, ctx);
    const res = await provider.fetchResult(
      {
        providerJobId: sub.providerJobId,
        model: "mock-video-1",
        pollCount: 1,
        submittedAt: null,
        idempotencyKey: "k",
      },
      request,
      ctx,
    );
    expect(res.outputs.map((o) => o.role)).toEqual(["primary", "preview"]);
    const first = res.outputs[0]!;
    expect(first.source.type).toBe("bytes");
    expect(encodeMockPng(32, 18, 5)).toEqual(encodeMockPng(32, 18, 5));
    expect(res.cost.amount).toBeCloseTo(0.225, 6);
  });
});

describe("registry and configuration", () => {
  it("mock is enabled outside production and must be switched on explicitly in production", () => {
    expect(readGenerationConfig({ NODE_ENV: "development" }).enabledProviders).toContain("mock");
    expect(readGenerationConfig({ NODE_ENV: "production" }).enabledProviders).not.toContain("mock");
    expect(
      readGenerationConfig({ NODE_ENV: "production", PRISM_STUDIO_ENABLE_MOCK_PROVIDER: "1" })
        .enabledProviders,
    ).toContain("mock");
  });

  it("limits are clamped to sane bounds", () => {
    const c = readGenerationConfig({
      PRISM_STUDIO_GENERATION_MAX_ACTIVE_PER_PROJECT: "9999",
      PRISM_STUDIO_WORKER_CONCURRENCY: "-3",
    });
    expect(c.limits.maxActivePerProject).toBe(50);
    expect(c.worker.concurrency).toBe(1);
  });

  it("availability names MISSING configuration but never carries values", () => {
    const fake: GenerationProviderAdapter = {
      ...new MockProvider(),
      info: () => ({
        provider: "acme",
        displayName: "Acme",
        kind: "real",
        description: "",
        requiredConfig: [providerEnvName("acme", "api_key")],
        webhooks: false,
      }),
      listModels: () => [
        { ...new MockProvider().listModels()[0]!, provider: "acme", modelId: "acme-1", kind: "real" },
      ],
    } as unknown as GenerationProviderAdapter;
    const secret = "sk-test-SUPER-SECRET-VALUE";
    const noKey = new ModelRegistry(
      [fake],
      readGenerationConfig({ PRISM_STUDIO_GENERATION_PROVIDERS: "acme" }),
      {},
    );
    const a = noKey.availability()[0]!;
    expect(a.configured).toBe(false);
    expect(a.available).toBe(false);
    expect(a.missingConfig).toEqual(["PRISM_STUDIO_PROVIDER_ACME_API_KEY"]);

    const withKey = new ModelRegistry(
      [fake],
      readGenerationConfig({ PRISM_STUDIO_GENERATION_PROVIDERS: "acme" }),
      {
        PRISM_STUDIO_PROVIDER_ACME_API_KEY: secret,
      },
    );
    const b = withKey.availability()[0]!;
    expect(b.available).toBe(true);
    expect(JSON.stringify(withKey.availability())).not.toContain(secret);
    expect(missingConfig(["PRISM_STUDIO_PROVIDER_ACME_API_KEY"], {})).toHaveLength(1);
  });

  it("default registry exposes the mock models and nothing real", () => {
    const r = createRegistry({ NODE_ENV: "development" });
    expect(r.models().every((m) => m.kind === "mock")).toBe(true);
    expect(r.usable().map((m) => m.modelId)).toContain("mock-video-1");
  });
});

describe("generation logging is safe by construction", () => {
  it("drops non-allow-listed fields and redacts secrets in the rest", async () => {
    const { memoryLogger: mk } = await import("../log");
    const log = mk();
    log.info({
      event: "x",
      jobId: "j1",
      prompt: "SECRET PROMPT TEXT",
      authorization: "Bearer abcdefghijklmnop",
      note: "download failed for https://host/x?access_token=abc123def456",
    });
    const line = log.lines[0]!;
    expect(line).not.toContain("SECRET PROMPT TEXT");
    expect(line).not.toContain("Bearer abcdefghijklmnop");
    expect(line).not.toContain("abc123def456");
    expect(line).toContain("j1");
  });

  it("a full worker run never logs prompt, dialogue, base64 or signed URLs", async () => {
    const h = makeHarness();
    const log = memoryLogger();
    const { GenerationWorker } = await import("../worker");
    const worker = new GenerationWorker({
      store: h.repo.generation,
      registry: h.registry,
      sink: h.sink,
      config: h.config,
      logger: log,
      clock: () => h.clock.now,
      heartbeatMs: 0,
    });
    const { jobId } = await h.submit("3A");
    for (let i = 0; i < 6; i++) {
      await worker.tick();
      h.clock.advance(1500);
    }
    expect((await h.repo.generation.getJob(jobId!))?.status).toBe("succeeded");
    const all = log.lines.join("\n");
    expect(all.length).toBeGreaterThan(0);
    for (const forbidden of ["Yumeko", "iVBORw0KGgo", "GkXfo", "access_token", "Authorization"]) {
      expect(all).not.toContain(forbidden);
    }
  });
});
