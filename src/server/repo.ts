import "server-only";
import { cache } from "react";
import { notFound } from "next/navigation";
import { MemoryRepository } from "@/data/memory-repository";
import { UserRepository } from "@/data/postgres-repository";
import type { Repository } from "@/data/repository";
import { persistenceMode } from "@/lib/supabase/config";
import { audioMixFingerprint } from "@/domain/previs/audio-mix";
import { performanceAudioPlanForShot } from "@/domain/previs/audio-mix-shot";
import type { ProjectData } from "@/domain/schemas";
import { UserFacingError } from "./action-result";
import { requireUser } from "./auth";
import { getPool } from "./db";
import { getPrevisRepo } from "./previs";
import { getProductionFrameRepo } from "./production-frames";

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
/** The Shot's current performance-audio mix fingerprint at a render duration; null when it has no audio. */
function safeAudioMixFingerprint(data: ProjectData, shotId: string, renderDurationMs: number): string | null {
  try {
    const plan = performanceAudioPlanForShot(data, shotId, renderDurationMs);
    return plan ? audioMixFingerprint(plan) : null;
  } catch {
    return null;
  }
}

/** Attach each shot's 3D set snapshot (only shots with a production camera; absent otherwise). */
async function withSpatialReferences(data: ProjectData): Promise<ProjectData> {
  const refs = await (
    await getPrevisRepo()
  ).listSpatialReferences(data.project.id, (shotId, renderDurationMs) =>
    safeAudioMixFingerprint(data, shotId, renderDurationMs),
  );
  return Object.keys(refs).length > 0 ? { ...data, spatialReferences: refs } : data;
}

/**
 * Attach every Shot's Production Frame history and selection (Phase 2G.1). Read from the Production Frame repository
 * (memory and Postgres alike), never from the previs repository: it works for a project with no 3D data at all.
 */
async function withProductionFrames(data: ProjectData): Promise<ProjectData> {
  const { frames, selections } = await (await getProductionFrameRepo()).listForProject(data.project.id);
  return { ...data, productionFrames: frames, productionFrameSelections: selections };
}

async function withAttachments(data: ProjectData): Promise<ProjectData> {
  return withProductionFrames(await withSpatialReferences(data));
}

export async function requireProjectFresh(slug: string): Promise<ProjectData> {
  const data = await (await getRepo()).loadProject(slug);
  if (!data) throw new UserFacingError("That project no longer exists.");
  return withAttachments(data);
}

/**
 * Render-path read, de-duplicated per request (layout + page + nested components share one load).
 * Never use from server actions: the cache would hand the post-mutation re-render the pre-mutation data.
 */
export const loadProjectCached = cache(async (slug: string): Promise<ProjectData | null> => {
  const data = await (await getRepo()).loadProject(slug);
  return data ? withAttachments(data) : null;
});

export async function requireProject(slug: string): Promise<ProjectData> {
  const data = await loadProjectCached(slug);
  if (!data) notFound();
  return data;
}
