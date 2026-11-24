import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function assetUrl(asset: { id: string; objectPath: string | null } | null | undefined): string | null {
  return asset?.objectPath ? `/api/assets/${asset.id}` : null;
}

/**
 * A small preview of a stored picture (at most PREVIEW_SIZE px on its longest side, WebP): what thumbnails and frames
 * show, so a page never downloads every original. Anything that is not a picture gets its ordinary URL.
 */
export function previewUrl(
  asset: { id: string; objectPath: string | null; type?: string; mime?: string | null } | null | undefined,
): string | null {
  if (!asset?.objectPath) return null;
  const picture = asset.type === "image" || !!asset.mime?.startsWith("image/");
  return picture ? `/api/assets/${asset.id}/preview` : `/api/assets/${asset.id}`;
}

/** The original behind a preview URL (an enlarged view, a download); any other URL as it is. */
export function fullUrl(url: string): string {
  return url.replace(/^(\/api\/assets\/[0-9a-f-]{36})\/preview$/i, "$1");
}
