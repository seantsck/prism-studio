"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { seasonPlanInstruction, wholeScriptInstruction } from "@/domain/series-start";
import { runAction, UserFacingError, type ActionResult } from "./action-result";
import { getRepo, requireProjectFresh } from "./repo";
import { quoteSeasonPlan, quoteWriting, resolveWriter } from "./series-start";
import { getWritingRepo } from "./story";
import { askPrism } from "./writing-actions";

/**
 * The start page's AI steps. Each is priced the same way as it is shown, and refuses unless the creator confirmed at
 * least that amount; each queues ordinary writing requests (reviewed and accepted on the Write page, never applied
 * here).
 */

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

/** Every request a step queues goes through the writing assistant's own action and checks, without its redirect. */
async function queue(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  f.set("noRedirect", "1");
  const r = await askPrism(f);
  if (!r.ok) throw new UserFacingError(r.error);
}

function confirmed(form: FormData, usd: number, paid: boolean) {
  if (!paid) return;
  const c = Number(str(form, "confirmedTotalUsd"));
  if (!str(form, "confirmedTotalUsd") || !Number.isFinite(c) || c + 1e-9 < usd)
    throw new UserFacingError(`This costs up to $${usd.toFixed(4)}. Confirm that amount to go ahead.`);
}

/** Plan the season: one idea per Episode (a brainstorm; the creator then uses the plan or asks again). */
async function planSeason_impl(form: FormData) {
  const slug = str(form, "projectSlug");
  const data = await requireProjectFresh(slug);
  const q = quoteSeasonPlan(data, str(form, "model"));
  if (!q.ok) throw new UserFacingError(q.reason);
  confirmed(form, q.usd, q.paid);
  const first = [...data.episodes].sort((a, b) => a.number - b.number)[0]!;
  await queue({
    projectSlug: slug,
    episodeId: first.id,
    preset: "brainstorm",
    scopeKind: "episode",
    instruction: seasonPlanInstruction(data, data.episodes.length),
    model: q.model,
    ...(q.paid ? { confirmedTotalUsd: q.usd.toFixed(4) } : {}),
  });
  revalidatePath(`/projects/${slug}`, "layout");
  return { ok: true as const, message: "Prism is planning the season…" };
}

/** Use a plan: each idea becomes an Episode's title and synopsis (Episodes are added when the plan has more). */
async function applySeasonPlan_impl(form: FormData) {
  const slug = str(form, "projectSlug");
  const data = await requireProjectFresh(slug);
  const proposal = await (await getWritingRepo()).getProposal(data.project.id, str(form, "proposalId"));
  if (!proposal || proposal.mode !== "brainstorm" || proposal.status !== "ready" || !proposal.result)
    throw new UserFacingError("That plan is not ready.");
  const ideas = proposal.result.ideas;
  const repo = await getRepo();
  const episodes = [...data.episodes].sort((a, b) => a.number - b.number);
  const now = new Date().toISOString();
  for (const [i, idea] of ideas.entries()) {
    const e = episodes[i];
    if (!e) continue; // the plan was for the Episodes the project has
    await repo.upsert(data.project.id, "episodes", {
      ...e,
      title: idea.title.replace(/^\s*(episode\s*\d+\s*[:.\-–]\s*)/i, "").slice(0, 120) || e.title,
      synopsis: idea.detail.slice(0, 2000),
      updatedAt: now,
    });
  }
  revalidatePath(`/projects/${slug}`, "layout");
  return { ok: true as const, message: "The plan is in your Episodes." };
}

/** Write one Episode, every unwritten Episode, or the whole film: one request each, reviewed on its Write page. */
async function writeWhole_impl(form: FormData) {
  const slug = str(form, "projectSlug");
  const data = await requireProjectFresh(slug);
  const scope = str(form, "scope") === "all" ? "all" : "one";
  const writer = resolveWriter(str(form, "model"));
  if (!writer) throw new UserFacingError("Prism's writing AI is switched off on this server.");
  const q = quoteWriting(data, scope, writer.writer.value);
  if (!q.ok) throw new UserFacingError(q.reason);
  confirmed(form, q.usd, q.paid);
  for (const e of q.episodes) {
    const episode = data.episodes.find((x) => x.id === e.id)!;
    await queue({
      projectSlug: slug,
      episodeId: e.id,
      preset: "continue",
      scopeKind: "episode",
      length: "whole",
      instruction: wholeScriptInstruction(data, episode),
      model: q.model,
      ...(q.paid ? { confirmedTotalUsd: e.usd.toFixed(4) } : {}),
    });
  }
  revalidatePath(`/projects/${slug}`, "layout");
  redirect(`/projects/${slug}/start`);
}

export async function planSeason(form: FormData): Promise<ActionResult> {
  return runAction(() => planSeason_impl(form), { name: "planSeason" });
}

export async function applySeasonPlan(form: FormData): Promise<ActionResult> {
  return runAction(() => applySeasonPlan_impl(form), { name: "applySeasonPlan" });
}

export async function writeWhole(form: FormData): Promise<ActionResult> {
  return runAction(() => writeWhole_impl(form), { name: "writeWhole" });
}
