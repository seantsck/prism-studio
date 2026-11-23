import "server-only";
import { REFERENCE_SET_VIEWS } from "@/domain/generation/reference-studio";
import { REFERENCE_PHOTOS_BEST, REFERENCE_PLAN_MODEL } from "@/domain/generation/reference-plan";
import { referenceOrigin } from "@/domain/generation/reference-integrity";
import type { Character, ProjectData } from "@/domain/schemas";
import { prepareSubjectImage } from "@/generation/subject-submission";
import { UserFacingError } from "./action-result";
import { getGenerationConfig, getRegistry } from "./generation";
import { readSubjectImageForm } from "./reference-request";

/**
 * Making a Character's reference views from its page: one view, or every view still missing, each priced EXACTLY as
 * the Reference Studio prices it (the same preparation as the submission), so the total shown is the total confirmed
 * and charged. Each view starts from the creator's own photos (up to 8); without photos, from the front view once it
 * exists; with neither, from the written description alone.
 */

export interface ViewQuote {
  id: string;
  label: string;
  intent: string;
  /** Prism's cost for this view (null: unknown or not possible, see `problem`) */
  costUsd: number | null;
  problem: string | null;
}

export interface ViewsQuote {
  model: string;
  modelLabel: string;
  paid: boolean;
  /** what every view starts from */
  startsFrom: "photos" | "front" | "description";
  startAssetIds: string[];
  views: ViewQuote[];
  /** the views still to make, and their total (Prism's cost; null when any is unknown) */
  missing: string[];
  totalUsd: number | null;
}

/** The creator's own photos of this Character, then the front view (when it holds a picture). */
function startingImages(data: ProjectData, character: Character) {
  const assets = new Map(data.assets.map((a) => [a.id, a]));
  const refs = data.identityRefs.filter((r) => r.characterId === character.id && r.assetId);
  const photos = [
    ...new Set(
      refs.filter((r) => referenceOrigin(assets.get(r.assetId!)) === "uploaded").map((r) => r.assetId!),
    ),
  ].slice(0, REFERENCE_PHOTOS_BEST[1]);
  const front = refs.find((r) => r.slot === "front")?.assetId ?? null;
  return { photos, front };
}

/** The request a view would send, prepared exactly as the submission prepares it. */
async function prepareView(
  data: ProjectData,
  character: Character,
  intent: string,
  startAssetIds: string[],
  model: string,
  userId: string | null,
  key: string,
) {
  const f = new FormData();
  f.set("subjectKind", "character");
  f.set("subjectId", character.id);
  f.set("intent", intent);
  f.set("model", model);
  f.set("sources", "chosen");
  for (const id of startAssetIds) f.append("startAssetId", id);
  const req = await readSubjectImageForm(f, data, { startInlineWorker: false });
  const registry = getRegistry();
  return {
    registry,
    req,
    prepared: prepareSubjectImage({
      data,
      input: { subject: req.subject, direction: req.direction, sourceAssetIds: req.sourceAssetIds },
      registry,
      provider: req.provider,
      modelId: req.modelId,
      aspectRatio: req.aspectRatio,
      userId,
      idempotencyKey: key,
      config: getGenerationConfig(),
      edit: req.edit,
      options: req.options,
    }),
  };
}

export async function quoteReferenceViews(
  data: ProjectData,
  character: Character,
  done: ReadonlySet<string>,
  userId: string | null,
): Promise<ViewsQuote> {
  const model = `${REFERENCE_PLAN_MODEL.provider}/${REFERENCE_PLAN_MODEL.modelId}`;
  const registry = getRegistry();
  const m = registry.model(REFERENCE_PLAN_MODEL.provider, REFERENCE_PLAN_MODEL.modelId);
  const { photos, front } = startingImages(data, character);
  const views: ViewQuote[] = [];
  for (const v of REFERENCE_SET_VIEWS) {
    // the front view is made from the photos (or the words); the others from the photos, else from the front view
    const start = photos.length ? photos : v.id !== "front" && front ? [front] : [];
    try {
      const { prepared } = await prepareView(data, character, v.intent, start, model, userId, "quote-only");
      views.push({
        id: v.id,
        label: v.label,
        intent: v.intent,
        costUsd: prepared.ok ? (m && registry.billsMoney(m) ? prepared.estimate.amount : 0) : null,
        problem: prepared.ok ? null : (prepared.reasons[0] ?? "This view cannot be made right now."),
      });
    } catch (err) {
      views.push({
        id: v.id,
        label: v.label,
        intent: v.intent,
        costUsd: null,
        problem: err instanceof UserFacingError ? err.message : "This view cannot be priced right now.",
      });
    }
  }
  const missing = views.filter((v) => !done.has(v.id)).map((v) => v.id);
  const todo = views.filter((v) => missing.includes(v.id));
  const totalUsd = todo.some((v) => v.costUsd == null)
    ? null
    : Math.round(todo.reduce((s, v) => s + v.costUsd!, 0) * 10_000) / 10_000;
  return {
    model,
    modelLabel: m?.displayName ?? "",
    paid: !!m && registry.billsMoney(m),
    startsFrom: photos.length ? "photos" : front ? "front" : "description",
    startAssetIds: photos.length ? photos : front ? [front] : [],
    views,
    missing,
    totalUsd,
  };
}

/** The prepared submission for one view (what `makeReferenceViews` creates), its cost recomputed now. */
export async function prepareReferenceView(
  data: ProjectData,
  character: Character,
  viewId: string,
  userId: string | null,
  key: string,
) {
  const v = REFERENCE_SET_VIEWS.find((x) => x.id === viewId);
  if (!v) throw new UserFacingError("Choose one of the reference views.");
  const { photos, front } = startingImages(data, character);
  const start = photos.length ? photos : v.id !== "front" && front ? [front] : [];
  const model = `${REFERENCE_PLAN_MODEL.provider}/${REFERENCE_PLAN_MODEL.modelId}`;
  const { prepared, registry, req } = await prepareView(data, character, v.intent, start, model, userId, key);
  const m = registry.model(req.provider, req.modelId);
  return { view: v, prepared, paid: !!m && registry.billsMoney(m) };
}
