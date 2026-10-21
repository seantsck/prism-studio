import "server-only";
import type { MemoryRepository } from "@/data/memory-repository";
import { rlsPreamble } from "@/data/postgres-repository";
import { PostgresProductionFrameData } from "@/data/production-frame-postgres";
import type { ProductionFrameRepository } from "@/data/production-frame-repository";
import { persistenceMode } from "@/lib/supabase/config";
import { requireUser } from "./auth";
import { getPool } from "./db";
import { getRepo } from "./repo";

/**
 * Production Frames and their selections for the CURRENT user (RLS-bound in Supabase mode). User-domain only: no
 * worker credential can reach these tables. Independent of the 3D/previs repository: a project without any 3D set
 * uses exactly this path.
 */
export async function getProductionFrameRepo(): Promise<ProductionFrameRepository> {
  if (persistenceMode() === "memory") return ((await getRepo()) as MemoryRepository).productionFrames;
  const user = await requireUser();
  return new PostgresProductionFrameData(getPool(), rlsPreamble({ sub: user.id, email: user.email }));
}
