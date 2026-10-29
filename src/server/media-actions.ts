"use server";

import { revalidatePath } from "next/cache";
import { AnalysisSubmitError, submitAnalysis } from "@/continuity/analysis/submit";
import { reconcileAttemptQa } from "@/continuity/automation";
import { computeQaInputs, runContinuityReview } from "@/continuity/service";
import {
  directVideoPermitted,
  qaPolicyErrors,
  SEMANTIC_MODES,
  type ReconcileResult,
  type SemanticMode,
} from "@/domain/continuity/automation";
import { CONTINUITY_RESULTS, type ContinuityResult } from "@/domain/continuity/model";
import { parseAdaptationPlan } from "@/domain/framing/adaptation";
import { MediaError } from "@/media/types";
import { conformAttemptOutput, DeliveryError } from "@/media/delivery";
import { MediaQaError } from "@/data/media-qa-repository";
import { runAction, UserFacingError, type ActionResult } from "./action-result";
import { requireUser } from "./auth";
import { getGenerationRepo } from "./generation";
import {
  getAnalysisConfig,
  getAnalysisProviders,
  getAutoQaDeps,
  getContinuityAnalyzer,
  getDeliveryDeps,
  getMediaQaRepo,
} from "./media-qa";
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

/**
 * Phase 3A.2: automatic QA for the attempt's CURRENT truth, after a media operation succeeded. Never throws: a QA
 * failure must not undo or obscure the conform / selection that already happened; it comes back as a warning.
 */
async function reconcileAfter(loaded: Awaited<ReturnType<typeof loadAttempt>>): Promise<string | null> {
  try {
    const qa = await getMediaQaRepo();
    const data = await requireProjectFresh(loaded.slug);
    const view = (await (await getGenerationRepo()).getAttemptView(loaded.view.attempt.id)) ?? loaded.view;
    const r = await reconcileAttemptQa({
      data,
      view,
      policy: await qa.getQaPolicy(data.project.id),
      deps: await getAutoQaDeps(loaded.userId),
    });
    return r.outcomes.includes("failed") ? r.reasons.at(-1)! : null;
  } catch (err) {
    return `Automatic QA could not run: ${err instanceof Error ? err.message : String(err)}`;
  }
}

const withQaWarning = (message: string, warning: string | null): ActionResult => ({
  ok: true,
  message: warning ? `${message}. ${warning}` : message,
});

const shotLabel = (data: Awaited<ReturnType<typeof requireProjectFresh>>, shotId: string, n: number) =>
  `${data.shots.find((s) => s.id === shotId)?.shotCode ?? "shot"}-a${n}`;

// ───────────────────────── delivery conform ─────────────────────────

async function createDeliveryConform_impl(form: FormData): Promise<ActionResult> {
  const loaded = await loadAttempt(form);
  const { slug, data, view, userId } = loaded;
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
  // the conform is selected as the delivery master: QA the new subject (after the media write succeeded)
  const warning = await reconcileAfter(loaded);
  refresh(slug);
  return withQaWarning("Delivery conform created", warning);
}

export async function createDeliveryConform(form: FormData): Promise<ActionResult> {
  return runAction(() => createDeliveryConform_impl(form), { name: "createDeliveryConform" });
}

/** Choose which stored version (the provider original, or any derived conform) is the delivery master. */
async function selectDeliveryMaster_impl(form: FormData): Promise<ActionResult> {
  const loaded = await loadAttempt(form);
  const { slug, view, userId } = loaded;
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
  const warning = await reconcileAfter(loaded);
  refresh(slug);
  return withQaWarning("Delivery master selected", warning);
}

export async function selectDeliveryMaster(form: FormData): Promise<ActionResult> {
  return runAction(() => selectDeliveryMaster_impl(form), { name: "selectDeliveryMaster" });
}

// ───────────────────────── automatic Shot QA (Phase 3A.2) ─────────────────────────

/**
 * The page found automatic QA due for this attempt's current truth and asks for it. Idempotent: a repeated or
 * concurrent call for the same truth changes nothing. Returns every outcome and reason (nothing is hidden).
 */
export async function reconcileAttemptQaAction(form: FormData): Promise<ReconcileResult> {
  let loaded: Awaited<ReturnType<typeof loadAttempt>>;
  try {
    loaded = await loadAttempt(form);
  } catch (err) {
    return {
      outcomes: ["not_eligible"],
      reasons: [err instanceof UserFacingError ? err.message : "That attempt is not available."],
      runId: null,
      jobId: null,
    };
  }
  const qa = await getMediaQaRepo();
  const result = await reconcileAttemptQa({
    data: loaded.data,
    view: loaded.view,
    policy: await qa.getQaPolicy(loaded.data.project.id),
    deps: await getAutoQaDeps(loaded.userId),
  });
  if (result.outcomes.some((o) => o === "deterministic_created" || o === "semantic_queued"))
    refresh(loaded.slug);
  return result;
}

const money = (f: FormData, k: string): number | null => {
  const v = str(f, k);
  if (v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : Number.NaN;
};

/** Owner-only Project Shot QA policy. `automatic` is a standing authorisation and needs explicit confirmation. */
async function saveQaPolicy_impl(form: FormData): Promise<ActionResult> {
  const slug = str(form, "projectSlug");
  const data = await requireProjectFresh(slug);
  const user = await requireUser();
  const mode = str(form, "semanticMode") as SemanticMode;
  if (!(SEMANTIC_MODES as readonly string[]).includes(mode))
    throw new UserFacingError("Choose a semantic QA mode.");
  const policy = {
    semanticMode: mode,
    analyzer: str(form, "analyzer") || null,
    externalMediaAllowed: str(form, "externalMediaAllowed") === "1",
    maxCostPerRunUsd: money(form, "maxCostPerRunUsd"),
    maxCostPerDayUsd: money(form, "maxCostPerDayUsd"),
    // 3A.3: only an explicit checkbox; never inferred from the mode, a credential or media consent
    directVideoAllowed: str(form, "directVideoAllowed") === "1",
  };
  const errors = qaPolicyErrors(policy);
  if (errors.length > 0) throw new UserFacingError(errors.join(" "));
  if (mode === "automatic" && str(form, "confirmAutomatic") !== "1")
    throw new UserFacingError(
      "Confirm the standing authorisation to turn on automatic semantic QA (it sends media and may cost money without asking each time).",
    );
  if (policy.analyzer && !getAnalysisProviders().has(policy.analyzer) && mode === "automatic")
    throw new UserFacingError(`The analyzer "${policy.analyzer}" is not available on this server.`);
  const qa = await getMediaQaRepo();
  await guard(() =>
    qa.saveQaPolicy({
      projectId: data.project.id,
      policy,
      expectedRevision: Number(str(form, "revision") || "0"),
      by: user.kind === "supabase" ? user.id : null,
      now: new Date().toISOString(),
    }),
  );
  refresh(slug);
  return { ok: true, message: "Shot QA policy saved" };
}

export async function saveQaPolicy(form: FormData): Promise<ActionResult> {
  return runAction(() => saveQaPolicy_impl(form), { name: "saveQaPolicy" });
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

/**
 * Queues an automated analysis. The server action never calls an analyzer: it freezes the plan/input/manifest,
 * applies the SERVER-SIDE spend policy (a number from the client is never trusted), and enqueues a job for the
 * continuity worker.
 */
async function startContinuityAnalysis_impl(form: FormData) {
  const { slug, data, view, userId } = await loadAttempt(form);
  if (view.attempt.status !== "succeeded") {
    throw new UserFacingError("Automated analysis needs a completed generation.");
  }
  const providerId = str(form, "analyzer");
  const provider = getAnalysisProviders().get(providerId);
  if (!provider) throw new UserFacingError("That analyzer is not available on this server.");
  const qa = await getMediaQaRepo();
  const delivery = await qa.getDelivery(view.attempt.id);
  const inputs = computeQaInputs({ data, view, delivery });
  if (!inputs?.subject) throw new UserFacingError("This attempt has no output to analyse.");
  const config = getAnalysisConfig();
  // 3A.3: the full video only when the Project allows it (owner policy, read here, never from the client) AND this
  // run explicitly acknowledged the full-video transfer
  const policy = await qa.getQaPolicy(data.project.id);
  try {
    await guard(async () => {
      const deps = await getDeliveryDeps(userId);
      await submitAnalysis({
        inputs,
        view,
        assets: data.assets,
        provider,
        policy: config.paid,
        deps,
        acknowledged: str(form, "ackSpend") === "1",
        nonce: str(form, "nonce") || new Date().toISOString(),
        limits: config.limits,
        directVideo: {
          allowed: directVideoPermitted(policy, "manual"),
          acknowledged: str(form, "ackDirectVideo") === "1",
        },
      });
    });
  } catch (err) {
    if (err instanceof AnalysisSubmitError) throw new UserFacingError(err.message);
    throw err;
  }
  refresh(slug);
}

export async function startContinuityAnalysis(form: FormData): Promise<ActionResult> {
  return runAction(() => startContinuityAnalysis_impl(form), { name: "startContinuityAnalysis" });
}

async function cancelContinuityAnalysis_impl(form: FormData) {
  const { slug, view } = await loadAttempt(form);
  const qa = await getMediaQaRepo();
  const job = await qa.getAnalysisJob(str(form, "jobId"));
  if (!job || job.attemptId !== view.attempt.id) throw new UserFacingError("That analysis no longer exists.");
  await qa.requestAnalysisCancel(job.id, new Date().toISOString());
  refresh(slug);
}

export async function cancelContinuityAnalysis(form: FormData): Promise<ActionResult> {
  return runAction(() => cancelContinuityAnalysis_impl(form), { name: "cancelContinuityAnalysis" });
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
