"use server";

import { revalidatePath } from "next/cache";
import { GenerationSubmitError } from "@/data/generation-repository";
import { userPrice } from "@/domain/pricing/user-price";
import { runAction, UserFacingError, type ActionResult } from "./action-result";
import { requireUser } from "./auth";
import { getGenerationRepo } from "./generation";
import { requireProjectFresh } from "./repo";
import { prepareReferenceView } from "./reference-views";

/**
 * Make one reference view, or every view still missing, from a Character's page (src/server/reference-views.ts). The
 * views are priced again here, exactly as they were shown; the creator's confirmed total must cover that, or nothing
 * starts. All of them are prepared before any is queued, so a refusal starts none. Each view is its own ordinary
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

  const prepared = [];
  for (const id of viewIds) {
    const p = await prepareReferenceView(data, character, id, userId, `views-${batch}-${id}`);
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
  let held: string | null = null;
  for (const p of prepared) {
    if (!p.prepared.ok) continue;
    try {
      await generation.createSubjectImageAttempt(p.prepared.input);
      started.push(p.view.label);
    } catch (err) {
      if (!(err instanceof GenerationSubmitError)) throw err;
      // the project's limit on generations running at once: the rest wait, nothing is charged for them
      if (err.code === "project_busy" || err.code === "throttled") {
        held = err.message;
        break;
      }
      throw new UserFacingError(err.message);
    }
  }
  revalidatePath(`/projects/${slug}`, "layout");
  if (started.length === 0)
    throw new UserFacingError(
      `Nothing was started: ${held ?? "try again in a moment."} Nothing was charged.`,
    );
  const rest = prepared.length - started.length;
  return {
    ok: true as const,
    message:
      `Making ${started.length === 1 ? `the ${started[0]!.toLowerCase()} view` : `${started.length} views`}` +
      (rest
        ? `. The other ${rest} wait (${held}) and are not charged: press again once these finish.`
        : ". They appear in the Reference Studio as they finish."),
  };
}

export async function makeReferenceViews(form: FormData): Promise<ActionResult> {
  return runAction(() => makeReferenceViews_impl(form), { name: "makeReferenceViews" });
}
