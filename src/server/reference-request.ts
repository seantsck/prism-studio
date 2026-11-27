import "server-only";
import {
  CHARACTER_IMAGE_INTENTS,
  LOCATION_IMAGE_INTENTS,
  type CharacterImageIntent,
  type ImageSubject,
  type LocationImageIntent,
} from "@/domain/generation/subject-image";
import { editInstruction, presetDirection, referencePreset } from "@/domain/generation/reference-studio";
import type { ProjectData } from "@/domain/schemas";
import type { ImageSubjectRef } from "@/data/generation-repository";
import { UserFacingError } from "./action-result";
import { subjectImageAssetIds } from "./subject-image-sources";

/**
 * One reading of the "make an image of this Character / Location" form, shared by the submission and by the price
 * quote, so the price a creator confirms is the price of exactly the request that is then queued.
 *
 * A plain server module (not "use server"): it exposes no callable action.
 */
export interface SubjectImageFormRequest {
  subject: ImageSubject;
  subjectRef: ImageSubjectRef;
  direction: string;
  /**
   * The images the creator chose to start from, in order (a generation; never together with `edit`). An empty list is
   * a choice too ("from the written description"); undefined leaves the selection to Prism (the older panels).
   */
  sourceAssetIds: string[] | undefined;
  /** Change one image instead of making a new picture. */
  edit?: { sourceAssetId: string; instruction: string };
  provider: string;
  modelId: string;
  /** null = the model's first offered format */
  aspectRatio: string | null;
  options?: { background?: "transparent"; quality?: string };
  /** The creator's raw inputs (kept with the attempt so the request can be loaded back into the composer). */
  composer: Record<string, string>;
}

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const all = (f: FormData, k: string) =>
  f
    .getAll(k)
    .map((v) => String(v ?? "").trim())
    .filter(Boolean);

/** Phase 5B-I5: a Time-of-Day Variant names its time / state ("night"); it leads the creator's own direction. */
function legacyVariantDirection(form: FormData, intent: string, direction: string): string {
  const variant = str(form, "variant").slice(0, 60);
  if (intent !== "time_variant" || !variant) return direction;
  return [`Time of day / state: ${variant}.`, direction].filter(Boolean).join(" ");
}

export async function readSubjectImageForm(
  form: FormData,
  data: ProjectData,
  opts: { startInlineWorker?: boolean } = {},
): Promise<SubjectImageFormRequest> {
  const kind = str(form, "subjectKind");
  const subjectId = str(form, "subjectId");
  const intent = str(form, "intent");
  // the form posts the chosen model as "provider/modelId" (the human's choice; never substituted)
  const [provider = "", modelId = ""] = (
    str(form, "model") || `${str(form, "provider")}/${str(form, "modelId")}`
  ).split("/");
  if (!provider || !modelId) throw new UserFacingError("Choose an image model.");
  let subject: ImageSubject;
  let subjectRef: ImageSubjectRef;
  if (kind === "character") {
    if (!(CHARACTER_IMAGE_INTENTS as readonly string[]).includes(intent))
      throw new UserFacingError("Choose what to generate for this actor.");
    subject = {
      kind: "character",
      characterId: subjectId,
      intent: intent as CharacterImageIntent,
      lookId: str(form, "lookId") || null,
    };
    subjectRef = { kind: "character", characterId: subjectId };
  } else if (kind === "location") {
    if (!(LOCATION_IMAGE_INTENTS as readonly string[]).includes(intent))
      throw new UserFacingError("Choose what to generate for this location.");
    subject = { kind: "location", locationId: subjectId, intent: intent as LocationImageIntent };
    subjectRef = { kind: "location", locationId: subjectId };
  } else throw new UserFacingError("Nothing to generate an image for.");

  // Edit Image starts only from one of THIS subject's own images (its references or generated images); so does a
  // generation that starts from chosen images.
  const editSourceId = str(form, "sourceAssetId");
  const startIds = [...new Set(all(form, "startAssetId"))];
  if (editSourceId && startIds.length > 0)
    throw new UserFacingError("Choose either an image to change or images to start from, not both.");
  if (editSourceId || startIds.length > 0) {
    const own = await subjectImageAssetIds(data, subjectRef, opts);
    // an animated Character may start from the photos of the real Character it takes its likeness from
    const source =
      subjectRef.kind === "character"
        ? data.characters.find((c) => c.id === subjectRef.characterId)?.likenessFromId
        : null;
    const theirs = source
      ? await subjectImageAssetIds(data, { kind: "character", characterId: source }, opts)
      : new Set<string>();
    for (const id of startIds)
      if (!own.has(id) && !theirs.has(id))
        throw new UserFacingError("That image does not belong to this subject.");
    if (editSourceId && !own.has(editSourceId))
      throw new UserFacingError("That image does not belong to this subject.");
  }

  let edit: SubjectImageFormRequest["edit"];
  if (editSourceId) {
    const presetId = str(form, "editPreset");
    let instruction = str(form, "instruction");
    if (presetId) {
      // a wardrobe change may name one of the Character's Looks: its description and images ride on the request
      const lookId = subject.kind === "character" ? (subject.lookId ?? null) : null;
      const look =
        presetId === "wardrobe" && lookId
          ? (data.looks.find((l) => l.id === lookId && l.characterId === subjectId) ?? null)
          : null;
      const built = editInstruction(presetId, str(form, "editValue"), look);
      if (!built.ok) throw new UserFacingError(built.reason);
      instruction = built.instruction;
      // only a wardrobe change applies a Look; any other edit keeps the picture's own clothing
      if (presetId !== "wardrobe" && subject.kind === "character") subject = { ...subject, lookId: null };
    }
    edit = { sourceAssetId: editSourceId, instruction };
  }

  const typed = str(form, "direction");
  const preset = referencePreset(subject.kind, intent);
  // the Studio posts `presetValue`; a preset that is ABOUT that value (an expression, a time, a scene) needs it
  if (!edit && form.has("presetValue") && preset?.param && !str(form, "presetValue") && !typed)
    throw new UserFacingError(`${preset.param.label}: say what it should be.`);
  const direction = edit
    ? typed
    : legacyVariantDirection(form, intent, presetDirection(preset, str(form, "presetValue"), typed));
  const background = str(form, "transparent") === "1" ? ("transparent" as const) : undefined;
  const quality = str(form, "quality") || undefined;
  const composer: Record<string, string> = {};
  for (const k of ["presetValue", "direction", "editPreset", "editValue"] as const) {
    const v = str(form, k).slice(0, 2_000);
    if (v) composer[k] = v;
  }
  return {
    subject,
    subjectRef,
    direction,
    // the Studio states its choice (`sources=chosen`), even when that choice is "no image"
    sourceAssetIds: edit
      ? undefined
      : str(form, "sources") === "chosen" || startIds.length > 0
        ? startIds
        : undefined,
    edit,
    provider,
    modelId,
    aspectRatio: str(form, "aspectRatio") || null,
    options: background || quality ? { background, quality } : undefined,
    composer,
  };
}
