import { assertSafeUrl, safeFetch, UnsafeUrlError, type UrlPolicy } from "@/generation/safe-fetch";
import { sanitizeProviderPayload, type JobCostEstimate } from "@/domain/reconstruction/job";
import {
  ProviderError,
  type ExtractedResult,
  type InputMode,
  type OperationSnapshot,
  type PreparedInput,
  type ProviderCapabilities,
  type ProviderInputImage,
  type ProviderStatus,
  type ReconstructionProvider,
  type ResultCandidate,
  type SubmitRequest,
} from "./provider";

/**
 * World Labs Marble adapter (provider id `worldlabs_marble`). ONLY the documented public API is used
 * (https://docs.worldlabs.ai, Marble API v1):
 *
 *   POST /marble/v1/media-assets:prepare_upload  → { media_asset: { media_asset_id }, upload_info: { upload_url,
 *                                                  upload_method, required_headers } }; the bytes are then PUT to
 *                                                  the signed upload_url (server-side; Prism images never go public)
 *   GET  /marble/v1/media-assets/{media_asset_id} → reuse check for a previously uploaded source
 *   POST /marble/v1/worlds:generate              → Operation { operation_id, done, ... }
 *                                                  world_prompt `image` (1 source) or `multi-image` (2-4 sources; up
 *                                                  to 8 with `reconstruct_images: true`), content source `media_asset`
 *   GET  /marble/v1/operations/{operation_id}    → Operation; when done, `response` is the World:
 *                                                  assets.splats.spz_urls { full_res | 500k | 100k },
 *                                                  assets.splats.semantics_metadata { metric_scale_factor,
 *                                                  ground_plane_offset } (1.0 = scale not inferred)
 *
 * Authentication: `WLT-Api-Key` header on API calls only (never on the signed upload/download URLs, never in a URL).
 * The API documents NO idempotency key and NO cancel endpoint: Prism never resubmits on its own, tags each world with
 * the job attempt's key so an ambiguous submission can be found in the World Labs account, and "cancel" only stops
 * Prism tracking (it never claims the remote work stopped).
 */

export const WORLDLABS_DEFAULT_BASE_URL = "https://api.worldlabs.ai";

/**
 * World Labs API pricing, from the official pricing page (docs.worldlabs.ai/api/pricing), checked 2026-10-19.
 * A request's cost is the sum of its usage events: a "pano generation" (0 credits for a panorama image, 80 for a
 * text or non-panorama image, 100 for multi-image or video input) plus the world generation (150 draft, 1,500
 * standard; marble-1.1-plus adds a size-dependent 0-1,500). The page publishes $1.00 per 1,250 credits.
 * World Labs documents no per-operation cost report, so Prism records no "actual" cost for it.
 */
export const WORLDLABS_PRICING = {
  source: "World Labs API pricing (docs.worldlabs.ai/api/pricing)",
  checkedAt: "2026-10-19",
  creditsPerUsd: 1250,
} as const;
const PANO_CREDITS = { panorama: 0, single_image: 80, multi_image: 100 } as const;
const WORLD_CREDITS: Record<string, { min: number; max: number }> = {
  "marble-1.0-draft": { min: 150, max: 150 },
  "marble-1.0": { min: 1500, max: 1500 },
  "marble-1.1": { min: 1500, max: 1500 },
  "marble-1.1-plus": { min: 1500, max: 3000 },
};
const MODELS = [
  { id: "marble-1.0-draft", label: "Marble 1.0 Draft" },
  { id: "marble-1.0", label: "Marble 1.0" },
  { id: "marble-1.1", label: "Marble 1.1" },
  { id: "marble-1.1-plus", label: "Marble 1.1 Plus" },
];
const DEFAULT_MODEL = "marble-1.1";

/** Documented credits for one request. One image is sent with `is_pano: "auto"`, so it may price as a panorama. */
export function worldLabsCredits(model: string, mode: InputMode): { min: number; max: number } | null {
  const world = WORLD_CREDITS[model];
  if (!world) return null;
  const pano =
    mode === "single_image"
      ? { min: PANO_CREDITS.panorama, max: PANO_CREDITS.single_image }
      : mode === "panorama"
        ? { min: PANO_CREDITS.panorama, max: PANO_CREDITS.panorama }
        : { min: PANO_CREDITS.multi_image, max: PANO_CREDITS.multi_image };
  return { min: pano.min + world.min, max: pano.max + world.max };
}
const usd = (credits: number) => Math.round((credits / WORLDLABS_PRICING.creditsPerUsd) * 1000) / 1000;

/** Preferred splat resolutions, best first. A result over Prism's cap falls back to the next one. */
const SPZ_PREFERENCE = ["full_res", "500k", "100k"];

export interface WorldLabsConfig {
  apiKey: string | null;
  enabled: boolean;
  baseUrl: string;
  /** hosts the signed upload URL may point at (World Labs uses Google Cloud Storage signed URLs) */
  uploadHosts: readonly string[];
  /** hosts result downloads may come from */
  resultHosts: readonly string[];
  requestTimeoutMs: number;
  fetchImpl: typeof fetch;
  /** result downloader; defaults to the SSRF-safe downloader */
  downloader: (url: string, policy: UrlPolicy, maxBytes: number) => Promise<Uint8Array>;
  /** tests only: lets the fake server live on http://localhost */
  unsafeAllowLoopbackHttp?: boolean;
}

export function readWorldLabsConfig(env: Record<string, string | undefined> = process.env): WorldLabsConfig {
  const list = (v: string | undefined, fallback: string[]) =>
    v
      ? v
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean)
      : fallback;
  return {
    apiKey: env.WLT_API_KEY?.trim() || null,
    enabled: ["1", "true"].includes((env.WORLDLABS_RECONSTRUCTION_ENABLED ?? "").trim().toLowerCase()),
    baseUrl: (env.WLT_API_BASE_URL?.trim() || WORLDLABS_DEFAULT_BASE_URL).replace(/\/+$/, ""),
    uploadHosts: list(env.WLT_UPLOAD_HOSTS, ["storage.googleapis.com"]),
    resultHosts: list(env.WLT_RESULT_HOSTS, ["*.worldlabs.ai", "wlt-ai-cdn.art", "storage.googleapis.com"]),
    requestTimeoutMs: 30_000,
    fetchImpl: (...a: Parameters<typeof fetch>) => fetch(...a),
    downloader: async (url, policy, maxBytes) =>
      (await safeFetch(url, policy, { maxBytes, timeoutMs: 120_000, maxRedirects: 3 })).bytes,
  };
}

const EXTENSION: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

export class WorldLabsProvider implements ReconstructionProvider {
  readonly id = "worldlabs_marble" as const;

  constructor(private readonly config: WorldLabsConfig) {}

  capabilities(): ProviderCapabilities {
    return {
      capability: "worlds:generate",
      execution: "hosted",
      runner: "provider_api",
      cost: "paid",
      // only what Prism actually sends: image prompts (a single image may be a panorama: `is_pano: "auto"`)
      inputModes: ["single_image", "multi_image"],
      // the collider mesh World Labs also returns is not ingested, so it is not advertised
      resultKinds: ["gaussian_splat"],
      maxInputs: 8,
      models: MODELS,
      defaultModel: DEFAULT_MODEL,
      options: [
        {
          key: "reconstructImages",
          kind: "boolean",
          label: "Reconstruction mode (up to 8 images)",
          default: false,
        },
      ],
      supportsCancel: false,
      supportsProgress: true,
      supportsResume: true,
      supportsIdempotencyKey: false,
      testOnly: false,
    };
  }

  estimateCost(model: string | null, mode: InputMode): JobCostEstimate {
    const id = model ?? DEFAULT_MODEL;
    const credits = worldLabsCredits(id, mode);
    return {
      // a model without a documented price is UNKNOWN, never assumed cheap (the spend gate then blocks it)
      costClass: credits ? "paid" : "unknown",
      usd: credits ? { min: usd(credits.min), max: usd(credits.max) } : null,
      providerUnits: credits ? { unit: "credits", ...credits } : null,
      basis: `${id} · ${mode}`,
      pricingSource: WORLDLABS_PRICING.source,
      pricingCheckedAt: WORLDLABS_PRICING.checkedAt,
    };
  }

  status(): ProviderStatus {
    const configured = !!this.config.apiKey;
    const base: Omit<ProviderStatus, "capability" | "reason"> = {
      provider: this.id,
      label: "World Labs Marble",
      configured,
      enabled: this.config.enabled,
    };
    if (!configured)
      return { ...base, capability: "unknown", reason: "World Labs is not configured on this server." };
    if (!this.config.enabled)
      return {
        ...base,
        capability: "unknown",
        reason:
          "World Labs reconstruction is switched off on this server (WORLDLABS_RECONSTRUCTION_ENABLED).",
      };
    // worlds:generate is part of the documented public Marble API: no probe call is made to "discover" it
    return { ...base, capability: "available", reason: null };
  }

  // ───────────────────────── HTTP ─────────────────────────

  private async api(method: "GET" | "POST", path: string, body?: Json): Promise<Json> {
    if (!this.config.apiKey) throw new ProviderError("not_configured", "World Labs is not configured.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    let res: Response;
    try {
      res = await this.config.fetchImpl(`${this.config.baseUrl}${path}`, {
        method,
        headers: {
          "WLT-Api-Key": this.config.apiKey,
          ...(body ? { "Content-Type": "application/json" } : {}),
          Accept: "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        redirect: "error",
      });
    } catch (e) {
      const aborted = (e as { name?: string })?.name === "AbortError";
      throw new ProviderError(
        aborted ? "timeout" : "network",
        aborted ? "World Labs did not answer in time." : "Could not reach World Labs.",
      );
    } finally {
      clearTimeout(timer);
    }
    let payload: unknown = null;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }
    if (!res.ok) {
      const detail =
        isObj(payload) && typeof payload.detail === "string" ? payload.detail : `HTTP ${res.status}`;
      const code =
        res.status === 402
          ? "insufficient_credits"
          : res.status === 429
            ? "rate_limited"
            : res.status === 400 || res.status === 422
              ? "invalid_request"
              : "http";
      throw new ProviderError(code, `World Labs: ${detail}`.slice(0, 300), res.status);
    }
    if (!isObj(payload)) throw new ProviderError("http", "World Labs returned an unexpected response.");
    return payload;
  }

  private policy(hosts: readonly string[]): UrlPolicy {
    return { allowedHosts: hosts, unsafeAllowLoopbackHttp: this.config.unsafeAllowLoopbackHttp };
  }

  // ───────────────────────── inputs ─────────────────────────

  async prepareInputs(images: ProviderInputImage[], reusable: PreparedInput[]): Promise<PreparedInput[]> {
    const out: PreparedInput[] = [];
    for (const img of images) {
      const prior = reusable.find(
        (r) => r.assetId === img.assetId && r.checksum === img.checksum && !!img.checksum,
      );
      if (prior && (await this.mediaAssetExists(prior.providerAssetId))) {
        out.push({ ...prior, ordinal: img.ordinal });
        continue;
      }
      const extension = EXTENSION[img.mime];
      if (!extension)
        throw new ProviderError("invalid_request", `World Labs does not accept ${img.mime} images.`);
      const prepared = await this.api("POST", "/marble/v1/media-assets:prepare_upload", {
        file_name: `prism-${img.ordinal}-${img.assetId.slice(0, 8)}.${extension}`,
        kind: "image",
        extension,
      });
      const media = isObj(prepared.media_asset) ? prepared.media_asset : null;
      const upload = isObj(prepared.upload_info) ? prepared.upload_info : null;
      const mediaId = media && typeof media.media_asset_id === "string" ? media.media_asset_id : null;
      const uploadUrl = upload && typeof upload.upload_url === "string" ? upload.upload_url : null;
      if (!mediaId || !uploadUrl)
        throw new ProviderError("http", "World Labs did not return an upload grant.");
      await this.putUpload(uploadUrl, upload!, img.bytes);
      out.push({
        ordinal: img.ordinal,
        assetId: img.assetId,
        checksum: img.checksum,
        providerAssetId: mediaId,
      });
    }
    return out;
  }

  private async mediaAssetExists(id: string): Promise<boolean> {
    try {
      const r = await this.api("GET", `/marble/v1/media-assets/${encodeURIComponent(id)}`);
      return typeof r.media_asset_id === "string";
    } catch {
      return false;
    }
  }

  /** PUT to the signed grant. The API key is NOT sent there; only the grant's own required headers. */
  private async putUpload(rawUrl: string, upload: Json, bytes: Uint8Array) {
    let url: URL;
    try {
      // the same scheme / host allow-list / address checks the result downloader applies
      url = assertSafeUrl(rawUrl, this.policy(this.config.uploadHosts));
    } catch (e) {
      throw new ProviderError(
        "unsafe_url",
        e instanceof UnsafeUrlError
          ? `Refused the upload destination: ${e.code}.`
          : "Refused the upload destination.",
      );
    }
    const method = upload.upload_method === "POST" ? "POST" : "PUT";
    const headers: Record<string, string> = {};
    if (isObj(upload.required_headers))
      for (const [k, v] of Object.entries(upload.required_headers))
        if (typeof v === "string" && !/^wlt-api-key$/i.test(k)) headers[k] = v;
    let res: Response;
    try {
      res = await this.config.fetchImpl(url.toString(), {
        method,
        headers,
        body: bytes as BodyInit,
        redirect: "error",
      });
    } catch {
      throw new ProviderError("network", "Uploading a source image to World Labs failed.");
    }
    if (!res.ok)
      throw new ProviderError(
        "http",
        `Uploading a source image to World Labs failed (HTTP ${res.status}).`,
        res.status,
      );
  }

  // ───────────────────────── operations ─────────────────────────

  async submit(req: SubmitRequest): Promise<OperationSnapshot> {
    const n = req.inputs.length;
    if (n < 1 || n > 8)
      throw new ProviderError("invalid_request", "World Labs accepts 1 to 8 source images.");
    const ordered = [...req.inputs].sort((a, b) => a.ordinal - b.ordinal);
    const providerOptions = req.options.provider;
    const reconstruct = n > 4 || providerOptions.reconstructImages === true;
    const content = (p: PreparedInput) => ({ source: "media_asset", media_asset_id: p.providerAssetId });
    const worldPrompt =
      n === 1
        ? { type: "image", image_prompt: content(ordered[0]!), is_pano: "auto" }
        : {
            type: "multi-image",
            reconstruct_images: reconstruct,
            // the user's order is kept: the first image is the primary one
            // Prism has no camera-direction input, so no azimuth is claimed
            multi_image_prompt: ordered.map((p) => ({ content: content(p), azimuth: null })),
          };
    const body: Json = {
      display_name: (req.options.displayName ?? "Prism reconstruction").slice(0, 64),
      model: req.model ?? DEFAULT_MODEL,
      permission: { public: false },
      // the API has no idempotency key; this tag makes an ambiguous submission findable in the account
      tags: [req.idempotencyKey.slice(0, 32)],
      world_prompt: worldPrompt,
    };
    return this.toSnapshot(await this.api("POST", "/marble/v1/worlds:generate", body));
  }

  async getOperation(operationId: string): Promise<OperationSnapshot> {
    return this.toSnapshot(await this.api("GET", `/marble/v1/operations/${encodeURIComponent(operationId)}`));
  }

  private toSnapshot(op: Json): OperationSnapshot {
    const operationId = typeof op.operation_id === "string" ? op.operation_id : null;
    if (!operationId) throw new ProviderError("http", "World Labs did not return an operation id.");
    const done = op.done === true;
    const error = isObj(op.error) ? op.error : null;
    const metadata = isObj(op.metadata) ? op.metadata : {};
    const expired =
      !done && typeof op.expires_at === "string" && Date.parse(op.expires_at) < Date.now() ? true : false;
    const status = done
      ? error
        ? "failed"
        : op.response
          ? "succeeded"
          : "failed"
      : expired
        ? "expired"
        : "running";
    const rawProgress = metadata.progress;
    let progress: number | null = null;
    let description: string | null = null;
    if (typeof rawProgress === "number" && Number.isFinite(rawProgress))
      progress = rawProgress > 1 ? Math.min(1, rawProgress / 100) : Math.max(0, rawProgress);
    else if (isObj(rawProgress)) {
      if (typeof rawProgress.description === "string") description = rawProgress.description.slice(0, 200);
      if (typeof rawProgress.percent === "number") progress = Math.min(1, rawProgress.percent / 100);
    }
    if (status === "succeeded") progress = 1;
    return {
      operationId,
      status,
      progress,
      description,
      summary: (sanitizeProviderPayload({
        done,
        worldId: metadata.world_id ?? (isObj(op.response) ? op.response.world_id : undefined),
        progressStatus: isObj(rawProgress) ? rawProgress.status : undefined,
        createdAt: op.created_at,
        expiresAt: op.expires_at,
        cost: op.cost,
      }) ?? {}) as Record<string, unknown>,
      error: error
        ? {
            code: error.code === null || error.code === undefined ? null : String(error.code),
            message:
              typeof error.message === "string"
                ? error.message.slice(0, 300)
                : "World Labs reported a failure.",
          }
        : done && !op.response
          ? { code: null, message: "World Labs finished without a result." }
          : null,
      rawResult: op.response ?? null,
    };
  }

  extractResult(op: OperationSnapshot): ExtractedResult {
    const world = isObj(op.rawResult) ? op.rawResult : {};
    const assets = isObj(world.assets) ? world.assets : {};
    const splats = isObj(assets.splats) ? assets.splats : {};
    const urls = isObj(splats.spz_urls) ? splats.spz_urls : {};
    const semantics = isObj(splats.semantics_metadata) ? splats.semantics_metadata : {};
    const candidates: ResultCandidate[] = [];
    const labels = [...SPZ_PREFERENCE, ...Object.keys(urls).filter((k) => !SPZ_PREFERENCE.includes(k))];
    for (const label of labels) {
      const u = urls[label];
      if (typeof u === "string")
        candidates.push({ kind: "gaussian_splat", format: "spz", label, transport: u });
    }
    const mesh = isObj(assets.mesh) ? assets.mesh : {};
    if (typeof mesh.collider_mesh_url === "string")
      candidates.push({
        kind: "mesh",
        format: "glb",
        label: "collider_mesh",
        transport: mesh.collider_mesh_url,
      });
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    return {
      candidates,
      metricScaleFactor: num(semantics.metric_scale_factor),
      groundPlaneOffset: num(semantics.ground_plane_offset),
      metadata: (sanitizeProviderPayload({
        worldId: world.world_id,
        model: world.model,
        caption: typeof assets.caption === "string" ? assets.caption.slice(0, 300) : undefined,
        splatResolutions: Object.keys(urls),
        metricScaleFactor: num(semantics.metric_scale_factor),
        groundPlaneOffset: num(semantics.ground_plane_offset),
      }) ?? {}) as Record<string, unknown>,
    };
  }

  async download(candidate: ResultCandidate, maxBytes: number): Promise<Uint8Array> {
    if (typeof candidate.transport !== "string")
      throw new ProviderError("http", "No download for this result.");
    try {
      return await this.config.downloader(
        candidate.transport,
        this.policy(this.config.resultHosts),
        maxBytes,
      );
    } catch (e) {
      if (e instanceof UnsafeUrlError) {
        if (e.code === "too_large")
          throw new ProviderError("too_large", "The result is larger than Prism accepts.");
        if (e.code === "timeout") throw new ProviderError("timeout", "Downloading the result took too long.");
        throw new ProviderError("unsafe_url", `Refused the result download: ${e.code}.`);
      }
      throw new ProviderError("network", "Downloading the result failed.");
    }
  }
}
