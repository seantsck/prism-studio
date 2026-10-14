import "server-only";
import type { CandidateRepository } from "@/data/candidates-repository";
import { PostgresCandidateData } from "@/data/candidates-postgres";
import type { MemoryRepository } from "@/data/memory-repository";
import { rlsPreamble } from "@/data/postgres-repository";
import { persistenceMode } from "@/lib/supabase/config";
import { requireUser } from "./auth";
import { getPool } from "./db";
import { getGenerationRepo } from "./generation";
import { getRepo } from "./repo";

/**
 * Candidate sets and human generation reviews for the CURRENT user (RLS-bound in Supabase mode). These
 * tables are user-domain only: no worker credential can reach them.
 */
export async function getCandidateRepo(): Promise<CandidateRepository> {
  if (persistenceMode() === "memory") {
    await getGenerationRepo(); // starts the inline demo worker, like every generation path
    return ((await getRepo()) as MemoryRepository).candidates;
  }
  const user = await requireUser();
  return new PostgresCandidateData(getPool(), rlsPreamble({ sub: user.id, email: user.email }));
}
