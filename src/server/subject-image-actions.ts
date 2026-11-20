"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { GenerationSubmitError, type SubjectAttemptView } from "@/data/generation-repository";
import { paidConfirmationRefusal } from "@/domain/generation/paid-confirmation";
import { hasStoredImage } from "@/domain/generation/subject-image";
import { IDENTITY_SLOTS, type ProjectData } from "@/domain/schemas";
import { HOSTED_MATTING_ENGINE, prepareBackgroundRemoval } from "@/generation/background-removal";
import { prepareSubjectImage } from "@/generation/subject-submission";
import { runAction, UserFacingError, type ActionResult } from "./action-result";
import { createLocationViewFromReference } from "./location-view-actions";
import { requireUser } from "./auth";
import { getGenerationConfig, getGenerationRepo, getRegistry } from "./generation";
import { readSubjectImageForm } from "./reference-request";
import { getRepo, requireProjectFresh } from "./repo";
import { subjectImageAssetIds } from "./subject-image-sources";

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
  const user = await requireUser();
  const data = await requireProjectFresh(slug);
  const req = await readSubjectImageForm(form, data);
  const clientKey = str(form, "idempotencyKey");
  const registry = getRegistry();
  const prepared = prepareSubjectImage({
    data,
    input: { subject: req.subject, direction: req.direction, sourceAssetIds: req.sourceAssetIds },
    registry,
    provider: req.provider,
    modelId: req.modelId,
    aspectRatio: req.aspectRatio,
    userId: user.kind === "supabase" ? user.id : null,
    idempotencyKey: clientKey.length >= 8 ? clientKey : `subject-${randomUUID()}`,
    config: getGenerationConfig(),
    edit: req.edit,
    options: req.options,
    composer: req.composer,
  });
  if (!prepared.ok) throw new UserFacingError(prepared.reasons.slice(0, 3).join(" · "));
  // A paid image is never started on a click that showed no price. The creator confirms the dollar amount they saw
  // (the Reference Studio's Generate button carries it); the server recomputes it and refuses a smaller confirmation.
  const model = registry.model(req.provider, req.modelId);
  if (model && registry.billsMoney(model)) {
    const refusal = paidConfirmationRefusal(prepared.estimate.amount, str(form, "confirmedTotalUsd"));
    if (refusal) throw new UserFacingError(refusal);
  }
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
  // A lock protects a reference IMAGE. A slot that only holds a placeholder record (no stored file) has nothing to
  // protect, so it can be filled; a slot that holds an image is replaced only by an explicit unlock-then-replace.
  const current = existing?.assetId ? data.assets.find((a) => a.id === existing.assetId) : undefined;
  const holdsImage = hasStoredImage(current);
  if (existing?.locked && holdsImage)
    throw new UserFacingError("That reference slot is locked. Unlock it before replacing its image.");
  // The Reference Studio never swaps a slot's image on one click: it asks for the replacement to be confirmed.
  if (
    holdsImage &&
    existing!.assetId !== assetId &&
    str(form, "guardReplace") === "1" &&
    str(form, "confirmReplace") !== "1"
  )
    throw new UserFacingError(
      `${character.name} already has a ${slot.replace("_", " ")} reference. Confirm to replace it (the old image stays in the library).`,
    );
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

/**
 * Phase 5B-I2: "Use as Location View". The generated image joins the Location's references (an explicit act, refused
 * while the Location is locked) and becomes a named Location View through the EXISTING 2G.3 action, unchanged.
 */
async function saveAsLocationView_impl(form: FormData): Promise<ActionResult> {
  const slug = str(form, "projectSlug");
  await requireUser();
  const data = await requireProjectFresh(slug);
  const location = data.locations.find((l) => l.id === str(form, "locationId"));
  if (!location) throw new UserFacingError("That location no longer exists.");
  if (location.locked)
    throw new UserFacingError("That location is locked. Unlock it before changing its references.");
  // Phase 5B-I5: a Location View is a named, recurring camera view: the creator names it explicitly
  if (!str(form, "lv_name"))
    throw new UserFacingError("Name the Location View (for example: Entrance → elevators).");
  const { assetId } = await generatedImage(data, str(form, "attemptId"), { locationId: location.id });
  if (!location.referenceAssetIds.includes(assetId)) {
    await (
      await getRepo()
    ).upsert(data.project.id, "locations", {
      ...location,
      referenceAssetIds: [...location.referenceAssetIds, assetId],
    });
  }
  const fd = new FormData();
  fd.set("projectSlug", slug);
  fd.set("locationId", location.id);
  fd.set("assetId", assetId);
  fd.set("lv_name", str(form, "lv_name"));
  fd.set("lv_kind", str(form, "lv_kind") || "establishing");
  const result = await createLocationViewFromReference(fd);
  refresh(slug);
  if (!result.ok) throw new UserFacingError(result.error);
  return result;
}

export async function saveAsLocationView(form: FormData): Promise<ActionResult> {
  return runAction(() => saveAsLocationView_impl(form), { name: "saveAsLocationView" });
}

/**
 * Phase 5B-I3: "Remove Background" for one of THIS Character's own images (a reference, a Look image or a generated
 * image). Queues a local, free background-removal job; the cutout is a NEW Asset and the source is never modified.
 * The result is promoted with the existing "Use as Character Reference" / "Use as Look" actions; nothing is replaced
 * automatically.
 */
async function removeBackground_impl(form: FormData) {
  const slug = str(form, "projectSlug");
  const user = await requireUser();
  const data = await requireProjectFresh(slug);
  const characterId = str(form, "subjectId");
  const sourceAssetId = str(form, "sourceAssetId");
  if (!data.characters.some((c) => c.id === characterId))
    throw new UserFacingError("That character no longer exists.");
  if (!sourceAssetId) throw new UserFacingError("Choose the image to cut out.");
  const own = await subjectImageAssetIds(data, { kind: "character", characterId });
  if (!own.has(sourceAssetId)) throw new UserFacingError("That image does not belong to this character.");
  // Phase 5B-I3b: the local engine is the default. The hosted engine runs ONLY on the creator's explicit High Quality
  // Removal, with the price they saw confirmed (the server recomputes it and refuses a mismatch).
  const hosted = str(form, "quality") === "high";
  const clientKey = str(form, "idempotencyKey");
  const prepared = prepareBackgroundRemoval({
    data,
    characterId,
    sourceAssetId,
    registry: getRegistry(),
    userId: user.kind === "supabase" ? user.id : null,
    idempotencyKey: clientKey.length >= 8 ? clientKey : `cutout-${randomUUID()}`,
    config: getGenerationConfig(),
    engine: hosted ? HOSTED_MATTING_ENGINE : undefined,
  });
  if (!prepared.ok) throw new UserFacingError(prepared.reasons.slice(0, 3).join(" · "));
  if (hosted) {
    const confirmed = Number(str(form, "confirmedTotalUsd"));
    const expected = prepared.estimate.amount;
    if (expected == null || !Number.isFinite(confirmed) || Math.abs(confirmed - expected) > 1e-9)
      throw new UserFacingError(
        `Confirm the price of High Quality Removal ($${expected ?? "?"}) to continue.`,
      );
  }
  try {
    await (await getGenerationRepo()).createSubjectImageAttempt(prepared.input);
  } catch (err) {
    if (err instanceof GenerationSubmitError) throw new UserFacingError(err.message);
    throw err;
  }
  refresh(slug);
}

export async function removeBackground(form: FormData): Promise<ActionResult> {
  return runAction(() => removeBackground_impl(form), { name: "removeBackground" });
}
