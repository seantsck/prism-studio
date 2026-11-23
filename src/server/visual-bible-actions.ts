"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { isReferenceSetView, REFERENCE_SET_VIEWS } from "@/domain/generation/reference-studio";
import { hasStoredImage } from "@/domain/generation/subject-image";
import type { IdentityRef, ProjectData } from "@/domain/schemas";
import { normalizeExpression, visualRoleOf, type VisualRole } from "@/domain/visual-bible";
import { runAction, UserFacingError, type ActionResult } from "./action-result";
import { requireUser } from "./auth";
import { getGenerationRepo } from "./generation";
import { getRepo, requireProjectFresh } from "./repo";
import { subjectImageAssetIds } from "./subject-image-sources";

/**
 * Phase 5B-I4: the explicit Visual Bible designations. Each is a POINTER (an IdentityRef with a `visualRole`) to an
 * existing immutable Asset of THIS Character; nothing is copied and nothing is replaced unless the creator says so.
 * Generation never calls these.
 */
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const refresh = (slug: string) => revalidatePath(`/projects/${slug}`, "layout");

/** The chosen image: an Asset id, or a finished generated attempt of this Character (its primary output). */
async function resolveSource(data: ProjectData, characterId: string, form: FormData): Promise<string> {
  let assetId = str(form, "assetId");
  const attemptId = str(form, "attemptId");
  if (!assetId && attemptId) {
    const view = await (await getGenerationRepo()).getSubjectImageAttempt(attemptId);
    if (!view || view.attempt.characterId !== characterId || view.attempt.projectId !== data.project.id)
      throw new UserFacingError("That generated image no longer exists.");
    if (view.attempt.status !== "succeeded") throw new UserFacingError("Only a finished image can be used.");
    assetId = (view.outputs.find((o) => o.output.role === "primary") ?? view.outputs[0])?.asset.id ?? "";
  }
  if (!assetId) throw new UserFacingError("Choose an image.");
  const own = await subjectImageAssetIds(data, { kind: "character", characterId });
  if (!own.has(assetId)) throw new UserFacingError("That image does not belong to this character.");
  return assetId;
}

async function loadCharacter(form: FormData) {
  const slug = str(form, "projectSlug");
  await requireUser();
  const data = await requireProjectFresh(slug);
  const character = data.characters.find((c) => c.id === str(form, "characterId"));
  if (!character) throw new UserFacingError("That character no longer exists.");
  return { slug, data, character };
}

/** Set (or, only with explicit confirmation, replace) the single designation of `role` for this Character. */
async function designate(form: FormData, role: Exclude<VisualRole, "expression">, label: string) {
  const { slug, data, character } = await loadCharacter(form);
  const assetId = await resolveSource(data, character.id, form);
  if (role === "cutout") {
    // transparency is a fact read from the stored bytes at ingest (`hasAlpha`), never a claim from the form
    const asset = data.assets.find((a) => a.id === assetId)!;
    if ((asset.metadata as { hasAlpha?: unknown }).hasAlpha !== true || asset.mime !== "image/png")
      throw new UserFacingError("A cutout must be a transparent PNG. Remove the background first.");
  }
  const existing = data.identityRefs.find((r) => r.characterId === character.id && visualRoleOf(r) === role);
  if (existing?.assetId === assetId) return;
  if (existing && str(form, "confirmReplace") !== "1")
    throw new UserFacingError(
      `${character.name} already has a ${label}. Confirm to replace it (the old image stays in the library).`,
    );
  if (existing?.locked)
    throw new UserFacingError(`The ${label} is locked. Unlock the identity references before replacing it.`);
  const repo = await getRepo();
  const ref: IdentityRef = {
    id: existing?.id ?? randomUUID(),
    characterId: character.id,
    slot: "additional",
    assetId,
    label: `${label[0]!.toUpperCase()}${label.slice(1)}`,
    metadata: { visualRole: role, source: "visual_bible" },
    locked: false,
  };
  await repo.upsert(data.project.id, "identityRefs", ref);
  refresh(slug);
}

/**
 * The canonical identity IS the front view (the owner's rule, 2026-11-23): choosing a picture as the canonical puts it
 * in the front view of the reference set, and the front view is always the canonical. Replacing a front view that holds
 * another picture is still asked first.
 */
export async function setCanonicalIdentity(form: FormData): Promise<ActionResult> {
  form.set("view", "front");
  return runAction(() => addToReferenceSet_impl(form), { name: "setCanonicalIdentity" });
}

export async function setCharacterCutout(form: FormData): Promise<ActionResult> {
  return runAction(() => designate(form, "cutout", "cutout"), { name: "setCharacterCutout" });
}

async function addExpression_impl(form: FormData) {
  const { slug, data, character } = await loadCharacter(form);
  const expression = normalizeExpression(str(form, "expression"));
  if (!expression) throw new UserFacingError("Name the expression (for example: happy).");
  const assetId = await resolveSource(data, character.id, form);
  const same = data.identityRefs.find(
    (r) =>
      r.characterId === character.id &&
      visualRoleOf(r) === "expression" &&
      r.assetId === assetId &&
      (r.metadata as { expression?: string }).expression === expression,
  );
  if (same) return;
  await (
    await getRepo()
  ).upsert(data.project.id, "identityRefs", {
    id: randomUUID(),
    characterId: character.id,
    slot: "additional",
    assetId,
    label: `Expression: ${expression}`,
    metadata: { visualRole: "expression", expression, source: "visual_bible" },
    locked: false,
  });
  refresh(slug);
}

export async function addExpressionReference(form: FormData): Promise<ActionResult> {
  return runAction(() => addExpression_impl(form), { name: "addExpressionReference" });
}

/** Removes ONE designation (the pointer only); the image stays in the library under the normal deletion rules. */
async function clearDesignation_impl(form: FormData) {
  const { slug, data, character } = await loadCharacter(form);
  const ref = data.identityRefs.find((r) => r.id === str(form, "refId") && r.characterId === character.id);
  if (!ref || !visualRoleOf(ref)) throw new UserFacingError("That designation no longer exists.");
  if (ref.locked)
    throw new UserFacingError("That designation is locked. Unlock the identity references first.");
  await (await getRepo()).remove(data.project.id, "identityRefs", ref.id);
  refresh(slug);
}

export async function clearVisualBibleDesignation(form: FormData): Promise<ActionResult> {
  return runAction(() => clearDesignation_impl(form), { name: "clearVisualBibleDesignation" });
}

/**
 * The Reference Studio's one act for a Character's reference set: put a picture (a finished take, or one of the
 * creator's own photos of this Character) into one view. The front view is the canonical identity, so it sets both.
 * A view that already holds a DIFFERENT image is replaced only with `confirmReplace=1` (the old image stays in the
 * library); a locked slot that holds an image is never replaced here.
 */
async function addToReferenceSet_impl(form: FormData) {
  const { slug, data, character } = await loadCharacter(form);
  const viewId = str(form, "view");
  if (!isReferenceSetView(viewId)) throw new UserFacingError("Choose a view.");
  const view = REFERENCE_SET_VIEWS.find((v) => v.id === viewId)!;
  const assetId = await resolveSource(data, character.id, form);
  const confirmed = str(form, "confirmReplace") === "1";
  const refs = data.identityRefs.filter((r) => r.characterId === character.id);
  const holds = (r: IdentityRef | undefined) =>
    !!r?.assetId && hasStoredImage(data.assets.find((a) => a.id === r.assetId));
  const slotRef =
    view.slot === "additional"
      ? refs.find((r) => r.slot === "additional" && (r.metadata as { view?: unknown }).view === viewId)
      : refs.find((r) => r.slot === view.slot && visualRoleOf(r) === null);
  // the front view is always the canonical identity: setting one sets the other
  const canonicalRef = view.canonical ? refs.find((r) => visualRoleOf(r) === "canonical") : undefined;

  for (const r of [slotRef, canonicalRef]) {
    if (!holds(r) || r!.assetId === assetId) continue;
    if (r!.locked)
      throw new UserFacingError(
        `${character.name}'s ${view.label.toLowerCase()} is locked. Unlock the identity references first.`,
      );
    // the canonical simply follows the front view; replacing a picture IN the view is asked first
    if (r === slotRef && !confirmed)
      throw new UserFacingError(
        `${character.name} already has a ${view.id === "front" ? "front view (the canonical identity)" : view.label.toLowerCase()}. Confirm to replace it (the old image stays in the library).`,
      );
  }

  const repo = await getRepo();
  const source = str(form, "attemptId") ? "generated" : "photo";
  await repo.upsert(data.project.id, "identityRefs", {
    id: slotRef?.id ?? randomUUID(),
    characterId: character.id,
    slot: view.slot,
    assetId,
    label: view.label,
    metadata: {
      ...(view.slot === "additional" ? { view: viewId } : {}),
      source,
      ...(str(form, "attemptId") ? { attemptId: str(form, "attemptId") } : {}),
    },
    locked: false,
  });
  if (view.canonical && canonicalRef?.assetId !== assetId)
    await repo.upsert(data.project.id, "identityRefs", {
      id: canonicalRef?.id ?? randomUUID(),
      characterId: character.id,
      slot: "additional",
      assetId,
      label: "Canonical identity",
      metadata: { visualRole: "canonical", source: "visual_bible" },
      locked: false,
    });
  refresh(slug);
}

export async function addToReferenceSet(form: FormData): Promise<ActionResult> {
  return runAction(() => addToReferenceSet_impl(form), { name: "addToReferenceSet" });
}

/**
 * Add several finished views to the reference set at once (the views made on a Character's page): each is added
 * exactly as "Add to the set" adds it, one after another, so the front view also becomes the canonical identity. A view
 * that would replace a different picture is skipped with the reason (replacing is confirmed one by one, never in bulk).
 */
async function addViewsToReferenceSet_impl(form: FormData) {
  const pairs = form
    .getAll("viewTake")
    .map(String)
    .map((x) => x.split(":"))
    .filter((p): p is [string, string] => p.length === 2 && !!p[0] && !!p[1]);
  if (pairs.length === 0) throw new UserFacingError("There is no finished view to add.");
  const added: string[] = [];
  const skipped: string[] = [];
  for (const [view, attemptId] of pairs) {
    const one = new FormData();
    one.set("projectSlug", str(form, "projectSlug"));
    one.set("characterId", str(form, "characterId"));
    one.set("view", view);
    one.set("attemptId", attemptId);
    const label = REFERENCE_SET_VIEWS.find((v) => v.id === view)?.label ?? view;
    try {
      await addToReferenceSet_impl(one);
      added.push(label);
    } catch (err) {
      if (!(err instanceof UserFacingError)) throw err;
      skipped.push(`${label}: ${err.message}`);
    }
  }
  if (added.length === 0) throw new UserFacingError(`Nothing was added. ${skipped.join(" ")}`);
  return {
    ok: true as const,
    message:
      `Added ${added.length === 1 ? `the ${added[0]!.toLowerCase()}` : `${added.length} views`} to the set.` +
      (skipped.length ? ` Not added: ${skipped.join(" ")}` : ""),
  };
}

export async function addViewsToReferenceSet(form: FormData): Promise<ActionResult> {
  return runAction(() => addViewsToReferenceSet_impl(form), { name: "addViewsToReferenceSet" });
}

/**
 * Lock (or unlock) one view of the reference set: a locked view keeps its picture (it is not made again, no new take or
 * upload replaces it). Locking the front view also locks the canonical identity, which is the same picture.
 */
async function setViewLocked_impl(form: FormData) {
  const { slug, data, character } = await loadCharacter(form);
  const viewId = str(form, "view");
  if (!isReferenceSetView(viewId)) throw new UserFacingError("Choose a view.");
  const view = REFERENCE_SET_VIEWS.find((v) => v.id === viewId)!;
  const locked = str(form, "locked") === "true";
  const refs = data.identityRefs.filter((r) => r.characterId === character.id);
  const slotRef =
    view.slot === "additional"
      ? refs.find((r) => r.slot === "additional" && (r.metadata as { view?: unknown }).view === viewId)
      : refs.find((r) => r.slot === view.slot && visualRoleOf(r) === null);
  if (!slotRef?.assetId) throw new UserFacingError(`There is no ${view.label.toLowerCase()} to lock yet.`);
  const repo = await getRepo();
  await repo.upsert(data.project.id, "identityRefs", { ...slotRef, locked });
  if (view.canonical) {
    const canonical = refs.find((r) => visualRoleOf(r) === "canonical");
    if (canonical) await repo.upsert(data.project.id, "identityRefs", { ...canonical, locked });
  }
  refresh(slug);
}

export async function setViewLocked(form: FormData): Promise<ActionResult> {
  return runAction(() => setViewLocked_impl(form), { name: "setViewLocked" });
}

/**
 * The Production checklist's "Approve": lock a Character's reference images and the Looks an Episode uses, in one act.
 * Locked references are what every Shot is made from; they are unlocked on the Character page.
 */
async function approveCharacter_impl(form: FormData) {
  const { slug, data, character } = await loadCharacter(form);
  const repo = await getRepo();
  const withImage = data.identityRefs.filter(
    (r) =>
      r.characterId === character.id &&
      !!r.assetId &&
      hasStoredImage(data.assets.find((a) => a.id === r.assetId)),
  );
  if (withImage.length === 0)
    throw new UserFacingError(`${character.name} has no reference image to approve yet.`);
  for (const r of withImage)
    if (!r.locked) await repo.upsert(data.project.id, "identityRefs", { ...r, locked: true });
  const lookIds = new Set(form.getAll("lookId").map(String));
  for (const l of data.looks)
    if (l.characterId === character.id && lookIds.has(l.id) && !l.locked)
      await repo.upsert(data.project.id, "looks", { ...l, locked: true });
  refresh(slug);
}

export async function approveCharacter(form: FormData): Promise<ActionResult> {
  return runAction(() => approveCharacter_impl(form), { name: "approveCharacter" });
}

/** How long a written appearance may be (it is part of every prompt made from words). */
const MAX_APPEARANCE = 1200;

/**
 * Saves a Character's written appearance from the Reference Studio. For a fictional Character it is all a first
 * picture is made from; once there are pictures, the prompt says the pictures win where they differ.
 */
async function saveCharacterAppearance_impl(form: FormData) {
  const { slug, data, character } = await loadCharacter(form);
  const appearance = String(form.get("appearance") ?? "").trim();
  if (!appearance) throw new UserFacingError("Describe how they look first.");
  if (appearance.length > MAX_APPEARANCE)
    throw new UserFacingError(
      `Keep it under ${MAX_APPEARANCE} characters: the essentials of the face and build.`,
    );
  await (
    await getRepo()
  ).upsert(data.project.id, "characters", { ...character, physicalDescription: appearance });
  refresh(slug);
}

export async function saveCharacterAppearance(form: FormData): Promise<ActionResult> {
  return runAction(() => saveCharacterAppearance_impl(form), { name: "saveCharacterAppearance" });
}
