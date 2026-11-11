"use server";

import { revalidatePath } from "next/cache";
import { shotSchema } from "@/domain/schemas";
import { clipDurationChoices } from "@/domain/generation/video-inputs";
import { runAction, UserFacingError, type ActionResult } from "./action-result";
import { getRegistry } from "./generation";
import { getRepo, requireProjectFresh } from "./repo";

/**
 * Phase 5B-V1: the Shot clip's duration, chosen from what the available image-to-video models actually support. It is
 * the Shot's own target duration (the existing field every package, compatibility check, estimate and adaptation plan
 * already read): no parallel duration, no rounding, no stitched "long" clip. Changing it is a real input change, so
 * clips made at another duration report themselves stale (their history is kept).
 */
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

async function setClipDuration_impl(form: FormData): Promise<ActionResult> {
  const slug = str(form, "projectSlug");
  const data = await requireProjectFresh(slug);
  const shot = data.shots.find((s) => s.id === str(form, "shotId"));
  if (!shot) throw new UserFacingError("That Shot no longer exists.");
  const ms = Number(str(form, "durationMs"));
  const choices = clipDurationChoices(getRegistry().usable());
  if (!Number.isInteger(ms) || !choices.includes(ms))
    throw new UserFacingError(
      `Choose a duration an available video model supports (${choices.map((c) => `${c / 1000}s`).join(", ") || "none available"}).`,
    );
  await (
    await getRepo()
  ).upsert(
    data.project.id,
    "shots",
    shotSchema.parse({
      ...shot,
      targetDurationMs: ms,
      durationMode: "manual",
      updatedAt: new Date().toISOString(),
    }),
  );
  revalidatePath(`/projects/${slug}`, "layout");
  return { ok: true, message: `Clip duration set to ${ms / 1000} seconds.` };
}

export async function setShotClipDuration(form: FormData): Promise<ActionResult> {
  return runAction(() => setClipDuration_impl(form), { name: "setShotClipDuration" });
}

/**
 * Phase 5B-V1 Generate Alternative: another clip of the SAME Shot from the SAME canonical Production Frame (the 2H
 * candidate-set flow re-reads and enforces it), same model, with the creator's optional motion note. It is a new
 * candidate; the selected Shot Clip never changes until the creator chooses Use as Shot Clip.
 */
async function alternative_impl(form: FormData) {
  const slug = str(form, "projectSlug");
  const data = await requireProjectFresh(slug);
  const base = data.attempts.find((a) => a.id === str(form, "attemptId"));
  if (!base || !base.shotId) throw new UserFacingError("That clip is not in this project.");
  const note = str(form, "motionNote").slice(0, 500);
  const f = new FormData();
  f.set("projectSlug", slug);
  f.set("shotId", base.shotId);
  f.set("generationPurpose", "animate_production_frame");
  f.set("title", `Alternative of ${base.provider}/${base.model}${note ? ` — ${note.slice(0, 60)}` : ""}`);
  f.set(
    "selections",
    JSON.stringify([
      {
        provider: base.provider,
        modelId: base.model,
        ...(note ? { direction: { kind: "motion", text: note } } : {}),
      },
    ]),
  );
  const confirmed = str(form, "confirmedTotalUsd");
  if (confirmed) f.set("confirmedTotalUsd", confirmed);
  const { createCandidateSet } = await import("./candidate-actions");
  return createCandidateSet(f);
}

export async function generateClipAlternative(form: FormData): Promise<ActionResult> {
  // an ignored-feature acknowledgement is never assumed: such a model is refused here with the reason
  return runAction(() => alternative_impl(form), { name: "generateClipAlternative" });
}
