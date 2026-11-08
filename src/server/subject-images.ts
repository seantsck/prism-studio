import "server-only";
import type { ImageSubjectRef, SubjectAttemptView } from "@/data/generation-repository";
import { catalogModel } from "@/domain/generation/models/catalog";
import { hasStoredImage } from "@/domain/generation/subject-image";
import type { ProjectData } from "@/domain/schemas";
import { assetUrl } from "@/lib/utils";
import { PRISM_MATTING_PROVIDER_ID } from "@/generation/providers/prism-matting/adapter";
import { getGenerationRepo, getRegistry } from "./generation";

export interface ImageModelOption {
  provider: string;
  modelId: string;
  label: string;
  aspectRatios: string[];
  available: boolean;
  /** true for models that spend money (shown, never chosen silently) */
  paid: boolean;
  /** Phase 5B-I2: native transparent backgrounds (the option is refused, never faked, for other models) */
  transparency: boolean;
  /** Phase 5B-I2: the model edits a supplied image (image-to-image) */
  editing: boolean;
  /** Quality ids the catalog lists for the model (empty = no quality option) */
  qualities: string[];
}

/** Phase 5B-I2: an image of this subject that "Edit Image" may start from. */
export interface EditSource {
  assetId: string;
  label: string;
  url: string | null;
}

/**
 * Phase 5B-I1/I2: what a Character / Location page shows. Reading never starts work (memory mode's inline worker starts
 * only when something is submitted).
 */
export async function subjectImageState(
  subject: ImageSubjectRef,
  data?: ProjectData,
): Promise<{ attempts: SubjectAttemptView[]; models: ImageModelOption[]; sources: EditSource[] }> {
  const repo = await getGenerationRepo({ startInlineWorker: false });
  const registry = getRegistry();
  const models = registry
    .models()
    .filter(
      (m) =>
        m.capabilities.image &&
        // Phase 5B-I3: background removal is its own action, never a generation or edit model
        m.provider !== PRISM_MATTING_PROVIDER_ID &&
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
      transparency: m.capabilities.image!.transparency,
      editing: m.capabilities.modalities.includes("image_to_image") && m.capabilities.image!.editing,
      qualities: catalogModel(m.provider, m.modelId)?.image?.qualities.map((q) => q.id) ?? [],
    }));
  const attempts = await repo.listSubjectImageAttempts(subject);
  return { attempts, models, sources: data ? editSources(data, subject, attempts) : [] };
}

function editSources(
  data: ProjectData,
  subject: ImageSubjectRef,
  attempts: SubjectAttemptView[],
): EditSource[] {
  const assets = new Map(data.assets.map((a) => [a.id, a]));
  const out: EditSource[] = [];
  const add = (assetId: string | null, label: string) => {
    const a = assetId ? assets.get(assetId) : undefined;
    if (!hasStoredImage(a) || out.some((x) => x.assetId === a.id)) return;
    out.push({ assetId: a.id, label, url: assetUrl(a) ?? null });
  };
  for (const v of attempts)
    for (const o of v.outputs) add(o.asset.id, `Generated #${v.attempt.attemptNumber} (${v.attempt.model})`);
  if (subject.kind === "character") {
    for (const r of data.identityRefs.filter((x) => x.characterId === subject.characterId))
      add(r.assetId, `Reference: ${r.label || r.slot}`);
    for (const l of data.looks.filter((x) => x.characterId === subject.characterId))
      for (const id of l.referenceAssetIds) add(id, `Look "${l.name}"`);
  } else {
    const loc = data.locations.find((l) => l.id === subject.locationId);
    for (const id of loc?.referenceAssetIds ?? []) add(id, `Reference: ${assets.get(id)?.name ?? "image"}`);
  }
  return out;
}
