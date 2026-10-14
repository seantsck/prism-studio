"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { CandidateError } from "@/data/candidates-repository";
import {
  NEGATIVE_TAGS,
  POSITIVE_TAGS,
  REVIEW_DECISIONS,
  ReviewValidationError,
  latestReviews,
  normalizeReview,
} from "@/domain/generation/reviews";
import { PREFERENCES, type RecommendationPreference } from "@/domain/generation/recommendation";
import { CandidateSetBlockedError, submitCandidateSet } from "@/generation/candidate-set";
import { runAction, UserFacingError, type ActionResult } from "./action-result";
import { requireUser } from "./auth";
import { getCandidateRepo } from "./candidates";
import { getGenerationConfig, getGenerationRepo, getRegistry } from "./generation";
import { requireProjectFresh } from "./repo";

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

const selectionsSchema = z
  .array(
    z.object({
      provider: z.string().min(1).max(64),
      modelId: z.string().min(1).max(96),
      inputMode: z.enum(["keyframes", "references"]).nullable().optional(),
      tierId: z.string().max(16).nullable().optional(),
      nativeAudio: z.boolean().optional(),
    }),
  )
  .min(1)
  .max(8);

function refresh(slug: string) {
  revalidatePath(`/projects/${slug}`, "layout");
}

const actorOf = (user: Awaited<ReturnType<typeof requireUser>>) =>
  user.kind === "supabase" ? user.id : null;

/**
 * Creates a candidate set: ONE shared package, several models, each its own attempt + job. Every gate is
 * re-evaluated server-side from fresh data; the client's total is only a confirmation that the server
 * re-computes and must match. Never starts anything paid without that explicit confirmation.
 */
async function createCandidateSet_impl(form: FormData) {
  const slug = str(form, "projectSlug");
  const shotId = str(form, "shotId");
  const user = await requireUser();
  const generation = await getGenerationRepo();
  const candidates = await getCandidateRepo();
  const revision = await generation.projectRevision(slug);
  if (!revision) throw new UserFacingError("That project no longer exists.");
  const data = await requireProjectFresh(slug);
  if (!data.shots.some((s) => s.id === shotId)) throw new UserFacingError("That shot no longer exists.");

  let selections: z.infer<typeof selectionsSchema>;
  try {
    selections = selectionsSchema.parse(JSON.parse(str(form, "selections") || "[]"));
  } catch {
    throw new UserFacingError("Select between 1 and 8 models.");
  }
  const prefRaw = str(form, "preference");
  const preference = (PREFERENCES as readonly string[]).includes(prefRaw)
    ? (prefRaw as RecommendationPreference)
    : undefined;
  const confirmedRaw = str(form, "confirmedTotalUsd");
  const confirmedTotalUsd = confirmedRaw === "" ? null : Number(confirmedRaw);

  let setId: string;
  try {
    const out = await submitCandidateSet({
      data,
      shotId,
      registry: getRegistry(),
      config: getGenerationConfig(),
      generation,
      candidates,
      selections: selections.map((s) => ({
        provider: s.provider,
        modelId: s.modelId,
        inputMode: s.inputMode ?? null,
        tierId: s.tierId ?? null,
        nativeAudio: s.nativeAudio ?? false,
      })),
      acknowledgeAll: str(form, "ackAll") === "1",
      confirmedTotalUsd:
        confirmedTotalUsd != null && Number.isFinite(confirmedTotalUsd) ? confirmedTotalUsd : null,
      title: str(form, "title").slice(0, 120),
      purpose: str(form, "purpose").slice(0, 500),
      userId: actorOf(user),
      projectRevision: revision.revision,
      preference,
    });
    setId = out.view.set.id;
  } catch (err) {
    if (err instanceof CandidateSetBlockedError) throw new UserFacingError(err.message);
    if (err instanceof CandidateError) throw new UserFacingError(err.message);
    throw err;
  }
  refresh(slug);
  redirect(`/projects/${slug}/candidates/${setId}`);
}

export async function createCandidateSet(form: FormData): Promise<ActionResult> {
  return runAction(() => createCandidateSet_impl(form), { name: "createCandidateSet" });
}

async function ownedAttempt(slug: string, attemptId: string) {
  const data = await requireProjectFresh(slug);
  const generation = await getGenerationRepo();
  const view = await generation.getAttemptView(attemptId);
  if (!view || view.attempt.projectId !== data.project.id)
    throw new UserFacingError("That generation no longer exists.");
  return { data, generation, view };
}

/** A quick human verdict on one generation (Good / Shortlist / Reject + reasons). Append-only. */
async function reviewCandidate_impl(form: FormData) {
  const slug = str(form, "projectSlug");
  const { data, view } = await ownedAttempt(slug, str(form, "attemptId"));
  const user = await requireUser();
  const candidates = await getCandidateRepo();
  const decision = str(form, "decision");
  if (!(REVIEW_DECISIONS as readonly string[]).includes(decision))
    throw new UserFacingError("Unknown review decision.");
  let normalized;
  try {
    normalized = normalizeReview({
      decision: decision as (typeof REVIEW_DECISIONS)[number],
      negativeTags: form
        .getAll("negative")
        .map(String)
        .filter((t) => (NEGATIVE_TAGS as readonly string[]).includes(t)),
      positiveTags: form
        .getAll("positive")
        .map(String)
        .filter((t) => (POSITIVE_TAGS as readonly string[]).includes(t)),
      notes: str(form, "notes"),
    });
  } catch (e) {
    if (e instanceof ReviewValidationError) throw new UserFacingError(e.message);
    throw e;
  }
  // A review is a verdict on a clip. A failed / cancelled / queued attempt has no clip, so it can never be
  // reviewed as though one existed (its provider failure stays visible as the attempt's own status).
  if (view.attempt.status !== "succeeded")
    throw new UserFacingError("Only a completed generation has a clip to review.");
  const set = await candidates.findSetForAttempt(view.attempt.id);
  await candidates.recordReview({
    projectId: data.project.id,
    attemptId: view.attempt.id,
    candidateSetId: set?.set.id ?? null,
    ...normalized,
    reviewer: actorOf(user),
    now: new Date().toISOString(),
  });
  refresh(slug);
}

export async function reviewCandidate(form: FormData): Promise<ActionResult> {
  return runAction(() => reviewCandidate_impl(form), { name: "reviewCandidate" });
}

/** ⭐ Best: marks the set's single preferred candidate. Does NOT make it the shot's output. */
async function markBest_impl(form: FormData) {
  const slug = str(form, "projectSlug");
  const { data, view } = await ownedAttempt(slug, str(form, "attemptId"));
  const user = await requireUser();
  const candidates = await getCandidateRepo();
  const setId = str(form, "setId");
  const clear = str(form, "clear") === "1";
  const set = await candidates.getSet(setId);
  if (!set || set.set.projectId !== data.project.id) throw new UserFacingError("That set no longer exists.");
  if (!clear && view.attempt.status !== "succeeded")
    throw new UserFacingError("Only a completed generation can be marked Best.");
  try {
    await candidates.setPreferred(
      setId,
      clear ? null : view.attempt.id,
      actorOf(user),
      new Date().toISOString(),
    );
  } catch (e) {
    if (e instanceof CandidateError) throw new UserFacingError(e.message);
    throw e;
  }
  if (!clear) {
    // Best implies a positive human verdict unless the person already gave one
    const reviews = await candidates.listReviews(data.project.id, { attemptIds: [view.attempt.id] });
    const current = latestReviews(reviews).get(view.attempt.id);
    if (!current || current.decision === "reject" || current.decision === "unreviewed") {
      await candidates.recordReview({
        projectId: data.project.id,
        attemptId: view.attempt.id,
        candidateSetId: setId,
        decision: "approve",
        positiveTags: [],
        negativeTags: [],
        notes: "",
        reviewer: actorOf(user),
        now: new Date().toISOString(),
      });
    }
  }
  refresh(slug);
}

export async function markBest(form: FormData): Promise<ActionResult> {
  return runAction(() => markBest_impl(form), { name: "markBest" });
}

/**
 * Promote to Shot: the explicit, confirmed step that makes ONE candidate the shot's creative output. It is the
 * existing attempt approval (which supersedes the shot's previously approved attempt, history intact) plus a
 * record on the set. Losing candidates are never deleted.
 */
async function promoteCandidate_impl(form: FormData) {
  const slug = str(form, "projectSlug");
  const { data, generation, view } = await ownedAttempt(slug, str(form, "attemptId"));
  if (str(form, "confirm") !== "1") throw new UserFacingError("Confirm the promotion first.");
  const user = await requireUser();
  const candidates = await getCandidateRepo();
  const setId = str(form, "setId");
  const set = await candidates.getSet(setId);
  if (!set || set.set.projectId !== data.project.id) throw new UserFacingError("That set no longer exists.");
  if (!set.members.some((m) => m.attemptId === view.attempt.id))
    throw new UserFacingError("That generation is not a candidate of this set.");
  if (view.attempt.status !== "succeeded")
    throw new UserFacingError("Only a completed generation can be promoted.");
  const now = new Date().toISOString();
  await generation.reviewAttempt(view.attempt.id, {
    status: "approved",
    categories: [],
    reason: "",
    notes: view.attempt.notes,
    now,
  });
  try {
    await candidates.recordPromotion(setId, view.attempt.id, actorOf(user), now);
  } catch (e) {
    if (e instanceof CandidateError) throw new UserFacingError(e.message);
    throw e;
  }
  refresh(slug);
}

export async function promoteCandidate(form: FormData): Promise<ActionResult> {
  return runAction(() => promoteCandidate_impl(form), { name: "promoteCandidate" });
}

async function archiveCandidateSet_impl(form: FormData) {
  const slug = str(form, "projectSlug");
  const data = await requireProjectFresh(slug);
  const user = await requireUser();
  const candidates = await getCandidateRepo();
  const set = await candidates.getSet(str(form, "setId"));
  if (!set || set.set.projectId !== data.project.id) throw new UserFacingError("That set no longer exists.");
  const archive = str(form, "archive") !== "0";
  await candidates.setStatus(
    set.set.id,
    archive ? "archived" : set.set.promotedAttemptId ? "decided" : "open",
    actorOf(user),
    new Date().toISOString(),
  );
  refresh(slug);
}

export async function archiveCandidateSet(form: FormData): Promise<ActionResult> {
  return runAction(() => archiveCandidateSet_impl(form), { name: "archiveCandidateSet" });
}
