import "server-only";
import { buildShotContext } from "@/domain/context";
import { assembleGenerationPackage, type GenerationPackage } from "@/domain/generation-package";
import { getRepo } from "./repo";

/**
 * Build the normalized generation package for a shot by id.
 * Loads the owning project through the repository, resolves the full shot context,
 * and delegates to the pure domain assembler. No provider is contacted.
 */
export async function buildGenerationPackage(shotId: string): Promise<GenerationPackage> {
  const repo = getRepo();
  for (const project of await repo.listProjects()) {
    const data = await repo.loadProject(project.slug);
    if (data?.shots.some((s) => s.id === shotId)) {
      return assembleGenerationPackage(buildShotContext(data, shotId));
    }
  }
  throw new Error(`Shot ${shotId} not found`);
}
