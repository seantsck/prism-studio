import "server-only";
import { PostgresCharacterContinuityData } from "@/data/character-continuity-postgres";
import type { CharacterContinuityRepository } from "@/data/character-continuity-repository";
import type { MemoryRepository } from "@/data/memory-repository";
import { rlsPreamble } from "@/data/postgres-repository";
import { persistenceMode } from "@/lib/supabase/config";
import { requireUser } from "./auth";
import { getPool } from "./db";
import { getRepo } from "./repo";

/**
 * Character Continuity Locks and the assignments' Lock selections for the CURRENT user (RLS-bound in Supabase mode).
 * User-domain only: no worker credential can reach these tables. No provider, 3D or GPU involved.
 */
export async function getCharacterContinuityRepo(): Promise<CharacterContinuityRepository> {
  if (persistenceMode() === "memory") return ((await getRepo()) as MemoryRepository).characterContinuity;
  const user = await requireUser();
  return new PostgresCharacterContinuityData(getPool(), rlsPreamble({ sub: user.id, email: user.email }));
}
