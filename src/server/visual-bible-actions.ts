"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
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
