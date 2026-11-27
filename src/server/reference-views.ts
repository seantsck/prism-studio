import "server-only";
import { isFromActor } from "@/domain/character-library";
import {
  CHARACTER_PRESETS,
  preferredFormat,
  REFERENCE_SET_VIEWS,
} from "@/domain/generation/reference-studio";
import { REFERENCE_PHOTOS_BEST, REFERENCE_PLAN_MODEL } from "@/domain/generation/reference-plan";
import { referenceOrigin } from "@/domain/generation/reference-integrity";
import { isOffered } from "@/domain/generation/models/offered";
import type { Character, ProjectData } from "@/domain/schemas";
import { prepareSubjectImage } from "@/generation/subject-submission";
import type { GenerationRequest } from "@/domain/generation/schemas";
import { UserFacingError } from "./action-result";
import { getGenerationConfig, getRegistry } from "./generation";
import { readSubjectImageForm } from "./reference-request";
import { subjectImageAssetIds } from "./subject-image-sources";

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
  /** an animated Character starting from the real Character's photos: that Character's name (null otherwise) */
  likenessFrom: string | null;
  /** the art style the views are drawn in (empty: as photographs) */
  artStyle: string;
  views: ViewQuote[];
  /** the views still to make, and their total (Prism's cost; null when any is unknown) */
  missing: string[];
  totalUsd: number | null;
}

/**
 * The creator's own photos of this Character, then the front view; only pictures that are really stored and are this
 * Character's own (what a generation may start from), so a slot holding a placeholder is never sent.
 */
async function startingImages(
  data: ProjectData,
  character: Character,
): Promise<{ photos: string[]; front: string | null; from: string | null }> {
  const mine = await ownStartingImages(data, character);
  if (mine.photos.length || mine.front) return { ...mine, from: null };
  // an animated Character made from a real one, with no pictures of its own yet: the real one's photos show who it is
  // (or its front view when it has no photos)
  const source = character.likenessFromId
    ? data.characters.find((c) => c.id === character.likenessFromId && !c.trashedAt)
    : undefined;
  if (!source) return { ...mine, from: null };
  const theirs = await ownStartingImages(data, source);
  const photos = theirs.photos.length ? theirs.photos : theirs.front ? [theirs.front] : [];
  return { photos, front: null, from: photos.length ? source.name : null };
}

async function ownStartingImages(data: ProjectData, character: Character) {
  const own = await subjectImageAssetIds(
    data,
    { kind: "character", characterId: character.id },
    { startInlineWorker: false },
  );
  const assets = new Map(data.assets.map((a) => [a.id, a]));
  const refs = data.identityRefs.filter(
    (r) => r.characterId === character.id && r.assetId && own.has(r.assetId),
  );
  const photos = [
    ...new Set(
      refs
        // the creator's photos, and the pictures the Actor playing this Character lent it (its face)
        .filter((r) => referenceOrigin(assets.get(r.assetId!)) === "uploaded" || isFromActor(r))
        .map((r) => r.assetId!),
    ),
  ].slice(0, REFERENCE_PHOTOS_BEST[1]);
  const front = refs.find((r) => r.slot === "front")?.assetId ?? null;
  return { photos, front };
}

/**
 * The price of a request with `extra` more reference pictures than it has now (pictures that do not exist yet), and a
 * generous allowance for the words that come with them: an upper bound, so what is confirmed always covers what is
 * charged. Engines priced per picture regardless of references come out the same.
 */
function upperBound(
  request: Record<string, unknown>,
  extra: number,
  model: NonNullable<ReturnType<typeof modelOf>>,
) {
  const adapter = getRegistry().adapter(model.provider);
  if (!adapter) return null;
  const r = request as unknown as GenerationRequest;
  const refs = r.references ?? [];
  const padded = {
    ...r,
    modality: "image_to_image",
    references: [
      ...refs,
      ...Array.from({ length: extra }, (_, i) => ({ ...(refs[0] ?? {}), assetId: `not-yet-${i}` })),
    ],
    prompt: { ...r.prompt, positive: `${r.prompt.positive}\n${"x".repeat(1_500)}` },
  } as GenerationRequest;
  return adapter.estimateCost(padded, model).amount;
}

/** What the right profile is told when it is sent the left profile. */
export const RIGHT_FROM_LEFT =
  "Make the right profile the mirror image of the left profile reference picture: the same pose, head angle, height in the frame, crop, lighting, clothing and expression, with the person facing the RIGHT edge of the picture instead.";

/** The left profile in the reference set (a stored picture of this Character), or null. */
async function leftProfileOf(data: ProjectData, character: Character): Promise<string | null> {
  const own = await subjectImageAssetIds(
    data,
    { kind: "character", characterId: character.id },
    { startInlineWorker: false },
  );
  const ref = data.identityRefs.find(
    (r) => r.characterId === character.id && r.slot === "profile" && !!r.assetId && own.has(r.assetId),
  );
  return ref?.assetId ?? null;
}

/** True when the creator has their own photos of this Character (every view is then made from them). */
export async function hasOwnPhotos(data: ProjectData, character: Character): Promise<boolean> {
  return (await startingImages(data, character)).photos.length > 0;
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
  direction = "",
) {
  const f = new FormData();
  if (direction) f.set("direction", direction);
  f.set("subjectKind", "character");
  f.set("subjectId", character.id);
  f.set("intent", intent);
  f.set("model", model);
  f.set("sources", "chosen");
  for (const id of startAssetIds) f.append("startAssetId", id);
  // a view is a tall picture (a full body must fit head to shoes): the preset's preferred shape the engine offers,
  // never the engine's own first one (which can be a wide 21:9)
  const ratio = preferredFormat(
    CHARACTER_PRESETS.find((p) => p.intent === intent)?.ratios ?? ["2:3", "3:4", "9:16", "1:1"],
    modelOf(model)?.capabilities.image?.aspectRatios ?? [],
  );
  if (ratio) f.set("aspectRatio", ratio);
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

/** The model Prism suggests for reference views, as "provider/modelId". */
export const SUGGESTED_VIEWS_MODEL = `${REFERENCE_PLAN_MODEL.provider}/${REFERENCE_PLAN_MODEL.modelId}`;

/** "provider/modelId" → the registry's model (null when it is not a model of this deployment). */
function modelOf(model: string) {
  const at = model.indexOf("/");
  if (at <= 0 || !isOffered(model.slice(0, at), model.slice(at + 1))) return null;
  return getRegistry().model(model.slice(0, at), model.slice(at + 1)) ?? null;
}

export async function quoteReferenceViews(
  data: ProjectData,
  character: Character,
  done: ReadonlySet<string>,
  userId: string | null,
  /** the engine the creator chose ("provider/modelId"); Prism's suggestion when not given */
  model: string = SUGGESTED_VIEWS_MODEL,
): Promise<ViewsQuote> {
  const registry = getRegistry();
  const m = modelOf(model);
  const { photos, front, from } = await startingImages(data, character);
  const left = await leftProfileOf(data, character);
  const views: ViewQuote[] = [];
  for (const v of REFERENCE_SET_VIEWS) {
    try {
      // priced exactly as it is made (the same preparation); a picture it will be sent that does not exist yet (the
      // front view it is made from, the left profile the right one mirrors) is priced as an upper bound
      const { prepared } = await prepareReferenceView(data, character, v.id, userId, "quote-only", model);
      const notYet =
        (!photos.length && !front && v.id !== "front" ? 1 : 0) + (v.id === "right_profile" && !left ? 1 : 0);
      const cost = prepared.ok
        ? m && registry.billsMoney(m)
          ? notYet
            ? upperBound(prepared.input.attempt.request ?? {}, notYet, m)
            : prepared.estimate.amount
          : 0
        : null;
      views.push({
        id: v.id,
        label: v.label,
        intent: v.intent,
        costUsd: cost,
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
    likenessFrom: from,
    artStyle: (character.artStyle ?? "").trim(),
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
  model: string = SUGGESTED_VIEWS_MODEL,
  /** made together with a new front view: start from that front picture (this Character's own take) */
  fromFrontAssetId: string | null = null,
  /** for the right profile: the left profile picture it mirrors (made in the same run, or in the set) */
  fromLeftAssetId: string | null = null,
) {
  const v = REFERENCE_SET_VIEWS.find((x) => x.id === viewId);
  if (!v) throw new UserFacingError("Choose one of the reference views.");
  if (!modelOf(model)) throw new UserFacingError("Choose an engine for the views.");
  const { photos, front } = await startingImages(data, character);
  const start = photos.length
    ? photos
    : v.id === "front"
      ? []
      : fromFrontAssetId
        ? [fromFrontAssetId]
        : front
          ? [front]
          : [];
  // the right profile mirrors the left one: it is sent the left profile too, and told to match it, so the two are a pair
  const left = v.id === "right_profile" ? (fromLeftAssetId ?? (await leftProfileOf(data, character))) : null;
  const { prepared, registry, req } = await prepareView(
    data,
    character,
    v.intent,
    left ? [...start, left] : start,
    model,
    userId,
    key,
    left ? RIGHT_FROM_LEFT : "",
  );
  const m = registry.model(req.provider, req.modelId);
  return { view: v, prepared, paid: !!m && registry.billsMoney(m) };
}
