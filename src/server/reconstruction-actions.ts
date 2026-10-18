"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { PrevisError } from "@/data/previs-repository";
import { assetSchema } from "@/domain/schemas";
import {
  MAX_SPLAT_BYTES,
  SPLAT_FORMAT_INFO,
  UNKNOWN_CALIBRATION,
  type ReconstructionSource,
  type SpatialReconstructionRecord,
} from "@/domain/previs/splat";
import { inspectSplat } from "@/lib/splat/inspect";
import { buildObjectPath } from "@/lib/storage-paths";
import { UserFacingError } from "./action-result";
import { requireUser } from "./auth";
import { getPrevisRepo } from "./previs";
import { getRepo, requireProjectFresh } from "./repo";
import { persistPassBundle, type PassStoreDeps } from "./spatial-pass-store";
import { checksum, getUploadStorage, storageForAsset } from "./storage";

/**
 * Phase 2F M2D.1: import a Gaussian splat into a Location as a private Asset plus an immutable reconstruction record.
 * The server is the authority: it never trusts the filename, the browser's MIME type or the browser's own check. It
 * re-inspects the bytes, verifies that every reference image belongs to this Project, and either stores the Asset AND
 * its record or neither (the same all-or-nothing persistence the control-pass bundles use). No reconstruction
 * provider is involved; "imported" is the only method.
 */
export type ReconstructionResult<T> = ({ ok: true } & T) | { ok: false; error: string; conflict?: boolean };

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const actorOf = (user: Awaited<ReturnType<typeof requireUser>>) =>
  user.kind === "supabase" ? user.id : null;
const MAX_SOURCES = 32;
/** The only non-file fields an import may carry. */
const TEXT_FIELDS = new Set(["projectSlug", "locationId", "name", "sourceAssetIds"]);

async function guarded<T>(body: () => Promise<ReconstructionResult<T>>): Promise<ReconstructionResult<T>> {
  try {
    return await body();
  } catch (err) {
    if (err instanceof PrevisError)
      return { ok: false, error: err.message, conflict: err.code === "conflict" };
    if (err instanceof UserFacingError) return { ok: false, error: err.message };
    if (err instanceof ZodError) return { ok: false, error: "The reconstruction data is not valid." };
    const digest = (err as { digest?: unknown } | null)?.digest;
    if (typeof digest === "string") throw err;
    const ref = randomUUID().slice(0, 8);
    console.error(`[reconstruction ${ref}]`, err instanceof Error ? err.message : "unknown error");
    return { ok: false, error: `Something went wrong importing the splat (ref ${ref}).` };
  }
}

export interface ImportedSplat {
  assetId: string;
  reconstructionId: string;
  name: string;
  format: string;
  mime: string;
  byteSize: number;
  gaussianCount: number;
  checksum: string;
  sourceAssetIds: string[];
}

export async function importGaussianSplat(
  form: FormData,
): Promise<ReconstructionResult<{ splat: ImportedSplat }>> {
  return guarded(async () => {
    for (const [key, value] of form.entries()) {
      if (typeof value !== "string" && key !== "file")
        throw new UserFacingError("Unexpected file in the import.");
      if (typeof value === "string" && !TEXT_FIELDS.has(key))
        throw new UserFacingError(`Unexpected field "${key}" in the import.`);
    }
    const slug = str(form, "projectSlug");
    const locationId = str(form, "locationId");
    const file = form.get("file");
    if (!(file instanceof File)) throw new UserFacingError("Choose a splat file to import.");
    if (file.size === 0) throw new UserFacingError("The file is empty.");
    if (file.size > MAX_SPLAT_BYTES)
      throw new UserFacingError(
        `This file is larger than the ${MAX_SPLAT_BYTES / 1024 / 1024} MB splat limit.`,
      );

    let sourceIds: string[] = [];
    const rawSources = str(form, "sourceAssetIds");
    if (rawSources) {
      try {
        const parsed: unknown = JSON.parse(rawSources);
        if (!Array.isArray(parsed) || parsed.some((x) => typeof x !== "string")) throw new Error("shape");
        sourceIds = [...new Set(parsed as string[])];
      } catch {
        throw new UserFacingError("The reference image list is not valid.");
      }
      if (sourceIds.length > MAX_SOURCES)
        throw new UserFacingError(`At most ${MAX_SOURCES} reference images can be linked.`);
    }

    const user = await requireUser();
    const data = await requireProjectFresh(slug);
    const location = data.locations.find((l) => l.id === locationId);
    if (!location) throw new UserFacingError("That location is not in this project.");

    // every reference image must be one of THIS project's images (the DB cannot enforce JSON members)
    const sources: ReconstructionSource[] = sourceIds.map((id) => {
      const a = data.assets.find((x) => x.id === id);
      if (!a) throw new UserFacingError("A linked reference image is not in this project.");
      if (a.type !== "image") throw new UserFacingError("Only image Assets can be reconstruction sources.");
      return { assetId: a.id, checksum: a.checksum ?? null };
    });

    const bytes = new Uint8Array(await file.arrayBuffer());
    const inspected = inspectSplat(bytes, file.name);
    if (!inspected.ok) throw new UserFacingError(inspected.error);
    const info = SPLAT_FORMAT_INFO[inspected.format];

    const stamp = new Date().toISOString();
    const assetId = randomUUID();
    const storage = await getUploadStorage();
    const repo = await getRepo();
    const previs = await getPrevisRepo();
    const baseName =
      (str(form, "name") || file.name.replace(/\.[^.]+$/, "")).slice(0, 120) || "Gaussian splat";
    const objectPath = buildObjectPath(data.project.id, assetId, `${assetId}${info.extension}`);
    const sum = checksum(bytes);
    const asset = assetSchema.parse({
      id: assetId,
      projectId: data.project.id,
      createdBy: actorOf(user),
      type: "3d",
      purpose: "spatial_reconstruction",
      source: "import",
      name: `${location.name} — ${baseName}`,
      originalFilename: file.name.slice(0, 200),
      storageProvider: storage.name,
      bucket: storage.bucket,
      objectPath,
      mime: info.mime,
      byteSize: bytes.length,
      checksum: sum,
      width: null,
      height: null,
      durationMs: null,
      frameRate: null,
      sampleRate: null,
      channels: null,
      tags: ["gaussian_splat", inspected.format],
      notes: "",
      metadata: { gaussianCount: inspected.gaussianCount, format: inspected.format },
      createdAt: stamp,
      updatedAt: stamp,
    });

    const deps: PassStoreDeps = {
      putObject: async (path, data_, mime) => void (await storage.put(path, data_, mime)),
      upsertAsset: (a) => repo.upsert(data.project.id, "assets", a),
      removeAsset: (id) => repo.remove(data.project.id, "assets", id),
      removeObject: async (a) => {
        const s = await storageForAsset(a);
        if (s && a.objectPath) await s.remove(a.objectPath);
      },
    };

    const reconstructionId = randomUUID();
    let record: SpatialReconstructionRecord | null = null;
    await persistPassBundle(deps, [{ asset, bytes, objectPath, mime: info.mime }], async () => {
      record = await previs.recordReconstruction({
        id: reconstructionId,
        projectId: data.project.id,
        locationId,
        method: "imported",
        resultKind: "gaussian_splat",
        resultAssetId: assetId,
        resultChecksum: sum,
        resultFormat: inspected.format,
        gaussianCount: inspected.gaussianCount,
        sources,
        calibration: { ...UNKNOWN_CALIBRATION },
        userId: actorOf(user),
        now: stamp,
      });
      return { existing: false, record };
    });
    revalidatePath(`/projects/${slug}`, "layout");
    return {
      ok: true,
      splat: {
        assetId,
        reconstructionId,
        name: asset.name,
        format: inspected.format,
        mime: info.mime,
        byteSize: bytes.length,
        gaussianCount: inspected.gaussianCount,
        checksum: sum,
        sourceAssetIds: sources.map((s) => s.assetId),
      },
    };
  });
}
