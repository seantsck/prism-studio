/**
 * Object-key construction for the private `prism-assets` bucket:
 *     <project_id>/<asset_id>/<sanitised filename>
 * The first segment is what the Storage RLS policy authorises on (0010_storage.sql), so it must always be a
 * project uuid built here, never taken from user input.
 */
export const ASSETS_BUCKET = "prism-assets";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function safeFileName(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? "").normalize("NFKC");
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\.{2,}/g, ".")
    .replace(/[^\p{L}\p{N}._ -]+/gu, "_")
    .replace(/\s+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^[._-]+/, "")
    .slice(0, 100);
  return cleaned || "file";
}

export function buildObjectPath(projectId: string, assetId: string, filename: string): string {
  if (!UUID.test(projectId) || !UUID.test(assetId)) throw new Error("Invalid storage path components");
  return `${projectId}/${assetId}/${safeFileName(filename)}`;
}

/** Throws unless `objectPath` is a well-formed key inside `projectId`'s prefix (no traversal, no other project). */
export function assertPathInProject(objectPath: string, projectId: string): void {
  const parts = objectPath.split("/");
  if (
    parts.length !== 3 ||
    parts[0] !== projectId ||
    !UUID.test(parts[1] ?? "") ||
    parts.some((p) => p === "" || p === "." || p === "..") ||
    objectPath.includes("\\")
  ) {
    throw new Error("Storage path is outside the project");
  }
}
