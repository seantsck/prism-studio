"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ShotListError, type ShotListProposal } from "@/data/shot-list-repository";
import { WritingError, type SpendAuthorization } from "@/data/writing-repository";
import type { ProjectData, Scene } from "@/domain/schemas";
import {
  planningOutputTokens,
  sceneSnapshot,
  SHOT_LIST_SCHEMA_VERSION,
  type ShotPlanScope,
} from "@/domain/story/shot-list";
import {
  duplicateItem,
  moveItem,
  planShotListApply,
  reviewOfShotList,
  SHOT_EDITABLE,
  splitItem,
  type ShotListReview,
} from "@/domain/story/shot-list-review";
import { sourceFingerprint } from "@/domain/story/source";
import { canonical, estimateWritingInputTokens } from "@/domain/story/writing";
import { estimateUsd } from "@/story/provider";
import {
  SHOT_PLANNER_INSTRUCTIONS,
  SHOT_PLANNER_PROMPT_VERSION,
  shotPlannerInput,
} from "@/story/shot-planner-prompt";
import { runAction, UserFacingError, type ActionResult } from "./action-result";
import { getRepo, requireProjectFresh } from "./repo";
import { actorId } from "./script-sync";
import { getShotListRepo, getStoryRegistry, getWritingRepo } from "./story";

/**
 * Phase 5B-S4: Scene → Plan Shots with Prism → Shot List Proposal → review → Apply. These actions QUEUE planning (the
 * Story worker calls the provider), keep the creator's review, and apply ONLY what the creator approved through
 * deterministic code (`planShotListApply`). The model never writes Shots; existing Shots change only through an
 * explicit, confirmed "Replace"; nothing is ever deleted.
 */
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const refresh = (slug: string) => revalidatePath(`/projects/${slug}`, "layout");
const now = () => new Date().toISOString();

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ShotListError || err instanceof WritingError) throw new UserFacingError(err.message);
    throw err;
  }
}

function sceneOf(data: ProjectData, id: string): { scene: Scene; episode: ProjectData["episodes"][number] } {
  const scene = data.scenes.find((s) => s.id === id && s.projectId === data.project.id);
  const episode = scene ? data.episodes.find((e) => e.id === scene.episodeId) : undefined;
  if (!scene || !episode) throw new UserFacingError("Choose one of this project's Scenes.");
  return { scene, episode };
}

function chooseModel(form: FormData) {
  const registry = getStoryRegistry();
  const listed = registry.models();
  const wanted = str(form, "model");
  const pick = wanted
    ? listed.find((m) => `${m.provider}/${m.modelId}` === wanted)
    : listed.find((m) => m.available);
  if (!pick) throw new UserFacingError("Prism AI is not set up on this server.");
  if (!pick.available) throw new UserFacingError(pick.reason ?? "That model is not available.");
  return { registry, model: registry.model(pick.provider, pick.modelId)! };
}

/**
 * Queue a Shot List for the Scene's CURRENT accepted screenplay (a whole list, or one Shot of an earlier version).
 * Spend (S2's controls): the explicit "Confirm total", or the capped allowance of the Episode's live writing session,
 * the per-request ceiling, and the worker's re-check.
 */
async function queuePlan(
  form: FormData,
  data: ProjectData,
  scene: Scene,
  scope: ShotPlanScope,
  parent: ShotListProposal | null,
): Promise<ShotListProposal> {
  const episode = data.episodes.find((e) => e.id === scene.episodeId)!;
  const snap = sceneSnapshot(data, episode, scene);
  if (!snap)
    throw new UserFacingError(
      "This Scene is not in the Episode's screenplay. Check its heading on the Script page.",
    );
  if (scope.kind === "shot") {
    if (!parent?.plan) throw new UserFacingError("Regenerate a Shot of a written shot list.");
    if (parent.sceneFingerprint !== snap.sceneFingerprint)
      throw new UserFacingError(
        "The Scene's screenplay changed since this plan. Re-plan the whole Scene instead.",
      );
  }
  const basePlan = scope.kind === "shot" ? parent!.plan : null;
  const { registry, model } = chooseModel(form);
  const inputTokens = estimateWritingInputTokens(
    SHOT_PLANNER_INSTRUCTIONS,
    shotPlannerInput({ context: snap.context, sceneText: snap.sceneText, scope, basePlan }),
  );
  const maxOutputTokens = planningOutputTokens(snap.context, model.maxOutputTokens || 32_000);
  const usd = estimateUsd(model, inputTokens, maxOutputTokens);
  let confirmedUsd: number | null = null;
  let spendAuthorization: SpendAuthorization = "free";
  if (model.paid) {
    if (inputTokens + maxOutputTokens > model.contextTokens)
      throw new UserFacingError("This Scene is too long to plan.");
    if (usd > registry.spend.maxUsd)
      throw new UserFacingError(
        `The estimated cost ($${usd.toFixed(4)}) is over this server's per-request limit ($${registry.spend.maxUsd.toFixed(2)}).`,
      );
    const confirmed = Number(str(form, "confirmedTotalUsd"));
    if (str(form, "confirmedTotalUsd") && Number.isFinite(confirmed) && confirmed + 1e-9 >= usd) {
      confirmedUsd = confirmed;
      spendAuthorization = "confirmed";
    } else {
      // the capped allowance of the Episode's newest live writing session (S2), reserved atomically
      const writing = await getWritingRepo({ startInlineWorker: false });
      const live = (await writing.listSessions(data.project.id, episode.id)).find(
        (s) => s.budgetExpiresAt && s.budgetExpiresAt > now() && s.reservedUsd + usd <= s.budgetUsd + 1e-9,
      );
      if (!live)
        throw new UserFacingError(
          `Estimated cost: $${usd.toFixed(4)} (about ${inputTokens.toLocaleString("en-US")} input tokens and up to ${maxOutputTokens.toLocaleString("en-US")} output tokens with ${model.label}). Enter ${usd.toFixed(4)} in "Confirm total", or allow a capped writing session for this Episode.`,
        );
      await guarded(() => writing.reserveBudget(data.project.id, live.id, usd, now()));
      confirmedUsd = usd;
      spendAuthorization = "session";
    }
  }
  const revisions = await (
    await getWritingRepo({ startInlineWorker: false })
  ).listRevisions(data.project.id, episode.id);
  const latest = revisions[0];
  const repo = await getShotListRepo();
  return guarded(async () =>
    repo.create({
      id: randomUUID(),
      projectId: data.project.id,
      episodeId: episode.id,
      sceneId: scene.id,
      parentId: parent?.id ?? null,
      scope,
      basePlan,
      episodeFingerprint: snap.episodeFingerprint,
      sceneFingerprint: snap.sceneFingerprint,
      baseRevisionId:
        latest && sourceFingerprint(canonical(latest.text)) === snap.episodeFingerprint ? latest.id : null,
      sceneText: snap.sceneText,
      context: snap.context,
      provider: model.provider,
      model: model.modelId,
      schemaVersion: SHOT_LIST_SCHEMA_VERSION,
      promptVersion: SHOT_PLANNER_PROMPT_VERSION,
      estimate: { inputTokens, maxOutputTokens, usd },
      confirmedUsd,
      spendAuthorization,
      createdBy: await actorId(),
      createdAt: now(),
    }),
  );
}

const planUrl = (data: ProjectData, scene: Scene, proposalId: string) =>
  `/projects/${data.project.slug}/episodes/${data.episodes.find((e) => e.id === scene.episodeId)!.slug}/scenes/${scene.id}/plan?proposal=${proposalId}`;

/** PLAN SHOTS WITH PRISM (or Re-plan Shots): a whole new list for the Scene's current screenplay. */
async function plan_impl(form: FormData) {
  const slug = str(form, "projectSlug");
  const data = await requireProjectFresh(slug);
  const { scene } = sceneOf(data, str(form, "sceneId"));
  const repo = await getShotListRepo();
  const latest = (await repo.listForScene(data.project.id, scene.id))[0] ?? null;
  const record = await queuePlan(form, data, scene, { kind: "full" }, latest);
  refresh(slug);
  redirect(planUrl(data, scene, record.id));
}

export async function planShotsWithPrism(form: FormData): Promise<ActionResult> {
  return runAction(() => plan_impl(form), { name: "planShotsWithPrism" });
}

async function loadReview(form: FormData) {
  const slug = str(form, "projectSlug");
  const data = await requireProjectFresh(slug);
  const repo = await getShotListRepo();
  const record = await repo.get(data.project.id, str(form, "proposalId"));
  if (!record) throw new UserFacingError("That shot list no longer exists.");
  const { scene, episode } = sceneOf(data, record.sceneId);
  if (record.status === "applied") throw new UserFacingError("This shot list was already applied.");
  if (record.status !== "ready" || !record.plan)
    throw new UserFacingError("This shot list is not ready yet.");
  const parent = record.parentId ? await repo.get(data.project.id, record.parentId) : null;
  const base = reviewOfShotList(record, parent)!;
  return {
    slug,
    data,
    repo,
    record,
    scene,
    episode,
    review: reviewFromForm(form, base, data, scene, record.plan),
  };
}

/** The review form → a review (only known items and fields; decisions only towards this Scene's Shots). */
function reviewFromForm(
  form: FormData,
  base: ShotListReview,
  data: ProjectData,
  scene: Scene,
  plan: NonNullable<ShotListProposal["plan"]>,
): ShotListReview {
  if (str(form, "reviewPresent") !== "1") return base;
  const sceneShots = new Set(data.shots.filter((s) => s.sceneId === scene.id).map((s) => s.id));
  return {
    version: 1,
    confirmReplace: str(form, "confirmReplace") === "on",
    items: base.items.map((it) => {
      // an edit is recorded only when it differs from what Prism proposed
      const proposed = plan.shots.find((s) => s.key === it.key);
      const edits: ShotListReview["items"][number]["edits"] = { ...it.edits };
      for (const f of SHOT_EDITABLE) {
        const v = form.get(`edit:${it.id}:${f}`);
        if (v == null) continue;
        const value = String(v).slice(0, 600);
        if (proposed && value === String(proposed[f])) delete edits[f];
        else edits[f] = value;
      }
      const decision = str(form, `decision:${it.id}`);
      return {
        ...it,
        selected: form.get(`include:${it.id}`) === "on",
        rejected: form.get(`reject:${it.id}`) === "on",
        edits,
        decision: sceneShots.has(decision) ? { kind: "replace", shotId: decision } : { kind: "create" },
      };
    }),
  };
}

/** APPLY: deterministic Prism Shots for exactly what the creator approved; the proposal then freezes. */
async function apply_impl(form: FormData): Promise<ActionResult> {
  const { slug, data, repo, record, scene, episode, review } = await loadReview(form);
  await guarded(() => repo.saveReview(data.project.id, record.id, review));
  const snap = sceneSnapshot(data, episode, scene);
  if (!snap || snap.sceneFingerprint !== record.sceneFingerprint)
    throw new UserFacingError(
      "The Scene's screenplay changed after Prism planned these Shots. Re-plan Shots for the current screenplay.",
    );
  const plan = planShotListApply({
    proposalId: record.id,
    proposalVersion: record.version,
    plan: record.plan!,
    review,
    context: record.context,
    data,
    scene,
    now: now(),
  });
  if (plan.errors.length) throw new UserFacingError(plan.errors.slice(0, 3).join(" "));
  const projectRepo = await getRepo();
  for (const s of [...plan.update, ...plan.create]) await projectRepo.upsert(data.project.id, "shots", s);
  await guarded(() =>
    repo.markApplied(
      data.project.id,
      record.id,
      {
        ...plan.summary,
        createdShotIds: plan.create.map((s) => s.id),
        replacedShotIds: plan.update.map((s) => s.id),
        codes: [...plan.update, ...plan.create].map((s) => s.shotCode),
      },
      now(),
    ),
  );
  refresh(slug);
  const s = plan.summary;
  return {
    ok: true,
    message: `Applied: ${s.created} Shot${s.created === 1 ? "" : "s"} created${s.replaced ? `, ${s.replaced} replaced in place` : ""}.`,
  };
}

/** The review form's buttons: Save, Apply, Select all / none, move, split, duplicate, regenerate one / all. */
async function submit_impl(form: FormData): Promise<ActionResult | void> {
  const intent = str(form, "intent");
  if (intent === "apply") return apply_impl(form);
  const { slug, data, repo, record, scene, review } = await loadReview(form);
  const [op, id = ""] = intent.split(":");
  if (op === "regen" || op === "regenerate_all") {
    await guarded(() => repo.saveReview(data.project.id, record.id, review));
    const scope: ShotPlanScope =
      op === "regen"
        ? {
            kind: "shot",
            key: review.items.find((i) => i.id === id)?.key ?? id,
            note: str(form, `regenNote:${id}`).slice(0, 400),
          }
        : { kind: "full" };
    const next = await queuePlan(form, data, scene, scope, record);
    refresh(slug);
    redirect(planUrl(data, scene, next.id));
  }
  let next = review;
  if (op === "up") next = moveItem(review, id, -1);
  else if (op === "down") next = moveItem(review, id, 1);
  else if (op === "split") next = splitItem(review, id, record.plan!);
  else if (op === "duplicate") next = duplicateItem(review, id);
  else if (op === "select_all" || op === "select_none")
    next = {
      ...review,
      items: review.items.map((i) => ({
        ...i,
        selected: op === "select_all",
        rejected: op === "select_all" ? false : i.rejected,
      })),
    };
  else if (op !== "save") throw new UserFacingError("Choose what to do with the shot list.");
  await guarded(() => repo.saveReview(data.project.id, record.id, next));
  refresh(slug);
  return { ok: true, message: op === "save" ? "Review saved" : "Updated" };
}

export async function submitShotListReview(form: FormData): Promise<ActionResult> {
  return runAction(() => submit_impl(form), { name: "submitShotListReview" });
}
