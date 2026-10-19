import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MemoryRepository } from "@/data/memory-repository";
import { assetSchema, type Asset } from "@/domain/schemas";
import { encodeSpzFile, syntheticPlane } from "@/lib/splat/synthetic";
import { createJob, refreshJob, submitJob, type JobServiceDeps } from "@/server/reconstruction-jobs";
import type { PassStoreDeps } from "@/server/spatial-pass-store";
import { ProviderError } from "../provider";
import { readWorldLabsConfig, WorldLabsProvider, type WorldLabsConfig } from "../worldlabs";

/**
 * World Labs Marble adapter against a DETERMINISTIC FAKE HTTP layer (no network). Shapes follow the documented
 * public API (docs.worldlabs.ai, Marble API v1).
 */
const KEY = "wlt_test_key_0123456789";

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeWorldLabs(
  opts: { operation?: (n: number) => unknown; generate?: () => Response | Promise<Response> } = {},
) {
  const calls: Call[] = [];
  let polls = 0;
  let mediaCount = 0;
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}));
    const body =
      init?.body && typeof init.body === "string" ? JSON.parse(init.body) : init?.body ? "<bytes>" : null;
    calls.push({ method: init?.method ?? "GET", url, headers, body });
    const json = (status: number, v: unknown) =>
      new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (url.startsWith("https://storage.googleapis.com/")) return new Response(null, { status: 200 });
    if (url.endsWith("/marble/v1/media-assets:prepare_upload")) {
      mediaCount++;
      return json(200, {
        media_asset: { media_asset_id: `ma_${mediaCount}`, file_name: "x", kind: "image", created_at: "t" },
        upload_info: {
          upload_url: `https://storage.googleapis.com/wl-uploads/ma_${mediaCount}?X-Goog-Signature=SECRETSIG`,
          upload_method: "PUT",
          required_headers: { "x-goog-content-length-range": "0,1048576000" },
        },
      });
    }
    if (/\/marble\/v1\/media-assets\/ma_\d+$/.test(url))
      return json(200, { media_asset_id: url.split("/").pop() });
    if (url.endsWith("/marble/v1/worlds:generate"))
      return opts.generate
        ? opts.generate()
        : json(200, { operation_id: "op_world_1", done: false, created_at: "t" });
    if (url.endsWith("/marble/v1/operations/op_world_1")) {
      polls++;
      return json(200, opts.operation ? opts.operation(polls) : { operation_id: "op_world_1", done: false });
    }
    return json(404, { detail: "not found" });
  });
  return { calls, fetchImpl, polls: () => polls };
}

const worldResponse = {
  operation_id: "op_world_1",
  done: true,
  error: null,
  metadata: { progress: { status: "SUCCEEDED", description: "done" }, world_id: "w_123" },
  cost: { total_credits: 1500, line_items: [{ name: "generation", credits: 1500 }] },
  response: {
    world_id: "w_123",
    display_name: "Lobby",
    world_marble_url: "https://marble.worldlabs.ai/world/w_123",
    model: "marble-1.1",
    assets: {
      caption: "A grand hotel lobby",
      thumbnail_url: "https://cdn.worldlabs.ai/thumb.jpg?sig=1",
      splats: {
        spz_urls: {
          full_res: "https://cdn.worldlabs.ai/w_123/full.spz?sig=abc",
          "500k": "https://cdn.worldlabs.ai/w_123/500k.spz?sig=def",
          "100k": "https://cdn.worldlabs.ai/w_123/100k.spz?sig=ghi",
        },
        semantics_metadata: { metric_scale_factor: 1.7, ground_plane_offset: 0.42 },
      },
      mesh: { collider_mesh_url: "https://cdn.worldlabs.ai/w_123/collider.glb" },
    },
  },
};

function provider(over: Partial<WorldLabsConfig> = {}, fake = fakeWorldLabs()) {
  const downloads: string[] = [];
  const cfg: WorldLabsConfig = {
    apiKey: KEY,
    enabled: true,
    baseUrl: "https://api.worldlabs.ai",
    uploadHosts: ["storage.googleapis.com"],
    resultHosts: ["*.worldlabs.ai"],
    requestTimeoutMs: 1000,
    fetchImpl: fake.fetchImpl as unknown as typeof fetch,
    downloader: async (url, policy, maxBytes) => {
      downloads.push(url);
      expect(policy.allowedHosts).toEqual(["*.worldlabs.ai"]);
      if (url.includes("full.spz") && maxBytes < 100 * 1024 * 1024) {
        const { UnsafeUrlError } = await import("@/generation/safe-fetch");
        throw new UnsafeUrlError("too_large", "too large");
      }
      return encodeSpzFile(syntheticPlane({ n: 12 }));
    },
    ...over,
  };
  return { p: new WorldLabsProvider(cfg), fake, downloads };
}

const img = (ordinal: number) => ({
  ordinal,
  assetId: `asset-${ordinal}-0000-0000`,
  checksum: `sum-${ordinal}`,
  mime: "image/png",
  bytes: new Uint8Array([1, 2, 3, ordinal]),
});

describe("World Labs adapter (fake HTTP, documented Marble v1 contract)", () => {
  it("configuration: an API key alone does not enable it; no key = not configured; enabled+key = available", () => {
    expect(new WorldLabsProvider({ ...readWorldLabsConfig({}), apiKey: null }).status()).toMatchObject({
      configured: false,
      capability: "unknown",
    });
    expect(new WorldLabsProvider({ ...readWorldLabsConfig({ WLT_API_KEY: KEY }) }).status()).toMatchObject({
      configured: true,
      enabled: false,
    });
    expect(
      new WorldLabsProvider(
        readWorldLabsConfig({ WLT_API_KEY: KEY, WORLDLABS_RECONSTRUCTION_ENABLED: "1" }),
      ).status(),
    ).toMatchObject({ configured: true, enabled: true, capability: "available", reason: null });
    expect(readWorldLabsConfig({}).baseUrl).toBe("https://api.worldlabs.ai");
  });

  it("uploads private source bytes through the documented prepare_upload grant; the API key never reaches the signed URL", async () => {
    const { p, fake } = provider();
    const prepared = await p.prepareInputs([img(0), img(1)], []);
    expect(prepared.map((x) => x.providerAssetId)).toEqual(["ma_1", "ma_2"]);
    const prep = fake.calls.filter((c) => c.url.endsWith("media-assets:prepare_upload"));
    expect(prep).toHaveLength(2);
    expect(prep[0]!.headers["WLT-Api-Key"]).toBe(KEY);
    expect(prep[0]!.body).toMatchObject({ kind: "image", extension: "png" });
    const puts = fake.calls.filter((c) => c.url.startsWith("https://storage.googleapis.com/"));
    expect(puts).toHaveLength(2);
    expect(puts[0]!.method).toBe("PUT");
    expect(puts[0]!.headers).toEqual({ "x-goog-content-length-range": "0,1048576000" });
    expect(JSON.stringify(puts)).not.toContain(KEY);
    // the key is only ever a header, never in a URL
    for (const c of fake.calls) expect(c.url).not.toContain(KEY);
  });

  it("reuses a previously uploaded source when its checksum is unchanged (no second upload)", async () => {
    const { p, fake } = provider();
    const first = await p.prepareInputs([img(0)], []);
    const again = await p.prepareInputs([img(0)], first);
    expect(again[0]!.providerAssetId).toBe(first[0]!.providerAssetId);
    expect(fake.calls.filter((c) => c.url.endsWith(":prepare_upload"))).toHaveLength(1);
    // a changed checksum is a new upload
    await p.prepareInputs([{ ...img(0), checksum: "different" }], first);
    expect(fake.calls.filter((c) => c.url.endsWith(":prepare_upload"))).toHaveLength(2);
  });

  it("refuses an upload grant that points outside the allowed hosts (SSRF)", async () => {
    const bad = fakeWorldLabs();
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(":prepare_upload"))
        return new Response(
          JSON.stringify({
            media_asset: { media_asset_id: "ma_x", file_name: "x", kind: "image", created_at: "t" },
            upload_info: { upload_url: "https://169.254.169.254/latest/meta-data", upload_method: "PUT" },
          }),
          { status: 200 },
        );
      return bad.fetchImpl(input, init);
    });
    const { p } = provider({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(p.prepareInputs([img(0)], [])).rejects.toMatchObject({ code: "unsafe_url" });
    expect(fetchImpl.mock.calls.some(([u]) => String(u).includes("169.254"))).toBe(false);
  });

  it("submits ONE documented worlds:generate request: media_asset sources in the user's order, private, tagged with the idempotency key", async () => {
    const { p, fake } = provider();
    const inputs = [
      { ordinal: 0, assetId: "a0", checksum: "s0", providerAssetId: "ma_front" },
      { ordinal: 1, assetId: "a1", checksum: "s1", providerAssetId: "ma_left" },
      { ordinal: 2, assetId: "a2", checksum: "s2", providerAssetId: "ma_right" },
    ];
    const op = await p.submit({
      jobId: "job-1",
      attempt: 1,
      idempotencyKey: "pjabc",
      model: "marble-1.1",
      inputs: [inputs[2]!, inputs[0]!, inputs[1]!], // arrives unsorted: the ORDINALS decide
      options: { displayName: "Lobby", provider: {} },
    });
    expect(op).toMatchObject({ operationId: "op_world_1", status: "running" });
    const gen = fake.calls.filter((c) => c.url.endsWith("/marble/v1/worlds:generate"));
    expect(gen).toHaveLength(1);
    expect(gen[0]!.headers["WLT-Api-Key"]).toBe(KEY);
    expect(gen[0]!.body).toEqual({
      display_name: "Lobby",
      model: "marble-1.1",
      permission: { public: false },
      tags: ["pjabc"],
      world_prompt: {
        type: "multi-image",
        reconstruct_images: false,
        multi_image_prompt: [
          { content: { source: "media_asset", media_asset_id: "ma_front" }, azimuth: null },
          { content: { source: "media_asset", media_asset_id: "ma_left" }, azimuth: null },
          { content: { source: "media_asset", media_asset_id: "ma_right" }, azimuth: null },
        ],
      },
    });
    // a single image uses the documented `image` prompt; 5+ images need reconstruct_images
    await p.submit({
      jobId: "j",
      attempt: 1,
      idempotencyKey: "k",
      model: null,
      inputs: [inputs[0]!],
      options: { displayName: null, provider: {} },
    });
    expect(fake.calls.at(-1)!.body).toMatchObject({
      world_prompt: { type: "image", image_prompt: { source: "media_asset", media_asset_id: "ma_front" } },
    });
    const five = Array.from({ length: 5 }, (_, i) => ({
      ordinal: i,
      assetId: `a${i}`,
      checksum: null,
      providerAssetId: `ma${i}`,
    }));
    await p.submit({
      jobId: "j",
      attempt: 1,
      idempotencyKey: "k",
      model: null,
      inputs: five,
      options: { displayName: null, provider: {} },
    });
    expect(fake.calls.at(-1)!.body).toMatchObject({
      world_prompt: { type: "multi-image", reconstruct_images: true },
    });
  });

  it("maps provider errors truthfully: 402 credits, 429 rate limit, 422 invalid, no answer = timeout (ambiguous)", async () => {
    const mk = (status: number) =>
      provider(
        {},
        fakeWorldLabs({ generate: () => new Response(JSON.stringify({ detail: "nope" }), { status }) }),
      ).p;
    const req = {
      jobId: "j",
      attempt: 1,
      idempotencyKey: "k",
      model: null,
      inputs: [{ ordinal: 0, assetId: "a", checksum: null, providerAssetId: "m" }],
      options: { displayName: null, provider: {} },
    };
    await expect(mk(402).submit(req)).rejects.toMatchObject({ code: "insufficient_credits" });
    await expect(mk(429).submit(req)).rejects.toMatchObject({ code: "rate_limited" });
    await expect(mk(422).submit(req)).rejects.toMatchObject({ code: "invalid_request" });
    const hangingFetch = vi.fn(
      (_u: unknown, init?: RequestInit) =>
        new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          ),
        ),
    );
    const timeoutProvider = provider({
      requestTimeoutMs: 20,
      fetchImpl: hangingFetch as unknown as typeof fetch,
    }).p;
    await expect(timeoutProvider.submit(req)).rejects.toMatchObject({ code: "timeout" });
  });

  it("polls the documented operation and normalises progress, failure and success", async () => {
    const { p } = provider(
      {},
      fakeWorldLabs({
        operation: (n) =>
          n === 1
            ? {
                operation_id: "op_world_1",
                done: false,
                metadata: {
                  progress: { status: "IN_PROGRESS", description: "Generating world" },
                  world_id: "w_123",
                },
              }
            : n === 2
              ? { operation_id: "op_world_1", done: false, metadata: { progress: 40 } }
              : worldResponse,
      }),
    );
    const a = await p.getOperation("op_world_1");
    expect(a).toMatchObject({ status: "running", progress: null, description: "Generating world" });
    expect(a.summary).toMatchObject({ worldId: "w_123", progressStatus: "IN_PROGRESS" });
    expect((await p.getOperation("op_world_1")).progress).toBe(0.4);
    const done = await p.getOperation("op_world_1");
    expect(done).toMatchObject({ status: "succeeded", progress: 1, error: null });
    expect(JSON.stringify(done.summary)).not.toMatch(/https?:/);
    const failed = await provider(
      {},
      fakeWorldLabs({
        operation: () => ({
          operation_id: "op_world_1",
          done: true,
          error: { code: 13, message: "internal" },
        }),
      }),
    ).p.getOperation("op_world_1");
    expect(failed).toMatchObject({ status: "failed", error: { code: "13", message: "internal" } });
  });

  it("extracts SPZ candidates best-first plus the documented scale ESTIMATE; nothing extracted holds a URL except the transient transport", async () => {
    const { p } = provider({}, fakeWorldLabs({ operation: () => worldResponse }));
    const op = await p.getOperation("op_world_1");
    const r = p.extractResult(op);
    expect(r.candidates.map((c) => [c.kind, c.format, c.label])).toEqual([
      ["gaussian_splat", "spz", "full_res"],
      ["gaussian_splat", "spz", "500k"],
      ["gaussian_splat", "spz", "100k"],
      ["mesh", "glb", "collider_mesh"],
    ]);
    expect(r.metricScaleFactor).toBe(1.7);
    expect(r.groundPlaneOffset).toBe(0.42);
    expect(JSON.stringify(r.metadata)).not.toMatch(/https?:|sig=/);
    expect(r.metadata).toMatchObject({ worldId: "w_123", model: "marble-1.1" });
  });

  it("result downloads go through the SSRF-safe downloader with the result-host allow-list and a byte cap", async () => {
    const { p, downloads } = provider({}, fakeWorldLabs({ operation: () => worldResponse }));
    const r = p.extractResult(await p.getOperation("op_world_1"));
    await expect(p.download(r.candidates[0]!, 50 * 1024 * 1024)).rejects.toMatchObject({ code: "too_large" });
    const bytes = await p.download(r.candidates[1]!, 50 * 1024 * 1024);
    expect(bytes.length).toBeGreaterThan(16);
    expect(downloads).toEqual([
      "https://cdn.worldlabs.ai/w_123/full.spz?sig=abc",
      "https://cdn.worldlabs.ai/w_123/500k.spz?sig=def",
    ]);
  });

  it("has no cancel operation (the API documents none) and says so", () => {
    const { p } = provider();
    expect(p.capabilities()).toMatchObject({
      supportsCancel: false,
      supportsIdempotencyKey: false,
      requiresPublicInputUrls: false,
      billable: true,
    });
    expect((p as { cancel?: unknown }).cancel).toBeUndefined();
  });

  it("an unconfigured provider makes no HTTP call at all", async () => {
    const fake = fakeWorldLabs();
    const { p } = provider({ apiKey: null }, fake);
    await expect(p.getOperation("x")).rejects.toBeInstanceOf(ProviderError);
    expect(fake.fetchImpl).not.toHaveBeenCalled();
  });
});

// ───────────────────────── fake World Labs → Prism ingestion, end to end ─────────────────────────

describe("fake World Labs through Prism: bytes → provider assets → operation → poll → SPZ → validation → private Asset → reconstruction", () => {
  it("ingests the best result that fits the cap, records the scale ESTIMATE, and persists no URL or key anywhere", async () => {
    const repo = new MemoryRepository();
    const data = (await repo.loadProject("ojousama"))!;
    const location = data.locations[0]!;
    const images: Asset[] = ["front", "back"].map((n) => {
      const id = randomUUID();
      return assetSchema.parse({
        id,
        projectId: data.project.id,
        createdBy: null,
        type: "image",
        purpose: "location_ref",
        source: "upload",
        name: n,
        originalFilename: `${n}.png`,
        storageProvider: "local",
        bucket: null,
        objectPath: `${data.project.id}/${id}/${n}.png`,
        mime: "image/png",
        byteSize: 4,
        checksum: `sum-${n}`,
        width: 10,
        height: 10,
        durationMs: null,
        frameRate: null,
        sampleRate: null,
        channels: null,
        tags: [],
        notes: "",
        metadata: {},
        createdAt: "2026-10-18T00:00:00Z",
        updatedAt: "2026-10-18T00:00:00Z",
      });
    });
    let t = Date.parse("2026-10-18T00:00:00Z");
    const fake = fakeWorldLabs({
      operation: (n) =>
        n < 2 ? { operation_id: "op_world_1", done: false, metadata: { progress: 50 } } : worldResponse,
    });
    const { p } = provider({}, fake);
    const objects = new Map<string, Uint8Array>();
    const store: PassStoreDeps = {
      putObject: async (path, bytes) => void objects.set(path, bytes),
      upsertAsset: (a) => repo.upsert(data.project.id, "assets", a),
      removeAsset: (id) => repo.remove(data.project.id, "assets", id),
      removeObject: async (a) => void objects.delete(a.objectPath ?? ""),
    };
    const logs: string[] = [];
    const deps: JobServiceDeps = {
      repo: repo.previs,
      providers: new Map([["worldlabs_marble", p]]),
      config: { jobsEnabled: true, paid: { enabled: true, maxUsd: 2 }, pollIntervalMs: 1000 },
      projectAssets: images,
      projectId: data.project.id,
      locationName: () => location.name,
      readAssetBytes: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      store,
      storage: { name: "local", bucket: null },
      userId: null,
      now: () => new Date(t).toISOString(),
      newId: () => randomUUID(),
      log: (e) => logs.push(JSON.stringify(e)),
    };
    const job = await createJob(deps, {
      locationId: location.id,
      sourceAssetIds: images.map((a) => a.id),
      provider: "worldlabs_marble",
      model: "marble-1.1",
      options: {},
    });
    let j = await submitJob(deps, job.id);
    expect(j.status).toBe("running");
    expect(j.providerOperationId).toBe("op_world_1");
    expect(j.providerInputs!.map((x) => x.providerAssetId)).toEqual(["ma_1", "ma_2"]);
    for (let i = 0; i < 4 && j.status !== "succeeded"; i++) {
      t += 1500;
      j = await refreshJob(deps, job.id);
    }
    expect(j.status).toBe("succeeded");
    const rec = (await repo.previs.getReconstruction(j.resultReconstructionId!))!;
    expect(rec).toMatchObject({
      method: "generated",
      resultFormat: "spz",
      // the documented metric_scale_factor is recorded as a provider ESTIMATE (never "manual", never exact)
      calibration: {
        units: "metres",
        metresPerSourceUnit: 1.7,
        scaleMethod: "provider_estimated",
        groundOffsetMetres: 0.42,
      },
      generation: {
        provider: "worldlabs_marble",
        capability: "worlds:generate",
        model: "marble-1.1",
        operationId: "op_world_1",
      },
    });
    // full_res was over the cap, so the 500k resolution was ingested
    expect(j.providerResult).toMatchObject({ resolution: "500k", skippedTooLarge: 1, worldId: "w_123" });
    expect(objects.size).toBe(1);
    // nothing persisted or logged carries a provider URL, signature or the API key
    const persisted = JSON.stringify([j, rec, await repo.previs.listReconstructionJobEvents(job.id), logs]);
    expect(persisted).not.toMatch(/https?:|sig=|X-Goog-Signature|SECRETSIG/);
    expect(persisted).not.toContain(KEY);
  });
});
