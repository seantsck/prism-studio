import { catalogModel, estimateImageCredits } from "./models/catalog";
import { OPENAI_IMAGE_TOKEN_RATES } from "./models/openai-image-catalog";
import { REFERENCE_SET_VIEWS } from "./reference-studio";

/**
 * The plan for a Character's reference set, priced before anything is made: the views the Reference Studio makes
 * (REFERENCE_SET_VIEWS), the photos that make the likeness best, and what the set costs with the model Prism suggests.
 * The first view is made from the creator's photos (or from the description alone); each further view is made from
 * the first, so it is sent one image. Prism's cost per picture is the same upper bound the Studio quotes; the creator
 * sees it as their price (src/domain/pricing/user-price.ts).
 */
export const REFERENCE_PLAN_MODEL = { provider: "openai-image", modelId: "gpt-image-2.5-flare" } as const;
export const REFERENCE_PHOTOS_BEST = [4, 8] as const;
/** A generous prompt for a reference view (the Studio's brief plus the Character's description). */
const PROMPT_BYTES = 2_400;

function pictureCost(referenceImages: number): number | null {
  const cat = catalogModel(REFERENCE_PLAN_MODEL.provider, REFERENCE_PLAN_MODEL.modelId);
  if (!cat) return null;
  const image = estimateImageCredits(cat, {
    tierId: cat.tiers[0]!.id,
    quality: cat.image?.defaultQuality ?? null,
    referenceImages,
    outputCount: 1,
  });
  if (image.amountUsd == null) return null;
  const text = ((PROMPT_BYTES + 400 + referenceImages * 80) * OPENAI_IMAGE_TOKEN_RATES.textInput) / 1_000_000;
  return Math.ceil((image.amountUsd + text) * 10_000) / 10_000;
}

export interface ReferencePlan {
  views: Array<{ id: string; label: string; costUsd: number | null; done: boolean }>;
  /** Prism's cost for the views still to make (null when unknown). */
  remainingCostUsd: number | null;
  modelLabel: string;
}

/** `photos`: the creator's own photos of this Character (sent with the first view, up to 8). */
export function referencePlan(doneViews: ReadonlySet<string>, photos: number): ReferencePlan {
  const first = pictureCost(Math.min(photos, REFERENCE_PHOTOS_BEST[1]));
  const next = pictureCost(1);
  const views = REFERENCE_SET_VIEWS.map((v, i) => ({
    id: v.id,
    label: v.label,
    costUsd: i === 0 ? first : next,
    done: doneViews.has(v.id),
  }));
  const todo = views.filter((v) => !v.done);
  const remainingCostUsd = todo.some((v) => v.costUsd == null)
    ? null
    : Math.round(todo.reduce((s, v) => s + v.costUsd!, 0) * 10_000) / 10_000;
  return {
    views,
    remainingCostUsd,
    modelLabel: catalogModel(REFERENCE_PLAN_MODEL.provider, REFERENCE_PLAN_MODEL.modelId)?.displayName ?? "",
  };
}
