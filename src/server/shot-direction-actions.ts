"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ShotDirectionError, type ShotDirectionProposal } from "@/data/shot-direction-repository";
import { shotSchema, type ProjectData, type Shot } from "@/domain/schemas";
import {
  applyShotDirection,
  defaultDirectionReview,
  DIRECTION_SECTIONS,
  directionOutputTokens,
  EDITABLE_PATHS,
  getPath,
  SHOT_DIRECTION_SCHEMA_VERSION,
  shotDirectionFingerprint,
  shotSnapshot,
  type DirectionReview,
} from "@/domain/story/shot-direction";
import { estimateWritingInputTokens } from "@/domain/story/writing";
import { estimateUsd } from "@/story/provider";
import {
  SHOT_DIRECTOR_INSTRUCTIONS,
  SHOT_DIRECTOR_PROMPT_VERSION,
  shotDirectorInput,
} from "@/story/shot-director-prompt";
import { runAction, UserFacingError, type ActionResult } from "./action-result";
import { getRepo, requireProjectFresh } from "./repo";
import { actorId } from "./script-sync";
import { getShotDirectionRepo, getStoryRegistry } from "./story";
import { authorizeStorySpend, chooseStoryModel } from "./story-spend";

/**
 * Phase 5B-S5: approved Shot → Direct with Prism → Storyboard Direction Proposal → review → Apply Direction. The
 * actions QUEUE a direction (the Story worker calls the provider), keep the creator's review, and write ONLY what the
 * creator approved into the Shot's existing direction fields (`applyShotDirection`). The model never changes a Shot.
 */
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const refresh = (slug: string) => revalidatePath(`/projects/${slug}`, "layout");
const now = () => new Date().toISOString();

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ShotDirectionError) throw new UserFacingError(err.message);
    throw err;
  }
}

function shotOf(data: ProjectData, id: string): Shot {
  const shot = data.shots.find((s) => s.id === id && s.projectId === data.project.id);
  if (!shot) throw new UserFacingError("Choose one of this project's Shots.");
  return shot;
}

const directUrl = (data: ProjectData, shot: Shot, id: string) =>
  `/projects/${data.project.slug}/episodes/${data.episodes.find((e) => e.id === shot.episodeId)!.slug}/shots/${shot.id}/direct?proposal=${id}`;

/** Queue a direction for the Shot's CURRENT state (a plain proposal, a regeneration, or a creator's variant). */
async function queueDirection(
  form: FormData,
  data: ProjectData,
  shot: Shot,
  instruction: string,
  parent: ShotDirectionProposal | null,
): Promise<ShotDirectionProposal> {
  const snap = shotSnapshot(data, shot.id);
  if (!snap) throw new UserFacingError("This Shot's Scene is not in the Episode's screenplay.");
  const registry = getStoryRegistry();
  const model = chooseStoryModel(registry, str(form, "model"));
  const inputTokens = estimateWritingInputTokens(
    SHOT_DIRECTOR_INSTRUCTIONS,
    shotDirectorInput({ context: snap.context, instruction }),
  );
  const maxOutputTokens = directionOutputTokens(snap.context, model.maxOutputTokens || 32_000);
  const usd = estimateUsd(model, inputTokens, maxOutputTokens);
  const { confirmedUsd, spendAuthorization } = await authorizeStorySpend({
    form,
    registry,
    model,
    projectId: data.project.id,
    episodeId: shot.episodeId,
    usd,
    inputTokens,
    maxOutputTokens,
  });
  const repo = await getShotDirectionRepo();
  return guarded(async () =>
    repo.create({
      id: randomUUID(),
      projectId: data.project.id,
      episodeId: shot.episodeId,
      sceneId: shot.sceneId,
      shotId: shot.id,
      parentId: parent?.id ?? null,
      instruction: instruction.slice(0, 2000),
      sceneFingerprint: snap.sceneFingerprint,
      shotFingerprint: snap.shotFingerprint,
      context: snap.context,
      provider: model.provider,
      model: model.modelId,
      schemaVersion: SHOT_DIRECTION_SCHEMA_VERSION,
      promptVersion: SHOT_DIRECTOR_PROMPT_VERSION,
      estimate: { inputTokens, maxOutputTokens, usd },
      confirmedUsd,
      spendAuthorization,
      createdBy: await actorId(),
      createdAt: now(),
    }),
  );
}

/** DIRECT WITH PRISM: a direction proposal for the Shot (optionally "another approach" with a note). */
async function direct_impl(form: FormData) {
  const slug = str(form, "projectSlug");
  const data = await requireProjectFresh(slug);
  const shot = shotOf(data, str(form, "shotId"));
  const latest = (await (await getShotDirectionRepo()).listForShot(data.project.id, shot.id))[0] ?? null;
  const record = await queueDirection(form, data, shot, str(form, "instruction"), latest);
  refresh(slug);
  redirect(directUrl(data, shot, record.id));
}

export async function directShotWithPrism(form: FormData): Promise<ActionResult> {
  return runAction(() => direct_impl(form), { name: "directShotWithPrism" });
}

async function loadReview(form: FormData) {
  const slug = str(form, "projectSlug");
  const data = await requireProjectFresh(slug);
  const repo = await getShotDirectionRepo();
  const record = await repo.get(data.project.id, str(form, "proposalId"));
  if (!record) throw new UserFacingError("That direction no longer exists.");
  const shot = shotOf(data, record.shotId);
  if (record.status === "applied") throw new UserFacingError("This direction was already applied.");
  if (record.status !== "ready" || !record.direction)
    throw new UserFacingError("This direction is not ready yet.");
  const base = record.review ?? defaultDirectionReview();
  return { slug, data, repo, record, shot, review: reviewFromForm(form, base, record) };
}

/** The review form → a review (known sections, paths and Characters only; an edit only when it differs). */
function reviewFromForm(
  form: FormData,
  base: DirectionReview,
  record: ShotDirectionProposal,
): DirectionReview {
  if (str(form, "reviewPresent") !== "1") return base;
  const d = record.direction!;
  const edits: DirectionReview["edits"] = { ...base.edits };
  for (const path of EDITABLE_PATHS) {
    const v = form.get(`edit:${path}`);
    if (v == null) continue;
    const value = String(v).slice(0, 1200);
    if (value === getPath(d, path)) delete edits[path];
    else edits[path] = value;
  }
  const blockingEdits: DirectionReview["blockingEdits"] = structuredClone(base.blockingEdits);
  for (const b of d.blocking)
    for (const f of ["position", "facing", "eyeline"] as const) {
      const v = form.get(`block:${b.characterKey}:${f}`);
      if (v == null) continue;
      const value = String(v).slice(0, 600);
      blockingEdits[b.characterKey] ??= {};
      if (value === b[f]) delete blockingEdits[b.characterKey]![f];
      else blockingEdits[b.characterKey]![f] = value;
    }
  return {
    ...base,
    sections: Object.fromEntries(
      DIRECTION_SECTIONS.map((s) => [s, form.get(`section:${s}`) === "on"]),
    ) as DirectionReview["sections"],
    edits,
    blockingEdits,
  };
}

/** APPLY DIRECTION: the reviewed direction into the SAME Shot's existing fields; the proposal then freezes. */
async function apply_impl(form: FormData): Promise<ActionResult> {
  const { slug, data, repo, record, shot, review } = await loadReview(form);
  await guarded(() => repo.saveReview(data.project.id, record.id, review));
  if (review.rejected)
    throw new UserFacingError("This direction was rejected. Un-reject it or ask Prism again.");
  const snap = shotSnapshot(data, shot.id);
  if (
    !snap ||
    snap.sceneFingerprint !== record.sceneFingerprint ||
    snap.shotFingerprint !== record.shotFingerprint
  )
    throw new UserFacingError(
      "The Shot or its screenplay changed after Prism wrote this direction, so it can no longer be applied. Direct with Prism again.",
    );
  if (!DIRECTION_SECTIONS.some((s) => review.sections[s]))
    throw new UserFacingError("Accept at least one section to apply.");
  const updated = shotSchema.parse(
    applyShotDirection({
      shot,
      direction: record.direction!,
      review,
      context: record.context,
      proposalVersion: record.version,
      now: now(),
    }),
  );
  await (await getRepo()).upsert(data.project.id, "shots", updated);
  const after = { ...data, shots: data.shots.map((s) => (s.id === shot.id ? updated : s)) };
  await guarded(() =>
    repo.markApplied(
      data.project.id,
      record.id,
      {
        shotId: shot.id,
        sections: DIRECTION_SECTIONS.filter((s) => review.sections[s]),
        shotFingerprintAfter: shotDirectionFingerprint(after, updated),
        sceneFingerprint: record.sceneFingerprint,
      },
      now(),
    ),
  );
  refresh(slug);
  return { ok: true, message: `Direction v${record.version} applied to Shot ${shot.shotCode}.` };
}

/** The review form's buttons: Save, Apply, Reject / Un-reject, Save as alternate, Regenerate, Another approach. */
async function submit_impl(form: FormData): Promise<ActionResult | void> {
  const intent = str(form, "intent");
  if (intent === "apply") return apply_impl(form);
  const { slug, data, repo, record, shot, review } = await loadReview(form);
  if (intent === "regenerate" || intent === "variant") {
    await guarded(() => repo.saveReview(data.project.id, record.id, review));
    const note = intent === "variant" ? str(form, "variantNote") : record.instruction;
    if (intent === "variant" && !note)
      throw new UserFacingError("Describe the other approach (for example: more intimate).");
    const next = await queueDirection(form, data, shot, note, record);
    refresh(slug);
    redirect(directUrl(data, shot, next.id));
  }
  const next =
    intent === "reject"
      ? { ...review, rejected: true }
      : intent === "unreject"
        ? { ...review, rejected: false }
        : intent === "save_alternate"
          ? { ...review, savedAlternate: true }
          : intent === "save"
            ? review
            : null;
  if (!next) throw new UserFacingError("Choose what to do with the direction.");
  await guarded(() => repo.saveReview(data.project.id, record.id, next));
  refresh(slug);
  return {
    ok: true,
    message:
      intent === "reject"
        ? "Rejected — the Shot is unchanged."
        : intent === "save_alternate"
          ? "Saved as an alternate (not applied)."
          : "Review saved",
  };
}

export async function submitDirectionReview(form: FormData): Promise<ActionResult> {
  return runAction(() => submit_impl(form), { name: "submitDirectionReview" });
}
