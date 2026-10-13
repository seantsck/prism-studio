"use server";

import { revalidatePath } from "next/cache";
import { computeQaInputs, runContinuityReview } from "@/continuity/service";
import { CONTINUITY_RESULTS, type ContinuityResult } from "@/domain/continuity/model";
import { parseAdaptationPlan } from "@/domain/framing/adaptation";
import { MediaError } from "@/media/types";
import { conformAttemptOutput, DeliveryError } from "@/media/delivery";
import { MediaQaError } from "@/data/media-qa-repository";
import { runAction, UserFacingError, type ActionResult } from "./action-result";
import { requireUser } from "./auth";
import { getGenerationRepo } from "./generation";
import { getContinuityAnalyzer, getDeliveryDeps, getMediaQaRepo } from "./media-qa";
import { requireProjectFresh, getRepo } from "./repo";

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

function refresh(slug: string) {
  revalidatePath(`/projects/${slug}`, "layout");
}

/** Turns media-tool failures into sentences a person can act on. */
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof MediaError) {
      if (err.code === "unavailable") {
        throw new UserFacingError(
          "Media processing is not available on this server (ffmpeg is not installed). See docs/media-processing.md.",
        );
      }
      throw new UserFacingError(`Media processing failed: ${err.message}`);
    }
    if (err instanceof DeliveryError || err instanceof MediaQaError) throw new UserFacingError(err.message);
    throw err;
  }
}

async function loadAttempt(form: FormData) {
  const slug = str(form, "projectSlug");
  const data = await requireProjectFresh(slug); // authorises the slug for this user
  const repo = await getGenerationRepo();
  const view = await repo.getAttemptView(str(form, "attemptId"));
  if (!view || view.attempt.projectId !== data.project.id) {
    throw new UserFacingError("That attempt no longer exists.");
  }
  const user = await requireUser();
  return { slug, data, view, userId: user.kind === "supabase" ? user.id : null };
}

const shotLabel = (data: Awaited<ReturnType<typeof requireProjectFresh>>, shotId: string, n: number) =>
  `${data.shots.find((s) => s.id === shotId)?.shotCode ?? "shot"}-a${n}`;

// ───────────────────────── delivery conform ─────────────────────────

async function createDeliveryConform_impl(form: FormData) {
  const { slug, data, view, userId } = await loadAttempt(form);
  if (view.attempt.status !== "succeeded")
    throw new UserFacingError("Only a completed generation can be conformed.");
  const plan = parseAdaptationPlan(view.attempt.adaptationPlan);
  if (!plan)
    throw new UserFacingError(
      "No adaptation plan was recorded for this attempt, so there is nothing to conform.",
    );
  const original =
    view.outputs.find((o) => o.output.role === "primary")?.asset ?? view.outputs[0]?.asset ?? null;
  if (!original) throw new UserFacingError("This attempt has no output to conform.");
  await guard(async () => {
    const deps = await getDeliveryDeps(userId);
    await conformAttemptOutput({
      attemptId: view.attempt.id,
      attemptLabel: shotLabel(data, view.attempt.shotId, view.attempt.attemptNumber),
      original,
      plan: plan.conform,
      deps,
    });
  });
  refresh(slug);
}

export async function createDeliveryConform(form: FormData): Promise<ActionResult> {
  return runAction(() => createDeliveryConform_impl(form), { name: "createDeliveryConform" });
}

/** Choose which stored version (the provider original, or any derived conform) is the delivery master. */
async function selectDeliveryMaster_impl(form: FormData) {
  const { slug, view, userId } = await loadAttempt(form);
  const qa = await getMediaQaRepo();
  const assetId = str(form, "assetId");
  const original = view.outputs.find((o) => o.output.role === "primary")?.asset ?? view.outputs[0]?.asset;
  if (!original) throw new UserFacingError("This attempt has no output.");
  const derivations = await qa.listAttemptDerivations(view.attempt.id);
  const candidate =
    assetId === original.id
      ? original
      : derivations.find((d) => d.asset.id === assetId && d.derivation.slot === "delivery")?.asset;
  if (!candidate) throw new UserFacingError("That file is not a version of this attempt's output.");
  const chosen = derivations.find((d) => d.asset.id === candidate.id);
  await qa.selectDelivery({
    attemptId: view.attempt.id,
    projectId: view.attempt.projectId,
    assetId: candidate.id,
    originalAssetId: original.id,
    conform: chosen
      ? {
          derivedFrom: original.id,
          derivationKey: chosen.derivation.derivationKey,
          version: chosen.derivation.version,
          ...chosen.derivation.parameters,
        }
      : null,
    selectedBy: userId,
    now: new Date().toISOString(),
  });
  refresh(slug);
}

export async function selectDeliveryMaster(form: FormData): Promise<ActionResult> {
  return runAction(() => selectDeliveryMaster_impl(form), { name: "selectDeliveryMaster" });
}

// ───────────────────────── continuity review ─────────────────────────

async function startContinuityReview_impl(form: FormData) {
  const { slug, data, view, userId } = await loadAttempt(form);
  if (view.attempt.status !== "succeeded") {
    throw new UserFacingError("Continuity review needs a completed generation.");
  }
  const qa = await getMediaQaRepo();
  const delivery = await qa.getDelivery(view.attempt.id);
  const inputs = computeQaInputs({ data, view, delivery });
  if (!inputs?.subject) throw new UserFacingError("This attempt has no output to review.");
  await guard(async () => {
    const deps = await getDeliveryDeps(userId);
    await runContinuityReview({
      inputs,
      view,
      deps: { ...deps, analyzer: getContinuityAnalyzer() },
    });
  });
  refresh(slug);
}

export async function startContinuityReview(form: FormData): Promise<ActionResult> {
  return runAction(() => startContinuityReview_impl(form), { name: "startContinuityReview" });
}

async function overrideFinding_impl(form: FormData) {
  const { slug, view, userId } = await loadAttempt(form);
  const qa = await getMediaQaRepo();
  const runId = str(form, "runId");
  const run = await qa.getRun(runId);
  if (!run || run.run.attemptId !== view.attempt.id)
    throw new UserFacingError("That review no longer exists.");
  if (run.run.finalizedAt)
    throw new UserFacingError("This review is closed. Start a new review to change results.");
  const result = str(form, "result") as ContinuityResult;
  if (!(CONTINUITY_RESULTS as readonly string[]).includes(result))
    throw new UserFacingError("Choose a result.");
  const findingId = str(form, "findingId");
  if (!run.findings.some((f) => f.finding.id === findingId))
    throw new UserFacingError("That criterion no longer exists.");
  await guard(() =>
    qa.addOverride({
      runId,
      findingId,
      result,
      notes: str(form, "notes").slice(0, 1000),
      createdBy: userId,
      now: new Date().toISOString(),
    }),
  );
  refresh(slug);
}

export async function overrideFinding(form: FormData): Promise<ActionResult> {
  return runAction(() => overrideFinding_impl(form), { name: "overrideFinding" });
}

async function finalizeContinuityReview_impl(form: FormData) {
  const { slug, view, userId } = await loadAttempt(form);
  const qa = await getMediaQaRepo();
  const run = await qa.getRun(str(form, "runId"));
  if (!run || run.run.attemptId !== view.attempt.id)
    throw new UserFacingError("That review no longer exists.");
  await guard(() =>
    qa.finalizeRun(run.run.id, {
      by: userId,
      note: str(form, "note").slice(0, 1000),
      now: new Date().toISOString(),
    }),
  );
  refresh(slug);
}

export async function finalizeContinuityReview(form: FormData): Promise<ActionResult> {
  return runAction(() => finalizeContinuityReview_impl(form), { name: "finalizeContinuityReview" });
}

// ───────────────────────── protected composition ─────────────────────────

async function saveProtectedComposition_impl(form: FormData) {
  const slug = str(form, "projectSlug");
  const data = await requireProjectFresh(slug);
  const shot = data.shots.find((s) => s.id === str(form, "shotId"));
  if (!shot) throw new UserFacingError("That shot no longer exists.");
  const notes = String(form.get("notes") ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 12)
    .map((l) => l.slice(0, 200));
  const repo = await getRepo();
  await repo.upsert(data.project.id, "shots", {
    ...shot,
    generation: { ...shot.generation, protectedComposition: notes },
    updatedAt: new Date().toISOString(),
  });
  refresh(slug);
}

export async function saveProtectedComposition(form: FormData): Promise<ActionResult> {
  return runAction(() => saveProtectedComposition_impl(form), { name: "saveProtectedComposition" });
}
