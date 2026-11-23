"use server";

import { revalidatePath } from "next/cache";
import { isGenerationSubmitError } from "@/data/generation-repository";
import { userPrice } from "@/domain/pricing/user-price";
import { runAction, UserFacingError, type ActionResult } from "./action-result";
import { requireUser } from "./auth";
import { getGenerationRepo } from "./generation";
import { requireProjectFresh } from "./repo";
import { prepareReferenceView } from "./reference-views";
import { VIEWS_KEY_PREFIX } from "./auto-add-views";

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
  if (!character) throw new UserFacingError("That character is not in this project.");
  const viewIds = [...new Set(str(form, "views").split(",").filter(Boolean))];
  if (viewIds.length === 0) throw new UserFacingError("Choose which views to make.");
  // the same click twice (a double press, a retry) never makes the same views twice
  const batch = str(form, "batchId").slice(0, 64) || crypto.randomUUID();
  const userId = user.kind === "supabase" ? user.id : null;
  // the engine the creator chose next to the views (Prism's suggestion when none was sent)
  const model = str(form, "model") || undefined;

  const prepared: Awaited<ReturnType<typeof prepareReferenceView>>[] = [];
  for (const id of viewIds) {
    const p = await prepareReferenceView(
      data,
      character,
      id,
      userId,
      `${VIEWS_KEY_PREFIX}${batch}-${id}`,
      model,
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
  const generation = await getGenerationRepo();
  const started: string[] = [];
  const waiting: string[] = [];
  let held: string | null = null;
  for (const p of prepared) {
    if (!p.prepared.ok) continue;
    if (held) {
      waiting.push(p.view.id);
      continue;
    }
    try {
      await generation.createSubjectImageAttempt(p.prepared.input);
      started.push(p.view.id);
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
  if (started.length) revalidatePath(`/projects/${slug}`, "layout");
  const label = (ids: string[]) =>
    ids.length === 1
      ? `the ${(prepared.find((p) => p.view.id === ids[0])?.view.label ?? ids[0]!).toLowerCase()} view`
      : `${ids.length} views`;
  const result: ReferenceViewsResult = {
    ok: true,
    started,
    waiting,
    message:
      started.length === 0
        ? `Every slot is busy: ${label(waiting)} ${waiting.length === 1 ? "waits and starts" : "wait and start"} on their own as slots free up. Nothing is charged until each starts.`
        : `Making ${label(started)}` +
          (waiting.length
            ? `. ${waiting.length === 1 ? "One more waits" : `${waiting.length} more wait`} for a free slot and start on their own while this page is open; each is charged only when it starts.`
            : ". Each appears in the list as it finishes."),
  };
  return result;
}

/** What starting views says: which views started now, and which wait for a free slot (not started, not charged). */
export type ReferenceViewsResult =
  { ok: true; message: string; started: string[]; waiting: string[] } | Exclude<ActionResult, { ok: true }>;

export async function makeReferenceViews(form: FormData): Promise<ReferenceViewsResult> {
  return (await runAction(() => makeReferenceViews_impl(form), {
    name: "makeReferenceViews",
  })) as ReferenceViewsResult;
}
