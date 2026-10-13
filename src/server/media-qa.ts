import "server-only";
import type { MediaQaRepository } from "@/data/media-qa-repository";
import type { MemoryRepository } from "@/data/memory-repository";
import { PostgresMediaQaData } from "@/data/media-qa-postgres";
import { rlsPreamble } from "@/data/postgres-repository";
import { MockContinuityAnalyzer, type ContinuityAnalyzer } from "@/domain/continuity/analyzer";
import { FfmpegMediaProcessor } from "@/media/ffmpeg";
import type { DeliveryDeps } from "@/media/delivery";
import type { MediaProcessor } from "@/media/types";
import { persistenceMode } from "@/lib/supabase/config";
import { requireUser } from "./auth";
import { getPool } from "./db";
import { getRepo } from "./repo";
import { getUploadStorage } from "./storage";

declare global {
  var __prismMediaProcessor: MediaProcessor | undefined;
}

/** Derivations + continuity QA for the CURRENT user (RLS-bound in Supabase mode). */
export async function getMediaQaRepo(): Promise<MediaQaRepository> {
  if (persistenceMode() === "memory") {
    return ((await getRepo()) as MemoryRepository).mediaQa;
  }
  const user = await requireUser();
  return new PostgresMediaQaData(getPool(), rlsPreamble({ sub: user.id, email: user.email }));
}

export function getMediaProcessor(): MediaProcessor {
  globalThis.__prismMediaProcessor ??= new FfmpegMediaProcessor();
  return globalThis.__prismMediaProcessor;
}

/**
 * Analyzer for new QA runs. Only the Mock analyzer exists in Phase 2C; it is always labelled MOCK ANALYSIS.
 * `PRISM_STUDIO_CONTINUITY_ANALYZER=none` runs deterministic checks only.
 */
export function getContinuityAnalyzer(): ContinuityAnalyzer | null {
  return process.env.PRISM_STUDIO_CONTINUITY_ANALYZER === "none" ? null : new MockContinuityAnalyzer();
}

/** Media processing runs in the app server under the user's own session: no extra worker privileges. */
export async function getDeliveryDeps(userId: string | null): Promise<DeliveryDeps> {
  return {
    processor: getMediaProcessor(),
    storage: await getUploadStorage(),
    qa: await getMediaQaRepo(),
    userId,
  };
}
