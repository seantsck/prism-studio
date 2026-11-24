import "server-only";
import sharp from "sharp";
import type { Asset } from "@/domain/schemas";
import type { StorageProvider } from "./storage";

/** The longest side of a preview, in pixels: sharp in the largest frame the pages show (Reference Studio's stage). */
export const PREVIEW_SIZE = 768;

/** Where an asset's preview is kept: beside its original, in the same project folder (the same Storage policy). */
export const previewPathOf = (objectPath: string) =>
  objectPath.replace(/\/[^/]*$/, `/preview-${PREVIEW_SIZE}.webp`);

const isPicture = (a: Asset) =>
  (a.type === "image" || !!a.mime?.startsWith("image/")) &&
  a.mime !== "image/gif" &&
  a.mime !== "image/svg+xml";

/**
 * The asset's preview: the stored one, or (the first time it is asked for) made from the original and stored, so the
 * original is read once and never again for a thumbnail. Null when it is not a picture or cannot be read.
 */
export async function previewOf(storage: StorageProvider, asset: Asset): Promise<Uint8Array | null> {
  if (!asset.objectPath || !isPicture(asset)) return null;
  const path = previewPathOf(asset.objectPath);
  const stored = await storage.get(path);
  if (stored) return stored;
  const original = await storage.get(asset.objectPath);
  if (!original) return null;
  let bytes: Uint8Array;
  try {
    bytes = await sharp(original, { failOn: "none" })
      .rotate()
      .resize({ width: PREVIEW_SIZE, height: PREVIEW_SIZE, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80, alphaQuality: 90 })
      .toBuffer();
  } catch {
    return null;
  }
  // best effort: a preview made twice at once, or a store that refuses it, still serves this one
  await storage.put(path, bytes, "image/webp").catch(() => undefined);
  return bytes;
}
