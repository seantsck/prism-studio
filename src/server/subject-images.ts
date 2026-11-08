import "server-only";
import type { ImageSubjectRef, SubjectAttemptView } from "@/data/generation-repository";
import { getGenerationRepo, getRegistry } from "./generation";

export interface ImageModelOption {
  provider: string;
  modelId: string;
  label: string;
  aspectRatios: string[];
  available: boolean;
  /** true for models that spend money (shown, never chosen silently) */
  paid: boolean;
}

/**
 * Phase 5B-I1: what a Character / Location page shows. Reading never starts work (memory mode's inline worker starts
 * only when something is submitted).
 */
export async function subjectImageState(
  subject: ImageSubjectRef,
): Promise<{ attempts: SubjectAttemptView[]; models: ImageModelOption[] }> {
  const repo = await getGenerationRepo({ startInlineWorker: false });
  const registry = getRegistry();
  const models = registry
    .models()
    .filter(
      (m) =>
        m.capabilities.image &&
        (m.capabilities.modalities.includes("text_to_image") ||
          m.capabilities.modalities.includes("image_to_image")),
    )
    .map((m) => ({
      provider: m.provider,
      modelId: m.modelId,
      label: m.displayName,
      aspectRatios: m.capabilities.image!.aspectRatios,
      available: registry.availabilityOf(m).available,
      paid: registry.billsMoney(m),
    }));
  return { attempts: await repo.listSubjectImageAttempts(subject), models };
}
