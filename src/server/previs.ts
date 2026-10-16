import "server-only";
import type { MemoryRepository } from "@/data/memory-repository";
import { PostgresPrevisData } from "@/data/previs-postgres";
import type { PrevisRepository } from "@/data/previs-repository";
import { rlsPreamble } from "@/data/postgres-repository";
import { persistenceMode } from "@/lib/supabase/config";
import { requireUser } from "./auth";
import { getPool } from "./db";
import { getRepo } from "./repo";

/**
 * 3D sets, shot camera bookmarks and master frames for the CURRENT user (RLS-bound in Supabase mode). These are
 * user-domain tables: no worker credential can reach them.
 */
export async function getPrevisRepo(): Promise<PrevisRepository> {
  if (persistenceMode() === "memory") return ((await getRepo()) as MemoryRepository).previs;
  const user = await requireUser();
  return new PostgresPrevisData(getPool(), rlsPreamble({ sub: user.id, email: user.email }));
}
