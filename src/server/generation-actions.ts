"use server";

import { revalidatePath } from "next/cache";
import { GenerationSubmitError, NOT_SHOT_OUTPUT_APPROVAL_MESSAGE } from "@/data/generation-repository";
import {
  DURATION_STRATEGIES,
  FRAMING_STRATEGIES,
  type DurationStrategy,
  type FramingStrategy,
} from "@/domain/framing/adaptation";
import {
  isShotOutputAttempt,
  REJECTION_CATEGORIES,
  type RejectionCategory,
} from "@/domain/generation/schemas";
import { prepareSubmission, submissionKey } from "@/generation/submission";
import { runAction, UserFacingError, type ActionResult } from "./action-result";
import { requireUser } from "./auth";
import { getGenerationConfig, getGenerationRepo, getRegistry } from "./generation";
import { requireProjectFresh } from "./repo";

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

function refresh(slug: string) {
  revalidatePath(`/projects/${slug}`, "layout");
}

/**
 * Creates an immutable attempt and queues its job. Every gate is re-evaluated server-side from fresh data:
 * the UI's "Generate" button is a convenience, never the authority.
 */
async function startGeneration_impl(form: FormData) {
  const slug = str(form, "projectSlug");
  const shotId = str(form, "shotId");
  const provider = str(form, "provider");
  const modelId = str(form, "model");
  if (!provider || !modelId) throw new UserFacingError("Choose a generation model.");

  const user = await requireUser();
  const repo = await getGenerationRepo();
  // Read the revision of every package input BEFORE loading the data the package is built from: the commit
  // re-checks it, so the frozen package is exactly the one that was validated (no Look/take/asset can slip in).
  const revision = await repo.projectRevision(slug);
  if (!revision) throw new UserFacingError("That project no longer exists.");
  const data = await requireProjectFresh(slug);
  const shot = data.shots.find((s) => s.id === shotId);
  if (!shot) throw new UserFacingError("That shot no longer exists.");

  const registry = getRegistry();
  const config = getGenerationConfig();
  const acknowledged = form.getAll("ack").map((v) => String(v));
  // Adaptation is always an explicit choice made in the Generate panel; absent = nothing is adapted.
  const framingRaw = str(form, "framing");
  const durationRaw = str(form, "durationStrategy");
  const adaptation = {
    framing: (FRAMING_STRATEGIES as readonly string[]).includes(framingRaw)
      ? (framingRaw as FramingStrategy)
      : null,
    duration: (DURATION_STRATEGIES as readonly string[]).includes(durationRaw)
      ? (durationRaw as DurationStrategy)
      : null,
  };

  const existing = (await repo.listShotAttempts(shotId)).map((v) => v.attempt.attemptNumber);
  const nextNumber = Math.max(0, ...existing) + 1;

  // Evaluate once with an arbitrary key to learn the package fingerprint, then bind the real key to it.
  const probe = prepareSubmission({
    data,
    shotId,
    registry,
    provider,
    modelId,
    acknowledged,
    adaptation,
    userId: user.kind === "supabase" ? user.id : null,
    idempotencyKey: "probe-key-not-submitted",
    config,
  });
  const fingerprint = probe.evaluation.pkg.provenance.fingerprint;
  const clientKey = str(form, "idempotencyKey");
  const key =
    clientKey.length >= 8
      ? clientKey
      : submissionKey(shotId, nextNumber, fingerprint, `${provider}/${modelId}`);

  const prepared = prepareSubmission({
    data,
    shotId,
    registry,
    provider,
    modelId,
    acknowledged,
    adaptation,
    userId: user.kind === "supabase" ? user.id : null,
    idempotencyKey: key,
    config,
    projectRevision: revision.revision,
  });
  if (!prepared.input) {
    const g = prepared.evaluation.gate;
    const reasons = [
      ...g.blockers.map((b) => b.message),
      ...g.unacknowledged.map((f) => `Acknowledge: ${f.label} will not be used (${f.impact})`),
    ];
    throw new UserFacingError(
      `Generation is blocked (${reasons.length} issue${reasons.length === 1 ? "" : "s"}): ${reasons.slice(0, 3).join(" · ")}${reasons.length > 3 ? " …" : ""}`,
    );
  }

  try {
    await repo.createAttemptWithJob(prepared.input);
  } catch (err) {
    if (err instanceof GenerationSubmitError) throw new UserFacingError(err.message);
    throw err;
  }
  refresh(slug);
}

export async function startGeneration(form: FormData): Promise<ActionResult> {
  return runAction(() => startGeneration_impl(form), { name: "startGeneration" });
}

async function cancelGeneration_impl(form: FormData) {
  const slug = str(form, "projectSlug");
  const data = await requireProjectFresh(slug); // authorises the slug for this user (RLS)
  const repo = await getGenerationRepo();
  const job = await repo.getJob(str(form, "jobId"));
  // The job must belong to THIS project, not merely to some project the user owns.
  if (!job || job.projectId !== data.project.id)
    throw new UserFacingError("That generation no longer exists.");
  await repo.requestCancel(job.id, new Date().toISOString());
  refresh(slug);
}

export async function cancelGeneration(form: FormData): Promise<ActionResult> {
  return runAction(() => cancelGeneration_impl(form), { name: "cancelGeneration" });
}

async function reviewGeneration_impl(form: FormData) {
  const slug = str(form, "projectSlug");
  const data = await requireProjectFresh(slug);
  const repo = await getGenerationRepo();
  const decision = str(form, "decision");
  if (decision !== "approve" && decision !== "reject" && decision !== "clear" && decision !== "notes") {
    throw new UserFacingError("Unknown review decision.");
  }
  const view = await repo.getAttemptView(str(form, "attemptId"));
  if (!view || view.attempt.projectId !== data.project.id)
    throw new UserFacingError("That attempt no longer exists.");
  if (decision === "approve" && view.attempt.status !== "succeeded") {
    throw new UserFacingError("Only a completed generation can be approved.");
  }
  // the repository enforces this too; checked here so a direct request gets the reason, not a generic error
  if (decision === "approve" && !isShotOutputAttempt(view.attempt)) {
    throw new UserFacingError(NOT_SHOT_OUTPUT_APPROVAL_MESSAGE);
  }

  const categories = form
    .getAll("category")
    .map((v) => String(v))
    .filter((v): v is RejectionCategory => (REJECTION_CATEGORIES as readonly string[]).includes(v));
  const reason = str(form, "reason");
  if (decision === "reject" && categories.length === 0 && !reason) {
    throw new UserFacingError("Choose at least one rejection reason, or describe what is wrong.");
  }
  const status =
    decision === "approve"
      ? "approved"
      : decision === "reject"
        ? "rejected"
        : decision === "clear"
          ? "unreviewed"
          : view.attempt.reviewStatus;
  await repo.reviewAttempt(view.attempt.id, {
    status,
    categories: decision === "notes" ? view.attempt.rejectionCategories : categories,
    reason: decision === "notes" ? view.attempt.rejectionReason : reason,
    notes: str(form, "notes"),
    now: new Date().toISOString(),
  });
  refresh(slug);
}

export async function reviewGeneration(form: FormData): Promise<ActionResult> {
  return runAction(() => reviewGeneration_impl(form), { name: "reviewGeneration" });
}
