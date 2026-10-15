import { createHash } from "node:crypto";
import type { MediaQaRepository, DerivedAsset, DerivationOperation } from "@/data/media-qa-repository";
import {
  derivationKey,
  resolveConform,
  type DeliveryConformPlan,
  type ResolvedConform,
} from "@/domain/framing/conform";
import type { Asset } from "@/domain/schemas";
import { buildObjectPath, safeFileName } from "@/lib/storage-paths";
import type { MediaOutput, MediaProbe, MediaProcessor } from "./types";

/**
 * Delivery conform + review artifacts (Phase 2C). Orchestrates: read the ORIGINAL → run deterministic media
 * operations → store as NEW private assets → record lineage → (optionally) select the delivery master.
 *
 * Invariants:
 *  - the provider original is never modified or replaced;
 *  - every derived file has a deterministic identity (parent checksum + operation + normalized parameters +
 *    processor identity), so a retry reuses instead of duplicating;
 *  - derived asset ids and object paths are deterministic, so an object uploaded before a crash is found
 *    again, verified by checksum, and re-used;
 *  - nothing here depends on file names from users or providers.
 */

export interface MediaStorage {
  readonly name: "local" | "supabase";
  readonly bucket: string | null;
  get(objectPath: string): Promise<Uint8Array | null>;
  put(objectPath: string, bytes: Uint8Array, contentType: string): Promise<void>;
  remove(objectPath: string): Promise<void>;
}

export interface DeliveryDeps {
  processor: MediaProcessor;
  storage: MediaStorage;
  qa: MediaQaRepository;
  userId: string | null;
  now?: () => Date;
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** uuid-v5-style id from the derivation key: same derivation ⇒ same asset id (crash-safe). */
export function derivedAssetId(key: string): string {
  const h = createHash("sha256").update(`prism-derived-asset|${key}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

export class DeliveryError extends Error {
  constructor(
    readonly code: "missing_object" | "checksum_mismatch" | "no_output",
    message: string,
  ) {
    super(message);
    this.name = "DeliveryError";
  }
}

/** Reads an asset's bytes and proves they are the bytes that were recorded. */
export async function readVerified(asset: Asset, storage: MediaStorage): Promise<Uint8Array> {
  if (!asset.objectPath) throw new DeliveryError("missing_object", "The asset has no stored file.");
  const bytes = await storage.get(asset.objectPath);
  if (!bytes) throw new DeliveryError("missing_object", "The asset's file is missing from storage.");
  if (asset.checksum && sha256(bytes) !== asset.checksum) {
    throw new DeliveryError("checksum_mismatch", "The stored file does not match its recorded checksum.");
  }
  return bytes;
}

/** Uploads unless an object with exactly these bytes is already there; replaces a partial/corrupt leftover. */
async function ensureObject(storage: MediaStorage, objectPath: string, bytes: Uint8Array, mime: string) {
  const existing = await storage.get(objectPath);
  if (existing && sha256(existing) === sha256(bytes)) return;
  if (existing) await storage.remove(objectPath);
  await storage.put(objectPath, bytes, mime);
}

function assetFor(args: {
  id: string;
  parent: Asset;
  out: Pick<MediaOutput, "bytes" | "mime" | "probe">;
  name: string;
  tags: string[];
  metadata: Record<string, unknown>;
  deps: DeliveryDeps;
  now: string;
}): Asset {
  const { out, probe } = { out: args.out, probe: args.out.probe };
  const type: Asset["type"] = probe.kind === "image" ? "image" : probe.kind === "audio" ? "audio" : "video";
  const filename = safeFileName(args.name);
  return {
    id: args.id,
    projectId: args.parent.projectId,
    createdBy: args.deps.userId,
    type,
    // Derived media of a generation is kept out of the package-input revision (same as provider outputs).
    purpose: "generation_output",
    source: "derived",
    name: filename,
    originalFilename: filename,
    storageProvider: args.deps.storage.name,
    bucket: args.deps.storage.bucket,
    objectPath: buildObjectPath(args.parent.projectId, args.id, filename),
    mime: out.mime,
    byteSize: out.bytes.length,
    checksum: sha256(out.bytes),
    width: probe.width,
    height: probe.height,
    durationMs: probe.durationMs,
    frameRate: probe.fps,
    sampleRate: probe.audioSampleRate,
    channels: probe.audioChannels,
    tags: args.tags,
    notes: "",
    metadata: args.metadata,
    createdAt: args.now,
    updatedAt: args.now,
  };
}

async function derive(args: {
  deps: DeliveryDeps;
  parent: Asset;
  parentChecksum: string;
  attemptId: string | null;
  operation: DerivationOperation;
  slot: string;
  parameters: Record<string, unknown>;
  name: string;
  tags: string[];
  /** Produces the file. Only called when no derivation with this identity exists yet. */
  produce: () => Promise<MediaOutput>;
}): Promise<DerivedAsset & { created: boolean }> {
  const { deps } = args;
  const identity = await deps.processor.identity();
  const processorId = `${identity.name}/${identity.adapterVersion}`;
  const key = derivationKey({
    parentChecksum: args.parentChecksum,
    operation: args.operation,
    parameters: args.parameters,
    processorVersion: processorId,
  });
  const existing = await deps.qa.findDerivationByKey(args.parent.projectId, key);
  if (existing) return { ...existing, created: false };

  const out = await args.produce();
  const id = derivedAssetId(key);
  const now = (deps.now?.() ?? new Date()).toISOString();
  const asset = assetFor({
    id,
    parent: args.parent,
    out,
    name: args.name,
    tags: args.tags,
    metadata: {
      derivedFrom: args.parent.id,
      operation: args.operation,
      derivationKey: key,
      processor: processorId,
      processorToolVersion: identity.toolVersion,
    },
    deps,
    now,
  });
  await ensureObject(deps.storage, asset.objectPath!, out.bytes, out.mime);
  return deps.qa.recordDerivation({
    asset,
    parentAssetId: args.parent.id,
    operation: args.operation,
    derivationKey: key,
    parameters: args.parameters,
    processor: identity.name,
    processorVersion: `${identity.adapterVersion} (${identity.toolVersion})`,
    attemptId: args.attemptId,
    slot: args.slot,
    createdBy: deps.userId,
    now,
  });
}

// ───────────────────────── delivery conform ─────────────────────────

export interface ConformResult {
  /** The asset now selected as the delivery master (the derived file, or the original when no conform was needed). */
  deliveryAsset: Asset;
  derived: (DerivedAsset & { created: boolean }) | null;
  resolved: ResolvedConform;
  probe: MediaProbe;
}

export async function conformAttemptOutput(args: {
  attemptId: string;
  attemptLabel: string;
  original: Asset;
  plan: DeliveryConformPlan;
  deps: DeliveryDeps;
}): Promise<ConformResult> {
  const { deps, original, plan } = args;
  const bytes = await readVerified(original, deps.storage);
  const probe = await deps.processor.probe(bytes);
  const resolved = resolveConform(plan, {
    width: probe.width ?? 0,
    height: probe.height ?? 0,
    durationMs: probe.durationMs,
  });
  const needed = resolved.crop !== null || resolved.pad !== null || resolved.trimMs !== null;
  const now = (deps.now?.() ?? new Date()).toISOString();

  if (!needed) {
    // The provider original already satisfies the plan: it IS the delivery master (the original is kept as is).
    await deps.qa.selectDelivery({
      attemptId: args.attemptId,
      projectId: original.projectId,
      assetId: original.id,
      originalAssetId: original.id,
      conform: { plan, resolved: { crop: null, pad: null, trimMs: null }, derivedFrom: null },
      selectedBy: deps.userId,
      now,
    });
    return { deliveryAsset: original, derived: null, resolved, probe };
  }

  const parameters = {
    plan,
    resolved: { crop: resolved.crop, pad: resolved.pad, trimMs: resolved.trimMs },
    input: { width: probe.width, height: probe.height, durationMs: probe.durationMs },
  };
  const checksum = original.checksum ?? sha256(bytes);
  const derived = await derive({
    deps,
    parent: original,
    parentChecksum: checksum,
    attemptId: args.attemptId,
    operation: "conform",
    slot: "delivery",
    parameters,
    name: `${args.attemptLabel}-delivery.${probe.kind === "image" ? "png" : "mp4"}`,
    tags: ["delivery-master", "derived"],
    produce: () =>
      deps.processor.conform(bytes, {
        crop: resolved.crop,
        pad: resolved.pad,
        trimMs: resolved.trimMs,
      }),
  });
  await deps.qa.selectDelivery({
    attemptId: args.attemptId,
    projectId: original.projectId,
    assetId: derived.asset.id,
    originalAssetId: original.id,
    conform: {
      plan,
      resolved: { crop: resolved.crop, pad: resolved.pad, trimMs: resolved.trimMs },
      derivedFrom: original.id,
      derivationKey: derived.derivation.derivationKey,
      version: derived.derivation.version,
      notes: resolved.notes,
      warnings: resolved.warnings,
    },
    selectedBy: deps.userId,
    now,
  });
  return { deliveryAsset: derived.asset, derived, resolved, probe };
}

// ───────────────────────── review frames + contact sheet ─────────────────────────

/** First, 25 %, 50 %, 75 % and last frame (last = one frame before the end so a frame always exists). */
export function reviewFramePositions(durationMs: number | null, fps: number | null): number[] {
  if (!durationMs || durationMs <= 0) return [0];
  const lastStart = Math.max(0, durationMs - 1.5 * (1000 / (fps || 24)));
  const pts = [0, 0.25, 0.5, 0.75].map((f) => Math.min(Math.round(durationMs * f), lastStart));
  pts.push(Math.round(lastStart));
  return [...new Set(pts)];
}

export interface ReviewArtifacts {
  frames: Array<{ atMs: number; derived: DerivedAsset }>;
  contactSheet: DerivedAsset | null;
}

export async function ensureReviewArtifacts(args: {
  attemptId: string;
  attemptLabel: string;
  subject: Asset;
  deps: DeliveryDeps;
}): Promise<ReviewArtifacts> {
  const { deps, subject } = args;
  const bytes = await readVerified(subject, deps.storage);
  const probe = await deps.processor.probe(bytes);
  const checksum = subject.checksum ?? sha256(bytes);
  const positions = probe.kind === "image" ? [0] : reviewFramePositions(probe.durationMs, probe.fps);

  const frames: ReviewArtifacts["frames"] = [];
  const frameBytes: Uint8Array[] = [];
  for (const at of positions) {
    const slot = `frame:${at}`;
    const d = await derive({
      deps,
      parent: subject,
      parentChecksum: checksum,
      attemptId: args.attemptId,
      operation: "frame_extract",
      slot,
      parameters: { atMs: at },
      name: `${args.attemptLabel}-frame-${at}ms.png`,
      tags: ["review-frame", "derived"],
      produce: async () => {
        const f = await deps.processor.extractFrame(bytes, at);
        return {
          bytes: f.bytes,
          mime: f.mime,
          extension: "png",
          probe: await deps.processor.probe(f.bytes),
        };
      },
    });
    frames.push({ atMs: at, derived: d });
    const stored = await readVerified(d.asset, deps.storage);
    frameBytes.push(stored);
  }
  if (frames.length < 2) return { frames, contactSheet: null };
  const sheet = await derive({
    deps,
    parent: subject,
    parentChecksum: checksum,
    attemptId: args.attemptId,
    operation: "contact_sheet",
    slot: "contact_sheet",
    parameters: { frames: frames.map((f) => [f.atMs, f.derived.asset.checksum]), columns: 5, cellWidth: 320 },
    name: `${args.attemptLabel}-contact-sheet.png`,
    tags: ["contact-sheet", "derived"],
    produce: () => deps.processor.generateContactSheet(frameBytes, { columns: 5, cellWidth: 320 }),
  });
  return { frames, contactSheet: sheet };
}
