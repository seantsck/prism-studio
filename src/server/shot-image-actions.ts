"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { isProductionFrameAttempt } from "@/domain/generation/schemas";
import { hasStoredImage } from "@/domain/generation/subject-image";
import { storyboardFrameSchema } from "@/domain/schemas";
import { runAction, UserFacingError, type ActionResult } from "./action-result";
import { requireUser } from "./auth";
import { createCandidateSet } from "./candidate-actions";
import { getGenerationRepo } from "./generation";
import { getRepo, requireProjectFresh } from "./repo";

/**
 * Phase 5B-I1b: the Shot's simple image actions. They add NO new selection system:
 *   - Generate Image / Alternate Composition / Generate Storyboard each submit a ONE-model Production Frame candidate set
 *     through the existing `createCandidateSet` (same gates, spend confirmation, candidate page and "Use as Production
 *     Frame"). The Production Frame purpose already exempts the Storyboard rules and needs no 3D. Nothing replaces the
 *     current Storyboard or Production Frame.
 *   - Use as Storyboard Frame adds a NEW (unapproved) Storyboard frame version pointing at a generated still
 *     (`source = 'generated'`); existing frames and the generated Asset are never modified.
 */
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

const SHOT_IMAGE_KINDS = ["production_frame", "alternate_composition", "storyboard", "edit"] as const;
type ShotImageKind = (typeof SHOT_IMAGE_KINDS)[number];
const TITLE: Record<ShotImageKind, string> = {
  production_frame: "Production Frame candidate",
  alternate_composition: "Alternate composition",
  storyboard: "Storyboard frame",
  edit: "Edited still",
};
const PURPOSE: Record<ShotImageKind, string> = {
  production_frame: "A still candidate for this Shot's Production Frame.",
  alternate_composition: "Another composition of this Shot; the current frame is kept.",
  storyboard: "A generated still to use as a Storyboard frame.",
  edit: "An edit of one of this Shot's stills; the source image is kept unchanged.",
};

async function startShotImage_impl(form: FormData): Promise<ActionResult> {
  const kind = str(form, "kind") as ShotImageKind;
  if (!(SHOT_IMAGE_KINDS as readonly string[]).includes(kind))
    throw new UserFacingError("Choose what to generate.");
  // the human's model, posted as "provider/modelId"; never substituted
  const [provider = "", modelId = ""] = str(form, "model").split("/");
  if (!provider || !modelId) throw new UserFacingError("Choose an image model.");
  // Phase 5B-I2: Edit Image (a NEW still from one of this Shot's stills) and an explicit transparent background
  const edit =
    kind === "edit"
      ? { sourceAssetId: str(form, "sourceAssetId"), instruction: str(form, "instruction") }
      : null;
  if (edit && !edit.sourceAssetId) throw new UserFacingError("Choose the image to edit.");
  if (edit && !edit.instruction) throw new UserFacingError("Describe the edit.");
  const background = str(form, "transparent") === "1" ? "transparent" : null;
  const quality = str(form, "quality") || null;
  const fd = new FormData();
  fd.set("projectSlug", str(form, "projectSlug"));
  fd.set("shotId", str(form, "shotId"));
  fd.set(
    "selections",
    JSON.stringify([
      {
        provider,
        modelId,
        ...(quality ? { quality } : {}),
        ...(background ? { background } : {}),
        ...(edit ? { edit } : {}),
      },
    ]),
  );
  fd.set("generationPurpose", "production_frame");
  fd.set("title", TITLE[kind]);
  fd.set("purpose", PURPOSE[kind]);
  fd.set("ackAll", "1"); // the candidate page still discloses every input the chosen model will not use
  const confirmed = str(form, "confirmedTotalUsd");
  if (confirmed) fd.set("confirmedTotalUsd", confirmed); // paid models: the creator's explicit confirmation
  return createCandidateSet(fd);
}

export async function startShotImage(form: FormData): Promise<ActionResult> {
  return runAction(() => startShotImage_impl(form), { name: "startShotImage" });
}

async function saveAsStoryboardFrame_impl(form: FormData) {
  const slug = str(form, "projectSlug");
  await requireUser();
  const data = await requireProjectFresh(slug);
  const shotId = str(form, "shotId");
  if (!data.shots.some((s) => s.id === shotId)) throw new UserFacingError("That shot no longer exists.");
  const view = await (await getGenerationRepo()).getAttemptView(str(form, "attemptId"));
  const a = view?.attempt;
  if (!view || !a || a.projectId !== data.project.id || a.shotId !== shotId || !isProductionFrameAttempt(a))
    throw new UserFacingError("That generated image no longer exists.");
  if (a.status !== "succeeded") throw new UserFacingError("Only a finished image can be used.");
  const primary = view.outputs.find((o) => o.output.role === "primary") ?? view.outputs[0];
  const asset = primary ? data.assets.find((x) => x.id === primary.asset.id) : undefined;
  if (!hasStoredImage(asset)) throw new UserFacingError("That generated image has no stored file.");
  const version =
    data.frames.filter((f) => f.shotId === shotId).reduce((m, f) => Math.max(m, f.version), 0) + 1;
  const repo = await getRepo();
  await repo.upsert(
    data.project.id,
    "frames",
    storyboardFrameSchema.parse({
      id: randomUUID(),
      projectId: data.project.id,
      shotId,
      assetId: asset.id,
      version,
      source: "generated",
      notes: `From generated image (attempt ${a.attemptNumber}, ${a.model})`,
      approved: false,
      approvedFingerprint: null,
      approvedSnapshot: null,
      approvedAt: null,
      createdAt: new Date().toISOString(),
    }),
  );
  revalidatePath(`/projects/${slug}`, "layout");
}

export async function saveAsStoryboardFrame(form: FormData): Promise<ActionResult> {
  return runAction(() => saveAsStoryboardFrame_impl(form), { name: "saveAsStoryboardFrame" });
}
