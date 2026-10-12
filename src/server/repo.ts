import "server-only";
import { MemoryRepository } from "@/data/memory-repository";
import type { Repository } from "@/data/repository";
import type { ProjectData } from "@/domain/schemas";

declare global {
  var __prismRepo: Repository | undefined;
}

/** Process-wide repository (survives HMR). Swap for a Supabase-backed adapter later. */
export function getRepo(): Repository {
  globalThis.__prismRepo ??= new MemoryRepository();
  return globalThis.__prismRepo;
}

export async function requireProject(slug: string): Promise<ProjectData> {
  const data = await getRepo().loadProject(slug);
  if (!data) throw new Error(`Project "${slug}" not found`);
  return data;
}
