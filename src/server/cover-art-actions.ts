"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { GenerationSubmitError } from "@/data/generation-repository";
import { COVER_CAST_MAX } from "@/domain/generation/cover-art";
import { MAX_SUBJECT_DIRECTION_CHARS, hasStoredImage } from "@/domain/generation/subject-image";
import { paidConfirmationRefusal } from "@/domain/generation/paid-confirmation";
import { prepareCoverArt } from "@/generation/cover-submission";
import { runAction, UserFacingError, type ActionResult } from "./action-result";
import { requireUser } from "./auth";
import { currentCover } from "./cover-art";
import { getGenerationConfig, getGenerationRepo, getRegistry } from "./generation";
import { getRepo, requireProjectFresh } from "./repo";

/**
 * Cover art (Cover art page, and Start from a prompt under "Describe it"): make a cover on the existing image pipeline,
 * at the price the creator confirmed, then choose which picture is the cover. The title is laid over it when shown.
 */
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const refresh = (slug: string) => revalidatePath(`/projects/${slug}`, "layout");
const NEEDS_0069 =
  "Cover art needs a one-time database update (migration 0069) that has not been applied yet.";

async function makeCoverArt_impl(form: FormData) {
  const slug = str(form, "projectSlug");
  const user = await requireUser();
  const data = await requireProjectFresh(slug);
  const [provider, ...rest] = str(form, "model").split("/");
  const registry = getRegistry();
  const key = str(form, "idempotencyKey");
  const prepared = prepareCoverArt({
    data,
    input: {
      direction: str(form, "direction").slice(0, MAX_SUBJECT_DIRECTION_CHARS),
      // who and where the creator chose (absent: Prism's choice of leads, no location)
      ...(form.has("castChosen")
        ? { castIds: form.getAll("cast").map(String).filter(Boolean).slice(0, COVER_CAST_MAX) }
        : {}),
      locationId: str(form, "locationId") || null,
    },
    registry,
    provider: provider ?? "",
    modelId: rest.join("/"),
    aspectRatio: str(form, "aspectRatio"),
    userId: user.kind === "supabase" ? user.id : null,
    idempotencyKey: key.length >= 8 ? `cover-${key}` : `cover-${randomUUID()}`,
    config: getGenerationConfig(),
  });
  if (!prepared.ok) throw new UserFacingError(prepared.reasons.slice(0, 3).join(" · "));
  // a paid picture is never started on a click that showed no price: the confirmed amount must cover the estimate
  const model = registry.model(provider ?? "", rest.join("/"));
  if (model && registry.billsMoney(model)) {
    const refusal = paidConfirmationRefusal(prepared.estimate.amount, str(form, "confirmedTotalUsd"));
    if (refusal) throw new UserFacingError(refusal);
  }
  try {
    await (await getGenerationRepo()).createSubjectImageAttempt(prepared.input);
  } catch (err) {
    if (err instanceof GenerationSubmitError || (err as { name?: string }).name === "GenerationSubmitError")
      throw new UserFacingError((err as Error).message);
    if ((err as { code?: string }).code === "42703") throw new UserFacingError(NEEDS_0069);
    throw err;
  }
  refresh(slug);
  return { ok: true as const, message: "Prism is making the cover…" };
}

/** Use one of the project's cover pictures as its cover (the one before stays in the list). */
async function setCover_impl(form: FormData) {
  const slug = str(form, "projectSlug");
  await requireUser();
  const data = await requireProjectFresh(slug);
  const asset = data.assets.find((a) => a.id === str(form, "assetId"));
  if (!asset || !hasStoredImage(asset))
    throw new UserFacingError("That picture is no longer in this project.");
  if (currentCover(data)?.id === asset.id)
    return { ok: true as const, message: "That is already the cover." };
  const at = new Date().toISOString();
  await (
    await getRepo()
  ).upsert(data.project.id, "assets", {
    ...asset,
    metadata: { ...asset.metadata, cover: { selectedAt: at } },
    updatedAt: at,
  });
  refresh(slug);
  return { ok: true as const, message: "Cover set." };
}

/** Stop a cover still being made (nothing is charged for what never reached the engine). */
async function stopCoverArt_impl(form: FormData) {
  const slug = str(form, "projectSlug");
  await requireUser();
  const data = await requireProjectFresh(slug);
  const generation = await getGenerationRepo();
  const v = await generation.getSubjectImageAttempt(str(form, "attemptId"));
  if (!v || v.attempt.projectId !== data.project.id || !v.attempt.projectCover || !v.job)
    throw new UserFacingError("That cover is no longer being made.");
  await generation.requestCancel(v.job.id, new Date().toISOString());
  refresh(slug);
  return { ok: true as const, message: "Stopping…" };
}

export async function makeCoverArt(form: FormData): Promise<ActionResult> {
  return runAction(() => makeCoverArt_impl(form), { name: "makeCoverArt" });
}

export async function setCover(form: FormData): Promise<ActionResult> {
  return runAction(() => setCover_impl(form), { name: "setCover" });
}

export async function stopCoverArt(form: FormData): Promise<ActionResult> {
  return runAction(() => stopCoverArt_impl(form), { name: "stopCoverArt" });
}
