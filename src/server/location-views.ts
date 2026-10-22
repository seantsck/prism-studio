import "server-only";
import { PostgresLocationViewData } from "@/data/location-view-postgres";
import type { LocationViewRepository } from "@/data/location-view-repository";
import type { MemoryRepository } from "@/data/memory-repository";
import { rlsPreamble } from "@/data/postgres-repository";
import { persistenceMode } from "@/lib/supabase/config";
import { requireUser } from "./auth";
import { getPool } from "./db";
import { getRepo } from "./repo";

/**
 * Location Views and the Shots' view selections for the CURRENT user (RLS-bound in Supabase mode). User-domain only:
 * no worker credential can reach these tables. Independent of the 3D/previs repository.
 */
export async function getLocationViewRepo(): Promise<LocationViewRepository> {
  if (persistenceMode() === "memory") return ((await getRepo()) as MemoryRepository).locationViews;
  const user = await requireUser();
  return new PostgresLocationViewData(getPool(), rlsPreamble({ sub: user.id, email: user.email }));
}
