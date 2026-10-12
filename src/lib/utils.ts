import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function assetUrl(
  asset: { id: string; storagePath: string | null } | null | undefined,
): string | null {
  return asset?.storagePath ? `/api/assets/${asset.id}` : null;
}
