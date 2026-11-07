"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { GenerationSubmitError, type SubjectAttemptView } from "@/data/generation-repository";
import {
  CHARACTER_IMAGE_INTENTS,
  hasStoredImage,
  LOCATION_IMAGE_INTENTS,
  type CharacterImageIntent,
  type LocationImageIntent,
} from "@/domain/generation/subject-image";
import { IDENTITY_SLOTS, type ProjectData } from "@/domain/schemas";
import { prepareSubjectImage } from "@/generation/subject-submission";
import { runAction, UserFacingError, type ActionResult } from "./action-result";
import { requireUser } from "./auth";
import { getGenerationConfig, getGenerationRepo, getRegistry } from "./generation";
import { getRepo, requireProjectFresh } from "./repo";

/**
 * Phase 5B-I1: Character / Location image generation on the EXISTING queue and worker, and the explicit acts that turn a
 * generated image into a reusable reference. Nothing is ever overwritten: a generated image is an immutable Asset with
 * its attempt's provenance; "use as …" only POINTS a reference at it. Provider credentials never live here (the worker
 * holds them); the human chooses the model; every refusal is a sentence the creator can act on.
 */
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const refresh = (slug: string) => revalidatePath(`/projects/${slug}`, "layout");

async function startSubjectImage_impl(form: FormData) {
  const slug = str(form, "projectSlug");
  const kind = str(form, "subjectKind");
  const subjectId = str(form, "subjectId");
  const intent = str(form, "intent");
  // the form posts the chosen model as "provider/modelId" (the human's choice; never substituted)
  const [provider = "", modelId = ""] = (
    str(form, "model") || `${str(form, "provider")}/${str(form, "modelId")}`
  ).split("/");
  if (!provider || !modelId) throw new UserFacingError("Choose an image model.");
  const user = await requireUser();
  const data = await requireProjectFresh(slug);
  let subject;
  if (kind === "character") {
    if (!(CHARACTER_IMAGE_INTENTS as readonly string[]).includes(intent))
      throw new UserFacingError("Choose what to generate for this character.");
    subject = {
      kind: "character" as const,
      characterId: subjectId,
      intent: intent as CharacterImageIntent,
      lookId: str(form, "lookId") || null,
    };
  } else if (kind === "location") {
    if (!(LOCATION_IMAGE_INTENTS as readonly string[]).includes(intent))
      throw new UserFacingError("Choose what to generate for this location.");
    subject = { kind: "location" as const, locationId: subjectId, intent: intent as LocationImageIntent };
  } else throw new UserFacingError("Nothing to generate an image for.");

  const clientKey = str(form, "idempotencyKey");
  const prepared = prepareSubjectImage({
    data,
    input: { subject, direction: str(form, "direction") },
    registry: getRegistry(),
    provider,
    modelId,
    aspectRatio: str(form, "aspectRatio") || null,
    userId: user.kind === "supabase" ? user.id : null,
    idempotencyKey: clientKey.length >= 8 ? clientKey : `subject-${randomUUID()}`,
    config: getGenerationConfig(),
  });
  if (!prepared.ok) throw new UserFacingError(prepared.reasons.slice(0, 3).join(" · "));
  try {
    await (await getGenerationRepo()).createSubjectImageAttempt(prepared.input);
  } catch (err) {
    if (err instanceof GenerationSubmitError) throw new UserFacingError(err.message);
    throw err;
  }
  refresh(slug);
}

export async function startSubjectImage(form: FormData): Promise<ActionResult> {
  return runAction(() => startSubjectImage_impl(form), { name: "startSubjectImage" });
}

/** The succeeded attempt's primary image, verified to belong to this project and this subject. */
async function generatedImage(
  data: ProjectData,
  attemptId: string,
  subject: { characterId?: string; locationId?: string },
): Promise<{ view: SubjectAttemptView; assetId: string }> {
  const view = await (await getGenerationRepo()).getSubjectImageAttempt(attemptId);
  const a = view?.attempt;
  const owned =
    !!a &&
    a.projectId === data.project.id &&
    (subject.characterId ? a.characterId === subject.characterId : a.locationId === subject.locationId);
  if (!view || !owned) throw new UserFacingError("That generated image no longer exists.");
  if (view.attempt.status !== "succeeded") throw new UserFacingError("Only a finished image can be used.");
  const primary = view.outputs.find((o) => o.output.role === "primary") ?? view.outputs[0];
  const asset = primary ? data.assets.find((x) => x.id === primary.asset.id) : undefined;
  if (!hasStoredImage(asset)) throw new UserFacingError("That generated image has no stored file.");
  return { view, assetId: asset.id };
}

async function saveAsCharacterReference_impl(form: FormData) {
  const slug = str(form, "projectSlug");
  await requireUser();
  const data = await requireProjectFresh(slug);
  const characterId = str(form, "characterId");
  const character = data.characters.find((c) => c.id === characterId);
  if (!character) throw new UserFacingError("That character no longer exists.");
  const slot = str(form, "slot") as (typeof IDENTITY_SLOTS)[number];
  if (!(IDENTITY_SLOTS as readonly string[]).includes(slot))
    throw new UserFacingError("Choose a reference slot.");
  const { assetId } = await generatedImage(data, str(form, "attemptId"), { characterId });
  const existing = data.identityRefs.find(
    (r) => r.characterId === characterId && r.slot === slot && slot !== "additional",
  );
  if (existing?.locked)
    throw new UserFacingError("That reference slot is locked. Unlock it before replacing its image.");
  const repo = await getRepo();
  await repo.upsert(data.project.id, "identityRefs", {
    id: existing?.id ?? randomUUID(),
    characterId,
    slot,
    assetId,
    label: str(form, "label") || slot.replace("_", " "),
    metadata: { source: "generated", attemptId: str(form, "attemptId") },
    locked: false,
  });
  refresh(slug);
}

export async function saveAsCharacterReference(form: FormData): Promise<ActionResult> {
  return runAction(() => saveAsCharacterReference_impl(form), { name: "saveAsCharacterReference" });
}

async function saveAsLookReference_impl(form: FormData) {
  const slug = str(form, "projectSlug");
  await requireUser();
  const data = await requireProjectFresh(slug);
  const look = data.looks.find((l) => l.id === str(form, "lookId"));
  if (!look) throw new UserFacingError("That Look no longer exists.");
  if (look.locked)
    throw new UserFacingError("That Look is locked. Unlock it before changing its references.");
  const { assetId } = await generatedImage(data, str(form, "attemptId"), { characterId: look.characterId });
  if (look.referenceAssetIds.includes(assetId)) return;
  const repo = await getRepo();
  await repo.upsert(data.project.id, "looks", {
    ...look,
    referenceAssetIds: [...look.referenceAssetIds, assetId],
  });
  refresh(slug);
}

export async function saveAsLookReference(form: FormData): Promise<ActionResult> {
  return runAction(() => saveAsLookReference_impl(form), { name: "saveAsLookReference" });
}

/**
 * Adds the generated image to the Location's references. A Location View is then created from it with the existing
 * "create Location View from reference" action (Phase 2G.3), unchanged.
 */
async function saveAsLocationReference_impl(form: FormData) {
  const slug = str(form, "projectSlug");
  await requireUser();
  const data = await requireProjectFresh(slug);
  const location = data.locations.find((l) => l.id === str(form, "locationId"));
  if (!location) throw new UserFacingError("That location no longer exists.");
  if (location.locked)
    throw new UserFacingError("That location is locked. Unlock it before changing its references.");
  const { assetId } = await generatedImage(data, str(form, "attemptId"), { locationId: location.id });
  if (location.referenceAssetIds.includes(assetId)) return;
  const repo = await getRepo();
  await repo.upsert(data.project.id, "locations", {
    ...location,
    referenceAssetIds: [...location.referenceAssetIds, assetId],
  });
  refresh(slug);
}

export async function saveAsLocationReference(form: FormData): Promise<ActionResult> {
  return runAction(() => saveAsLocationReference_impl(form), { name: "saveAsLocationReference" });
}
