"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { GenerationSubmitError } from "@/data/generation-repository";
import { coverDesignOf } from "@/domain/cover-design";
import { COVER_CAST_MAX } from "@/domain/generation/cover-art";
import { MAX_SUBJECT_DIRECTION_CHARS, hasStoredImage } from "@/domain/generation/subject-image";
import { paidConfirmationRefusal } from "@/domain/generation/paid-confirmation";
import { prepareCoverArt } from "@/generation/cover-submission";
import { runAction, UserFacingError, type ActionResult } from "./action-result";
import { requireUser } from "./auth";
import { coverEditSource, coverSnapshotOf, currentCover } from "./cover-art";
import { MAX_EDIT_INSTRUCTION_CHARS } from "@/domain/generation/image-edit";
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

/**
 * Edit a cover picture: the creator says what to change, and the engine redraws THAT picture with the change (same cast
 * and shape). Priced and confirmed like a new cover; the result is a new take, the picture edited is never changed.
 */
async function editCoverArt_impl(form: FormData) {
  const slug = str(form, "projectSlug");
  const user = await requireUser();
  const data = await requireProjectFresh(slug);
  const source = await coverEditSource(data, str(form, "sourceAssetId"));
  if (!source) throw new UserFacingError("That cover picture can no longer be edited.");
  const [provider, ...rest] = str(form, "model").split("/");
  const registry = getRegistry();
  const key = str(form, "idempotencyKey");
  const prepared = prepareCoverArt({
    data,
    input: { direction: "", castIds: source.castIds, locationId: source.locationId },
    registry,
    provider: provider ?? "",
    modelId: rest.join("/"),
    aspectRatio: source.aspectRatio,
    userId: user.kind === "supabase" ? user.id : null,
    idempotencyKey: key.length >= 8 ? `cover-edit-${key}` : `cover-edit-${randomUUID()}`,
    config: getGenerationConfig(),
    edit: {
      sourceAssetId: source.assetId,
      instruction: str(form, "instruction").slice(0, MAX_EDIT_INSTRUCTION_CHARS),
    },
  });
  if (!prepared.ok) throw new UserFacingError(prepared.reasons.slice(0, 3).join(" · "));
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
    throw err;
  }
  refresh(slug);
  return { ok: true as const, message: "Prism is editing the cover…" };
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
  // the title design carries over to the new cover
  const before = currentCover(data);
  const design = (before?.metadata as { cover?: { design?: unknown } } | undefined)?.cover?.design;
  const snapshot = await coverSnapshotOf(data, asset.id);
  await (
    await getRepo()
  ).upsert(data.project.id, "assets", {
    ...asset,
    metadata: {
      ...asset.metadata,
      cover: { selectedAt: at, ...snapshot, ...(design ? { design: coverDesignOf(design) } : {}) },
    },
    updatedAt: at,
  });

  refresh(slug);
  return { ok: true as const, message: "Cover set." };
}

/** Save how the title is laid over the cover (style, subtitle, tagline, cast names, credits). */
async function saveCoverDesign_impl(form: FormData) {
  const slug = str(form, "projectSlug");
  await requireUser();
  const data = await requireProjectFresh(slug);
  const cover = currentCover(data);
  if (!cover || cover.id !== str(form, "assetId")) throw new UserFacingError("Choose a cover first.");
  let raw: unknown;
  try {
    raw = JSON.parse(str(form, "design") || "{}");
  } catch {
    throw new UserFacingError("That design could not be read.");
  }
  const at = new Date().toISOString();
  const record = (cover.metadata as { cover?: Record<string, unknown> }).cover ?? {};
  const snapshot = await coverSnapshotOf(data, cover.id);
  await (
    await getRepo()
  ).upsert(data.project.id, "assets", {
    ...cover,
    metadata: { ...cover.metadata, cover: { ...record, ...snapshot, design: coverDesignOf(raw) } },
    updatedAt: at,
  });
  refresh(slug);
  return { ok: true as const, message: "Title design saved." };
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

export async function editCoverArt(form: FormData): Promise<ActionResult> {
  return runAction(() => editCoverArt_impl(form), { name: "editCoverArt" });
}

export async function setCover(form: FormData): Promise<ActionResult> {
  return runAction(() => setCover_impl(form), { name: "setCover" });
}

export async function saveCoverDesign(form: FormData): Promise<ActionResult> {
  return runAction(() => saveCoverDesign_impl(form), { name: "saveCoverDesign" });
}

export async function stopCoverArt(form: FormData): Promise<ActionResult> {
  return runAction(() => stopCoverArt_impl(form), { name: "stopCoverArt" });
}
