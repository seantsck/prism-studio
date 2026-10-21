import "server-only";
import { randomUUID } from "node:crypto";
import { assetSchema, type Asset, type ProjectData } from "@/domain/schemas";
import { analyzeAudio, AudioAnalysisError } from "@/lib/audio-analysis";
import { readImageSize } from "@/lib/image-size";
import { buildObjectPath } from "@/lib/storage-paths";
import { checkUpload, type UploadKind } from "@/lib/upload-policy";
import { UserFacingError } from "./action-result";
import { checksum, getUploadStorage, storageForAsset } from "./storage";

/**
 * The ONE upload pipeline (shared by every server action that accepts a file): size limits, magic-byte sniffing,
 * server-side metadata, private Storage, and best-effort cleanup. Not a "use server" file: it exposes no action.
 */

const now = () => new Date().toISOString();

export interface IngestOptions {
  allowed: readonly UploadKind[];
  purpose: Asset["purpose"];
  source: Asset["source"];
  tags?: string[];
  notes?: string;
}

export interface Ingested {
  asset: Asset;
  bytes: Uint8Array;
  audio: Awaited<ReturnType<typeof analyzeAudio>> | null;
}

/**
 * Validates, inspects and stores one uploaded file, returning the (not yet persisted) Asset row.
 * Everything the product relies on — type, MIME, size, dimensions, duration — is read server-side from
 * the bytes; browser-supplied values are only hints.
 */
export async function ingestUpload(
  data: ProjectData,
  userId: string,
  file: File,
  opts: IngestOptions,
): Promise<Ingested> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const check = checkUpload(
    { name: file.name, size: file.size, claimedMime: file.type },
    bytes,
    opts.allowed,
  );
  if (!check.ok || !check.kind || !check.mime) throw new UserFacingError(check.reason ?? "Unsupported file.");

  let audio: Ingested["audio"] = null;
  if (check.kind === "audio") {
    try {
      audio = await analyzeAudio(bytes);
    } catch (err) {
      if (err instanceof AudioAnalysisError) throw new UserFacingError(err.userMessage);
      throw err;
    }
  }
  const image = check.kind === "image" ? readImageSize(bytes) : null;

  const id = randomUUID();
  const objectPath = buildObjectPath(data.project.id, id, file.name);
  const storage = await getUploadStorage();
  await storage.put(objectPath, bytes, check.mime);

  const stamp = now();
  const asset = assetSchema.parse({
    id,
    projectId: data.project.id,
    createdBy: userId,
    type: check.kind,
    purpose: opts.purpose,
    source: opts.source,
    name: file.name,
    originalFilename: file.name,
    storageProvider: storage.name,
    bucket: storage.bucket,
    objectPath,
    mime: check.mime,
    byteSize: bytes.length,
    checksum: checksum(bytes),
    width: image?.width ?? null,
    height: image?.height ?? null,
    durationMs: audio?.durationMs ?? null,
    frameRate: null,
    sampleRate: audio?.sampleRate ?? null,
    channels: audio?.channels ?? null,
    tags: opts.tags ?? [],
    notes: opts.notes ?? "",
    metadata: audio
      ? {
          codec: audio.codec,
          container: audio.container,
          bitrate: audio.bitrate,
          durationFrom: audio.durationFrom,
          waveformStatus: audio.waveformStatus,
        }
      : {},
    createdAt: stamp,
    updatedAt: stamp,
  });
  return { asset, bytes, audio };
}

/** Best-effort cleanup when the database write that should reference an uploaded object fails. */
export async function discardUpload(asset: Asset): Promise<void> {
  try {
    const storage = await storageForAsset(asset);
    if (storage && asset.objectPath) await storage.remove(asset.objectPath);
  } catch {
    /* orphaned object: harmless, never referenced */
  }
}

export const hasFile = (f: FormData, k: string): File | null => {
  const v = f.get(k);
  return v instanceof File && v.size > 0 ? v : null;
};
