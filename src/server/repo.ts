import "server-only";
import { cache } from "react";
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
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function getRepo(): Repository {
  if (!globalThis.__prismRepo) {
    if (process.env.PRISM_STUDIO_PERSISTENCE === "supabase") {
      const owner = process.env.PRISM_STUDIO_DEV_USER_ID;
      if (!owner)
        throw new Error("PRISM_STUDIO_DEV_USER_ID is required when PRISM_STUDIO_PERSISTENCE=supabase");
      if (!UUID_RE.test(owner))
        throw new Error(
          "PRISM_STUDIO_DEV_USER_ID must be the Supabase Auth user UUID, not an email address.",
        );
      globalThis.__prismRepo = new PostgresRepository(getPool(), owner);
    } else {
      globalThis.__prismRepo = new MemoryRepository();
    }
  }
  return globalThis.__prismRepo;
}

/** Always reads from the repository. Server actions use this: they mutate and then re-render in the same request. */
export async function requireProjectFresh(slug: string): Promise<ProjectData> {
  const data = await getRepo().loadProject(slug);
  if (!data) throw new Error(`Project "${slug}" not found`);
  return data;
}

/**
 * Render-path read, de-duplicated per request (layout + page + nested components share one load).
 * Never use from server actions: the cache would hand the post-mutation re-render the pre-mutation data.
 */
export const requireProject = cache(requireProjectFresh);
