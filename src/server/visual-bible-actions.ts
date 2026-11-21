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

export async function setCanonicalIdentity(form: FormData): Promise<ActionResult> {
  return runAction(() => designate(form, "canonical", "canonical identity"), {
    name: "setCanonicalIdentity",
  });
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
    viewId === "half_body"
      ? refs.find((r) => r.slot === "additional" && (r.metadata as { view?: unknown }).view === "half_body")
      : refs.find((r) => r.slot === view.slot && visualRoleOf(r) === null);
  const canonicalRef = view.canonical ? refs.find((r) => visualRoleOf(r) === "canonical") : undefined;

  for (const r of [slotRef, canonicalRef]) {
    if (!holds(r) || r!.assetId === assetId) continue;
    if (r!.locked)
      throw new UserFacingError(
        `${character.name}'s ${view.label.toLowerCase()} is locked. Unlock the identity references first.`,
      );
    if (!confirmed)
      throw new UserFacingError(
        `${character.name} already has a ${view.label.toLowerCase()}. Confirm to replace it (the old image stays in the library).`,
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
      ...(viewId === "half_body" ? { view: "half_body" } : {}),
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
