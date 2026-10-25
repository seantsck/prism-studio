import "server-only";
import { PostgresEpisodeEditData } from "@/data/episode-edit-postgres";
import type { EpisodeEditRepository } from "@/data/episode-edit-repository";
import type { MemoryRepository } from "@/data/memory-repository";
import { rlsPreamble } from "@/data/postgres-repository";
import { persistenceMode } from "@/lib/supabase/config";
import { requireUser } from "./auth";
import { getPool } from "./db";
import { getRepo } from "./repo";

/**
 * Episode edits for the CURRENT user (RLS-bound in Supabase mode). User-domain only: no worker credential can reach
 * these tables. Phase 2I.1B: persistence only; the actions and the page come in 2I.1C.
 */
export async function getEpisodeEditRepo(): Promise<EpisodeEditRepository> {
  if (persistenceMode() === "memory") return ((await getRepo()) as MemoryRepository).episodeEdits;
  const user = await requireUser();
  return new PostgresEpisodeEditData(getPool(), rlsPreamble({ sub: user.id, email: user.email }));
}
