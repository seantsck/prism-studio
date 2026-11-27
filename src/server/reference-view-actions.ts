"use server";

import { revalidatePath } from "next/cache";
import { isGenerationSubmitError } from "@/data/generation-repository";
import { userPrice } from "@/domain/pricing/user-price";
import { runAction, UserFacingError, type ActionResult } from "./action-result";
import { requireUser } from "./auth";
import { getGenerationRepo } from "./generation";
import { requireProjectFresh } from "./repo";
import { hasOwnPhotos, prepareReferenceView } from "./reference-views";
import { VIEWS_KEY_PREFIX, viewSlots } from "./auto-add-views";

/**
 * Make one reference view, or several, from a Character's page (src/server/reference-views.ts). The
 * views are priced again here, exactly as they were shown; the creator's confirmed total must cover that, or nothing
 * starts. All of them are prepared before any is queued, so a refusal starts none. The project runs only so many
 * generations at once: the views that do not fit are returned as `waiting` (not started, not charged) and the page
 * sends them again as slots free up. Each view is its own ordinary
 * generation: a take in the Reference Studio, added to the set by the creator.
 */

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

async function makeReferenceViews_impl(form: FormData) {
  const slug = str(form, "projectSlug");
  const user = await requireUser();
  const data = await requireProjectFresh(slug);
  const character = data.characters.find((c) => c.id === str(form, "characterId"));
  if (!character) throw new UserFacingError("That actor is not in this project.");
  const viewIds = [...new Set(str(form, "views").split(",").filter(Boolean))];
  if (viewIds.length === 0) throw new UserFacingError("Choose which views to make.");
  // the same click twice (a double press, a retry) never makes the same views twice
  const batch = str(form, "batchId").slice(0, 64) || crypto.randomUUID();
  const userId = user.kind === "supabase" ? user.id : null;
  // a locked view keeps its picture: it is not made again
  const slots = viewSlots(data, character.id);
  const lockedView = viewIds.find((id) => slots[id]?.ref?.locked && slots[id]?.asset);
  if (lockedView)
    throw new UserFacingError(
      `The ${lockedView.replace("_", " ")} view is locked, so it is not made again. Unlock it first. Nothing was started.`,
    );
  // the engine the creator chose next to the views (Prism's suggestion when none was sent)
  const model = str(form, "model") || undefined;

  // With no photos, every other view is made from the front view. When the front is made in the same request, it goes
  // first and the others wait for THAT front (so they match it), then start from its picture.
  const generation = await getGenerationRepo();
  const fromFront = str(form, "fromFront");
  let fromFrontAssetId: string | null = null;
  if (fromFront) {
    const front = await generation.getSubjectImageAttempt(fromFront);
    if (!front || front.attempt.characterId !== character.id)
      throw new UserFacingError(
        "The front view these were waiting for no longer exists. Nothing was started.",
      );
    if (front.attempt.status === "succeeded") {
      fromFrontAssetId =
        (front.outputs.find((o) => o.output.role === "primary") ?? front.outputs[0])?.asset.id ?? null;
    } else if (["failed", "cancelled"].includes(front.attempt.status)) {
      throw new UserFacingError(
        "The front view did not finish, so the views waiting for it were not started. Nothing was charged for them.",
      );
    } else {
      const waitingForFront: ReferenceViewsResult = {
        ok: true,
        started: [],
        waiting: viewIds,
        afterFront: fromFront,
        message: "Waiting for the front view: the others are made from it once it is ready.",
      };
      return waitingForFront;
    }
  }
  const frontFirst =
    !fromFront && viewIds.includes("front") && viewIds.length > 1 && !(await hasOwnPhotos(data, character));
  const later = frontFirst ? viewIds.filter((v) => v !== "front") : [];

  // The right profile mirrors the left one: made in the same run, it waits for the left and is sent its picture.
  const fromLeft = str(form, "fromLeft");
  let fromLeftAssetId: string | null = null;
  let holdRight = false;
  if (!frontFirst && fromLeft && viewIds.includes("right_profile")) {
    const left = await generation.getSubjectImageAttempt(fromLeft);
    if (left && left.attempt.characterId === character.id) {
      if (left.attempt.status === "succeeded")
        fromLeftAssetId =
          (left.outputs.find((o) => o.output.role === "primary") ?? left.outputs[0])?.asset.id ?? null;
      else if (!["failed", "cancelled"].includes(left.attempt.status)) holdRight = true;
    }
  }
  const leftWithRight =
    !frontFirst && !fromLeft && viewIds.includes("profile") && viewIds.includes("right_profile");
  if (leftWithRight) holdRight = true;

  const prepared: Awaited<ReturnType<typeof prepareReferenceView>>[] = [];
  for (const id of (frontFirst ? ["front"] : viewIds).filter((v) => !(holdRight && v === "right_profile"))) {
    const p = await prepareReferenceView(
      data,
      character,
      id,
      userId,
      `${VIEWS_KEY_PREFIX}${batch}-${id}`,
      model,
      fromFrontAssetId,
      id === "right_profile" ? fromLeftAssetId : null,
    );
    if (!p.prepared.ok) throw new UserFacingError(`${p.view.label}: ${p.prepared.reasons[0]}`);
    prepared.push(p);
  }
  const paid = prepared.some((p) => p.paid);
  if (paid) {
    const total = prepared.reduce((s, p) => s + (p.prepared.ok ? (p.prepared.estimate.amount ?? NaN) : 0), 0);
    const confirmed = Number(str(form, "confirmedTotalUsd"));
    if (!Number.isFinite(total))
      throw new UserFacingError("The price of these views could not be worked out. Nothing was started.");
    if (!str(form, "confirmedTotalUsd") || !Number.isFinite(confirmed) || confirmed + 1e-9 < total)
      throw new UserFacingError(
        `The price is now ${`$${(userPrice(total) ?? 0).toFixed(2)}`}. Reload the page to see it, then confirm again. Nothing was started.`,
      );
  }
  const started: string[] = [];
  let frontAttemptId: string | null = null;
  let leftAttemptId: string | null = null;
  const waiting: string[] = [];
  let held: string | null = null;
  for (const p of prepared) {
    if (!p.prepared.ok) continue;
    if (held) {
      waiting.push(p.view.id);
      continue;
    }
    try {
      const created = await generation.createSubjectImageAttempt(p.prepared.input);
      started.push(p.view.id);
      if (p.view.id === "front") frontAttemptId = created.attempt.id;
      if (p.view.id === "profile") leftAttemptId = created.attempt.id;
    } catch (err) {
      if (!isGenerationSubmitError(err)) throw err;
      // the project's limit on generations running at once: the rest wait for a free slot, nothing is charged for them
      if (err.code === "project_busy" || err.code === "throttled") {
        held = err.message;
        waiting.push(p.view.id);
        continue;
      }
      throw new UserFacingError(err.message);
    }
  }
  // the views waiting for the new front: they start from it once it is ready (or with it, when it is held too)
  for (const id of later) waiting.push(id);
  if (holdRight) waiting.push("right_profile");
  const afterLeft = holdRight ? (leftAttemptId ?? (fromLeft || null)) : null;
  if (started.length) revalidatePath(`/projects/${slug}`, "layout");
  const label = (ids: string[]) =>
    ids.length === 1
      ? `the ${((l) => (l.endsWith("view") ? l : `${l} view`))((prepared.find((p) => p.view.id === ids[0])?.view.label ?? ids[0]!).toLowerCase())}`
      : `${ids.length} views`;
  const result: ReferenceViewsResult = {
    ok: true,
    started,
    waiting,
    ...(frontAttemptId && later.length ? { afterFront: frontAttemptId } : {}),
    ...(fromFront ? { afterFront: fromFront } : {}),
    ...(afterLeft ? { afterLeft } : {}),
    message:
      started.length === 0 && !held
        ? holdRight
          ? "The right profile waits for the left one and is made from it, so the two match."
          : "Waiting."
        : started.length === 0
          ? `Every slot is busy: ${label(waiting)} ${waiting.length === 1 ? "waits and starts" : "wait and start"} on their own as slots free up. Nothing is charged until each starts.`
          : `Making ${label(started)}` +
            (frontAttemptId && later.length
              ? `. The other ${later.length === 1 ? "view waits" : `${later.length} wait`} for it and ${later.length === 1 ? "is" : "are"} made from it, so the face matches; each is charged only when it starts.`
              : waiting.length
                ? `. ${waiting.length === 1 ? "One more waits" : `${waiting.length} more wait`} for a free slot and start on their own while this page is open; each is charged only when it starts.`
                : ". Each appears in the list as it finishes.") +
            (holdRight && started.length
              ? " The right profile waits for the left one, so the two match."
              : ""),
  };
  return result;
}

/** What starting views says: which views started now, and which wait for a free slot (not started, not charged). */
export type ReferenceViewsResult =
  | {
      ok: true;
      message: string;
      started: string[];
      waiting: string[];
      /** the front view the waiting views are made from (send it back as `fromFront`) */
      afterFront?: string;
      /** the left profile the waiting right profile mirrors (send it back as `fromLeft`) */
      afterLeft?: string;
    }
  | Exclude<ActionResult, { ok: true }>;

export async function makeReferenceViews(form: FormData): Promise<ReferenceViewsResult> {
  return (await runAction(() => makeReferenceViews_impl(form), {
    name: "makeReferenceViews",
  })) as ReferenceViewsResult;
}

/**
 * Stop the views being made on a Character's page: each in-flight view's generation is asked to stop (the same request
 * as "Cancel" on any generation). A view not yet sent to the engine is not charged; one the engine already took may
 * still be charged by it.
 */
async function stopReferenceViews_impl(form: FormData) {
  const slug = str(form, "projectSlug");
  await requireUser();
  const data = await requireProjectFresh(slug);
  const characterId = str(form, "characterId");
  if (!data.characters.some((c) => c.id === characterId))
    throw new UserFacingError("That actor is not in this project.");
  const generation = await getGenerationRepo();
  const attempts = await generation.listSubjectImageAttempts({ kind: "character", characterId });
  const wanted = new Set(form.getAll("jobId").map(String));
  const ACTIVE = new Set(["queued", "submitting", "submitted", "processing", "ingesting"]);
  let stopped = 0;
  for (const v of attempts) {
    if (!v.job || !wanted.has(v.job.id) || v.job.projectId !== data.project.id || !ACTIVE.has(v.job.status))
      continue;
    await generation.requestCancel(v.job.id, new Date().toISOString());
    stopped++;
  }
  revalidatePath(`/projects/${slug}`, "layout");
  return {
    ok: true as const,
    message: stopped
      ? `Stopping ${stopped === 1 ? "1 view" : `${stopped} views`}.`
      : "Nothing was being made any more.",
  };
}

export async function stopReferenceViews(form: FormData): Promise<ActionResult> {
  return runAction(() => stopReferenceViews_impl(form), { name: "stopReferenceViews" });
}
