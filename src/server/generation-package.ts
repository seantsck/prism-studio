import "server-only";
import { buildShotContext } from "@/domain/context";
import { assembleGenerationPackage, type GenerationPackage } from "@/domain/generation-package";
import { requireProjectFresh } from "./repo";

/**
 * Build the normalized generation package for a shot.
 * Loads the owning project through the (RLS-bound) repository, resolves the full shot context,
 * and delegates to the pure domain assembler. No provider is contacted.
 */
export async function buildGenerationPackage(projectSlug: string, shotId: string): Promise<GenerationPackage> {
  const data = await requireProjectFresh(projectSlug);
  return assembleGenerationPackage(buildShotContext(data, shotId));
}
