import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { parseBuffer } from "music-metadata";
import { assetSchema, type Asset } from "@/domain/schemas";
import type { GenerationResult, ProviderOutput } from "@/domain/generation/schemas";
import { analyzeAudio } from "@/lib/audio-analysis";
import { readImageSize } from "@/lib/image-size";
import { buildObjectPath } from "@/lib/storage-paths";
import { checkUpload, type UploadKind } from "@/lib/upload-policy";
import type { FinalizeSuccess } from "@/data/generation-repository";
import type { FetchLimits } from "./safe-fetch";
import { safeFetch, UnsafeUrlError } from "./safe-fetch";
import type { OutputSink } from "./sink";

/**
 * Output ingestion. Provider output → validated bytes → Prism's private Storage → Asset rows.
 * Prism never keeps depending on a provider URL: after this step the output is ours.
 */
export class IngestError extends Error {
  constructor(
    /** retryable: network/timeouts (try again later). permanent: the output itself is unacceptable. */
    readonly kind: "retryable" | "permanent",
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "IngestError";
  }
}

export interface IngestContext {
  projectId: string;
  attemptId: string;
  ownerUserId: string;
  provider: string;
  model: string;
  providerJobId: string;
  sink: OutputSink;
  allowedHosts: readonly string[];
  limits: FetchLimits;
  now: () => Date;
  /** Tests only. */
  unsafeAllowLoopbackHttp?: boolean;
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

async function obtainBytes(out: ProviderOutput, ctx: IngestContext): Promise<Uint8Array> {
  if (out.source.type === "bytes") {
    const bytes = new Uint8Array(Buffer.from(out.source.base64, "base64"));
    if (bytes.length > ctx.limits.maxBytes) {
      throw new IngestError("permanent", "too_large", "Output is larger than the allowed size.");
    }
    return bytes;
  }
  try {
    const fetched = await safeFetch(
      out.source.url,
      { allowedHosts: ctx.allowedHosts, unsafeAllowLoopbackHttp: ctx.unsafeAllowLoopbackHttp },
      ctx.limits,
    );
    return fetched.bytes;
  } catch (err) {
    if (err instanceof UnsafeUrlError) {
      const transient = err.code === "timeout" || err.code === "network" || err.code === "http_error";
      throw new IngestError(transient ? "retryable" : "permanent", `download_${err.code}`, err.message);
    }
    throw new IngestError("retryable", "download_failed", "Output download failed.");
  }
}

interface Inspected {
  width: number | null;
  height: number | null;
  durationMs: number | null;
  sampleRate: number | null;
  channels: number | null;
  extra: Record<string, unknown>;
}

async function inspect(
  kind: UploadKind,
  bytes: Uint8Array,
  reported: ProviderOutput["reported"],
): Promise<Inspected> {
  const base: Inspected = {
    width: reported.width,
    height: reported.height,
    durationMs: reported.durationMs,
    sampleRate: null,
    channels: null,
    extra: {},
  };
  if (kind === "image") {
    const size = readImageSize(bytes);
    if (size) return { ...base, width: size.width, height: size.height };
    return base;
  }
  if (kind === "audio") {
    try {
      const a = await analyzeAudio(bytes);
      return {
        ...base,
        durationMs: a.durationMs,
        sampleRate: a.sampleRate,
        channels: a.channels,
        extra: { codec: a.codec, container: a.container, waveformStatus: a.waveformStatus },
      };
    } catch {
      return base;
    }
  }
  if (kind === "video") {
    try {
      const meta = await parseBuffer(bytes, undefined, { duration: true });
      const seconds = meta.format.duration;
      return {
        ...base,
        durationMs: seconds ? Math.round(seconds * 1000) : base.durationMs,
        extra: { container: meta.format.container ?? null },
      };
    } catch {
      return base;
    }
  }
  return base;
}

export interface IngestResult {
  outputs: FinalizeSuccess["outputs"];
  /** Object paths written to storage, so a failed finalize can clean up. */
  uploadedPaths: string[];
}

/** Validates, stores and describes every output. On any failure nothing is left in storage. */
export async function ingestOutputs(result: GenerationResult, ctx: IngestContext): Promise<IngestResult> {
  const uploaded: string[] = [];
  const outputs: FinalizeSuccess["outputs"] = [];
  const ordered = [...result.outputs].sort((a, b) => a.position - b.position);
  try {
    for (const out of ordered) {
      const bytes = await obtainBytes(out, ctx);
      const check = checkUpload({ name: out.filename, size: bytes.length, claimedMime: out.mime }, bytes, [
        out.kind,
      ]);
      if (!check.ok || !check.kind || !check.mime) {
        throw new IngestError(
          "permanent",
          "output_invalid",
          check.reason ?? "Output file is not acceptable.",
        );
      }
      const info = await inspect(check.kind, bytes, out.reported);
      const id = randomUUID();
      const objectPath = buildObjectPath(ctx.projectId, id, out.filename);
      await ctx.sink.put(objectPath, bytes, check.mime);
      uploaded.push(objectPath);

      const stamp = ctx.now().toISOString();
      const asset: Asset = assetSchema.parse({
        id,
        projectId: ctx.projectId,
        createdBy: ctx.ownerUserId,
        type: check.kind,
        purpose: "generation_output",
        source: "provider_output",
        name: out.filename,
        originalFilename: out.filename,
        storageProvider: ctx.sink.name,
        bucket: ctx.sink.bucket,
        objectPath,
        mime: check.mime,
        byteSize: bytes.length,
        checksum: sha256(bytes),
        width: info.width,
        height: info.height,
        durationMs: info.durationMs,
        frameRate: out.reported.fps,
        sampleRate: info.sampleRate,
        channels: info.channels,
        tags: ["generated", ctx.provider],
        notes: `Generated by ${ctx.provider} / ${ctx.model}`,
        metadata: {
          ...info.extra,
          generation: {
            attemptId: ctx.attemptId,
            provider: ctx.provider,
            model: ctx.model,
            providerJobId: ctx.providerJobId,
            role: out.role,
            position: out.position,
            reportedDurationMs: out.reported.durationMs,
          },
        },
        createdAt: stamp,
        updatedAt: stamp,
      });
      outputs.push({
        asset,
        role: out.role,
        position: out.position,
        provenance: {
          role: out.role,
          sha256: asset.checksum,
          mime: check.mime,
          reported: out.reported,
          inspected: { width: info.width, height: info.height, durationMs: info.durationMs },
        },
      });
    }
    return { outputs, uploadedPaths: uploaded };
  } catch (err) {
    await Promise.allSettled(uploaded.map((p) => ctx.sink.remove(p)));
    throw err;
  }
}
