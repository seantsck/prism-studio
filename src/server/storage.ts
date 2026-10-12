import "server-only";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Storage abstraction. Assets reference a `storagePath`; the provider decides where bytes live.
 * LocalDiskStorage is the dev implementation; a SupabaseStorage provider implements the same interface.
 */
export interface StorageProvider {
  put(storagePath: string, bytes: Uint8Array): Promise<void>;
  get(storagePath: string): Promise<Uint8Array | null>;
}

const ROOT = path.join(process.cwd(), ".local-storage");

class LocalDiskStorage implements StorageProvider {
  private resolve(storagePath: string): string {
    const full = path.resolve(ROOT, storagePath);
    if (!full.startsWith(ROOT + path.sep)) throw new Error("Invalid storage path");
    return full;
  }

  async put(storagePath: string, bytes: Uint8Array): Promise<void> {
    const full = this.resolve(storagePath);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, bytes);
  }

  async get(storagePath: string): Promise<Uint8Array | null> {
    try {
      return await readFile(this.resolve(storagePath));
    } catch {
      return null;
    }
  }
}

export const storage: StorageProvider = new LocalDiskStorage();

export function checksum(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function safeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "file";
}
