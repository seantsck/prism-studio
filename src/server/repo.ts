import "server-only";
import { cache } from "react";
import { notFound } from "next/navigation";
import { MemoryRepository } from "@/data/memory-repository";
import { UserRepository } from "@/data/postgres-repository";
import type { Repository } from "@/data/repository";
import { persistenceMode } from "@/lib/supabase/config";
import type { ProjectData } from "@/domain/schemas";
import { UserFacingError } from "./action-result";
import { requireUser } from "./auth";
import { getPool } from "./db";
import { getPrevisRepo } from "./previs";

declare global {
  var __prismMemoryRepo: Repository | undefined;
}

/**
 * Repository for the CURRENT REQUEST's user.
 *   PRISM_STUDIO_PERSISTENCE=supabase  → UserRepository: verified session → role `authenticated` + JWT claims,
 *                                         so Postgres RLS enforces ownership. No dev-user fallback exists.
 *   anything else / unset              → MemoryRepository with the demo seed (single local user, no accounts).
 * The dev-user environment variable is intentionally NOT read here: it is for scripts and tests only.
 */
export async function getRepo(): Promise<Repository> {
  if (persistenceMode() === "memory") {
    globalThis.__prismMemoryRepo ??= new MemoryRepository();
    return globalThis.__prismMemoryRepo;
  }
  const user = await requireUser();
  return new UserRepository(getPool(), { sub: user.id, email: user.email });
}

/** Always reads from the repository. Server actions use this: they mutate and then re-render in the same request. */
/** Attach each shot's 3D set snapshot (only shots with a production camera; absent otherwise). */
async function withSpatialReferences(data: ProjectData): Promise<ProjectData> {
  const refs = await (await getPrevisRepo()).listSpatialReferences(data.project.id);
  return Object.keys(refs).length > 0 ? { ...data, spatialReferences: refs } : data;
}

export async function requireProjectFresh(slug: string): Promise<ProjectData> {
  const data = await (await getRepo()).loadProject(slug);
  if (!data) throw new UserFacingError("That project no longer exists.");
  return withSpatialReferences(data);
}

/**
 * Render-path read, de-duplicated per request (layout + page + nested components share one load).
 * Never use from server actions: the cache would hand the post-mutation re-render the pre-mutation data.
 */
export const loadProjectCached = cache(async (slug: string): Promise<ProjectData | null> => {
  const data = await (await getRepo()).loadProject(slug);
  return data ? withSpatialReferences(data) : null;
});

export async function requireProject(slug: string): Promise<ProjectData> {
  const data = await loadProjectCached(slug);
  if (!data) notFound();
  return data;
}
