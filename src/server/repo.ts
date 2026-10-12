import "server-only";
import { MemoryRepository } from "@/data/memory-repository";
import { PostgresRepository } from "@/data/postgres-repository";
import type { Repository } from "@/data/repository";
import type { ProjectData } from "@/domain/schemas";
import { getPool } from "./db";

declare global {
  var __prismRepo: Repository | undefined;
}

/**
 * Process-wide repository (survives HMR).
 *   PRISM_STUDIO_PERSISTENCE=supabase  → PostgresRepository (dedicated Prism Studio project only)
 *   anything else / unset              → MemoryRepository with demo seed
 */
export function getRepo(): Repository {
  if (!globalThis.__prismRepo) {
    if (process.env.PRISM_STUDIO_PERSISTENCE === "supabase") {
      const owner = process.env.PRISM_STUDIO_DEV_USER_ID;
      if (!owner)
        throw new Error("PRISM_STUDIO_DEV_USER_ID is required when PRISM_STUDIO_PERSISTENCE=supabase");
      globalThis.__prismRepo = new PostgresRepository(getPool(), owner);
    } else {
      globalThis.__prismRepo = new MemoryRepository();
    }
  }
  return globalThis.__prismRepo;
}

export async function requireProject(slug: string): Promise<ProjectData> {
  const data = await getRepo().loadProject(slug);
  if (!data) throw new Error(`Project "${slug}" not found`);
  return data;
}
