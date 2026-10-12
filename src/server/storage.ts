import "server-only";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { persistenceMode } from "@/lib/supabase/config";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { ASSETS_BUCKET } from "@/lib/storage-paths";
import type { Asset } from "@/domain/schemas";

/**
 * Storage abstraction. Assets record WHERE their bytes live (`storageProvider`, `bucket`, `objectPath`);
 * the provider hides how to reach them.
 *
 *   LocalDiskStorage — memory/demo mode and tests. `.local-storage/<objectPath>`.
 *   SupabaseStorage  — production. PRIVATE bucket `prism-assets`, accessed with the signed-in user's own
 *                      session, so Storage RLS (project ownership by path prefix) applies. Bytes are never
 *                      served from permanent public URLs; reads use short-lived signed URLs.
 */
export interface StorageProvider {
  readonly name: "local" | "supabase";
  readonly bucket: string | null;
  put(objectPath: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(objectPath: string): Promise<Uint8Array | null>;
  /** Short-lived URL the browser can fetch directly, or null if this provider cannot sign (local disk). */
  signedUrl(objectPath: string, ttlSeconds?: number): Promise<string | null>;
  remove(objectPath: string): Promise<void>;
}

const LOCAL_ROOT = path.join(process.cwd(), ".local-storage");

class LocalDiskStorage implements StorageProvider {
  readonly name = "local" as const;
  readonly bucket = null;

  private resolve(objectPath: string): string {
    const full = path.resolve(LOCAL_ROOT, objectPath);
    if (!full.startsWith(LOCAL_ROOT + path.sep)) throw new Error("Invalid storage path");
    return full;
  }

  async put(objectPath: string, bytes: Uint8Array): Promise<void> {
    const full = this.resolve(objectPath);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, bytes);
  }

  async get(objectPath: string): Promise<Uint8Array | null> {
    try {
      return await readFile(this.resolve(objectPath));
    } catch {
      return null;
    }
  }

  async signedUrl(): Promise<string | null> {
    return null;
  }

  async remove(objectPath: string): Promise<void> {
    await rm(this.resolve(objectPath), { force: true });
  }
}

class SupabaseStorage implements StorageProvider {
  readonly name = "supabase" as const;
  readonly bucket = ASSETS_BUCKET;

  constructor(private readonly client: SupabaseClient) {}

  private get files() {
    return this.client.storage.from(ASSETS_BUCKET);
  }

  async put(objectPath: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const { error } = await this.files.upload(objectPath, bytes, { contentType, upsert: false });
    if (error) throw new Error(`Storage upload failed: ${error.message}`);
  }

  async get(objectPath: string): Promise<Uint8Array | null> {
    const { data, error } = await this.files.download(objectPath);
    if (error || !data) return null;
    return new Uint8Array(await data.arrayBuffer());
  }

  async signedUrl(objectPath: string, ttlSeconds = 300): Promise<string | null> {
    const { data, error } = await this.files.createSignedUrl(objectPath, ttlSeconds);
    return error || !data ? null : data.signedUrl;
  }

  async remove(objectPath: string): Promise<void> {
    const { error } = await this.files.remove([objectPath]);
    if (error) throw new Error(`Storage delete failed: ${error.message}`);
  }
}

let local: LocalDiskStorage | undefined;
const localStorageProvider = () => (local ??= new LocalDiskStorage());

/** Where NEW uploads go: Supabase Storage in supabase mode, local disk in memory mode. */
export async function getUploadStorage(): Promise<StorageProvider> {
  if (persistenceMode() === "memory") return localStorageProvider();
  return new SupabaseStorage(await createSupabaseServerClient());
}

/** The provider that holds an existing asset's bytes (null for placeholders without a stored object). */
export async function storageForAsset(
  asset: Pick<Asset, "storageProvider" | "objectPath">,
): Promise<StorageProvider | null> {
  if (!asset.objectPath) return null;
  if (asset.storageProvider === "local") return localStorageProvider();
  if (asset.storageProvider === "supabase") {
    if (persistenceMode() !== "supabase") return null;
    return new SupabaseStorage(await createSupabaseServerClient());
  }
  return null;
}

export function checksum(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
