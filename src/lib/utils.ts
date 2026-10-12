import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function assetUrl(asset: { id: string; objectPath: string | null } | null | undefined): string | null {
  return asset?.objectPath ? `/api/assets/${asset.id}` : null;
}
