"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  REFINE_NOTE_MAX,
  seasonPlanInstruction,
  seasonRefineInstruction,
  wholeScriptInstruction,
} from "@/domain/series-start";
import {
  BIBLE_AI_FIELDS,
  bibleAsText,
  bibleFieldValue,
  bibleDraftInstruction,
  bibleRefineInstruction,
  isBibleRequest,
  parseBibleIdeas,
} from "@/domain/bible-ai";
import { bibleSchema } from "@/domain/schemas";
import { runAction, UserFacingError, type ActionResult } from "./action-result";
import { getRepo, requireProjectFresh } from "./repo";
import { episodesToWrite, quoteBible, quoteSeasonPlan, quoteWriting, resolveWriter } from "./series-start";
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

/**
 * Plan the season (one idea per Episode), or, with a note, refine the current plan (Prism gets the plan and the note,
 * and returns the whole revised plan). Either is a brainstorm: the creator reviews it and uses it, or not.
 */
async function planSeason_impl(form: FormData) {
  const slug = str(form, "projectSlug");
  const data = await requireProjectFresh(slug);
  const note = str(form, "note").slice(0, REFINE_NOTE_MAX);
  const refine = str(form, "refine") === "1";
  if (refine && !note) throw new UserFacingError("Tell Prism what to change in the plan.");
  if (refine && !data.episodes.some((e) => e.synopsis.trim()))
    throw new UserFacingError("There is no plan to refine yet.");
  const q = quoteSeasonPlan(data, str(form, "model"), { refine });
  if (!q.ok) throw new UserFacingError(q.reason);
  confirmed(form, q.usd, q.paid);
  const first = [...data.episodes].sort((a, b) => a.number - b.number)[0]!;
  await queue({
    projectSlug: slug,
    episodeId: first.id,
    preset: "brainstorm",
    scopeKind: "episode",
    instruction: refine
      ? seasonRefineInstruction(data, data.episodes.length, note)
      : seasonPlanInstruction(data, data.episodes.length),
    model: q.model,
    ...(refine ? { withPlan: "1" } : {}),
    // the ceiling the creator confirmed; the request is priced again and accepted only within it
    ...(q.paid ? { confirmedTotalUsd: q.usd.toFixed(4) } : {}),
  });
  revalidatePath(`/projects/${slug}`, "layout");
  return {
    ok: true as const,
    message: refine ? "Prism is revising the plan…" : "Prism is planning the season…",
  };
}

/**
 * Draft the Bible with Prism (from the premise and the plan), or, with a note, refine it (Prism gets the Bible as it
 * stands). Either is a brainstorm whose ideas are the Bible's fields, reviewed field by field before anything changes.
 */
async function draftBible_impl(form: FormData) {
  const slug = str(form, "projectSlug");
  const data = await requireProjectFresh(slug);
  const refine = str(form, "refine") === "1";
  const note = str(form, "note").slice(0, REFINE_NOTE_MAX);
  if (refine && !note) throw new UserFacingError("Tell Prism what to change in the Bible.");
  const q = quoteBible(data, str(form, "model"), { refine });
  if (!q.ok) throw new UserFacingError(q.reason);
  confirmed(form, q.usd, q.paid);
  const first = [...data.episodes].sort((a, b) => a.number - b.number)[0]!;
  await queue({
    projectSlug: slug,
    episodeId: first.id,
    preset: "brainstorm",
    scopeKind: "episode",
    instruction: refine ? bibleRefineInstruction(data, note) : bibleDraftInstruction(data),
    model: q.model,
    withPlan: "1",
    ...(refine ? { withBible: "1" } : {}),
    ...(q.paid ? { confirmedTotalUsd: q.usd.toFixed(4) } : {}),
  });
  revalidatePath(`/projects/${slug}`, "layout");
  return {
    ok: true as const,
    message: refine ? "Prism is revising the Bible…" : "Prism is drafting the Bible…",
  };
}

/** Apply the fields of a Bible draft the creator ticked; everything else in the Bible stays as it is. */
async function applyBibleDraft_impl(form: FormData) {
  const slug = str(form, "projectSlug");
  const data = await requireProjectFresh(slug);
  const proposal = await (await getWritingRepo()).getProposal(data.project.id, str(form, "proposalId"));
  if (!proposal || !isBibleRequest(proposal.instruction) || proposal.status !== "ready" || !proposal.result)
    throw new UserFacingError("That Bible draft is not ready.");
  const proposed = parseBibleIdeas(proposal.result.ideas);
  const chosen = BIBLE_AI_FIELDS.filter(
    (f) => str(form, `use_${f.key}`) === "1" && proposed[f.key] !== undefined,
  );
  if (chosen.length === 0) throw new UserFacingError("Tick the fields you want to use.");
  const next = { ...data.bible, updatedAt: new Date().toISOString() };
  for (const f of chosen) (next as Record<string, unknown>)[f.key] = proposed[f.key];
  await (await getRepo()).saveBible(bibleSchema.parse(next));
  revalidatePath(`/projects/${slug}`, "layout");
  return { ok: true as const, message: `${chosen.length} field${chosen.length === 1 ? "" : "s"} applied.` };
}

/** Save the creator's own edits to the plan: each Episode's title and synopsis (scripts are untouched). */
async function saveSeasonPlan_impl(form: FormData) {
  const slug = str(form, "projectSlug");
  const data = await requireProjectFresh(slug);
  const repo = await getRepo();
  const now = new Date().toISOString();
  let changed = 0;
  for (const e of data.episodes) {
    if (!form.has(`title_${e.id}`)) continue;
    const title = str(form, `title_${e.id}`).slice(0, 120) || e.title;
    const synopsis = str(form, `synopsis_${e.id}`).slice(0, 2000);
    if (title === e.title && synopsis === e.synopsis) continue;
    await repo.upsert(data.project.id, "episodes", { ...e, title, synopsis, updatedAt: now });
    changed++;
  }
  revalidatePath(`/projects/${slug}`, "layout");
  return { ok: true as const, message: changed ? "Plan saved." : "Nothing changed." };
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

/** The titles and synopses typed in a plan editor, written to the Episodes (`touchAll`: stamp each even if unchanged). */
async function writePlan(form: FormData, slug: string, touchAll: boolean): Promise<number> {
  const data = await requireProjectFresh(slug);
  const repo = await getRepo();
  const now = new Date().toISOString();
  let changed = 0;
  for (const e of data.episodes) {
    if (!form.has(`title_${e.id}`)) continue;
    const title = str(form, `title_${e.id}`).slice(0, 120) || e.title;
    const synopsis = str(form, `synopsis_${e.id}`).slice(0, 2000);
    if (!touchAll && title === e.title && synopsis === e.synopsis) continue;
    await repo.upsert(data.project.id, "episodes", { ...e, title, synopsis, updatedAt: now });
    changed++;
  }
  return changed;
}

/**
 * The plan editor (the plan as the Episodes carry it, or Prism's newest plan to review, in the same fields):
 *  - save: what is in the fields becomes the plan (Prism's plan, as edited, or the creator's own);
 *  - refine: save it, then ask Prism to revise it with the note (Prism gets the plan as just saved);
 *  - keep: set Prism's plan aside and keep the Episodes' plan as it is.
 */
async function editSeasonPlan_impl(form: FormData) {
  const slug = str(form, "projectSlug");
  const intent = str(form, "intent") || "save";
  const proposalId = str(form, "proposalId");
  if (intent === "keep") {
    const data = await requireProjectFresh(slug);
    const p = proposalId ? await (await getWritingRepo()).getProposal(data.project.id, proposalId) : null;
    if (p && p.status === "ready")
      await (await getWritingRepo()).rejectProposal(data.project.id, p.id, new Date().toISOString());
    revalidatePath(`/projects/${slug}`, "layout");
    return { ok: true as const, message: "Kept your plan." };
  }
  const note = str(form, "note").slice(0, REFINE_NOTE_MAX);
  if (intent === "refine" && !note) throw new UserFacingError("Tell Prism what to change in the plan.");
  // saving Prism's plan uses it, even where a field was left as Prism wrote it
  const changed = await writePlan(form, slug, !!proposalId);
  if (intent !== "refine") {
    revalidatePath(`/projects/${slug}`, "layout");
    return { ok: true as const, message: changed ? "Plan saved." : "Nothing changed." };
  }
  const data = await requireProjectFresh(slug);
  if (!data.episodes.some((e) => e.synopsis.trim()))
    throw new UserFacingError("Write at least one episode's synopsis first, or plan the season with Prism.");
  const q = quoteSeasonPlan(data, str(form, "model"), { refine: true });
  if (!q.ok) throw new UserFacingError(q.reason);
  confirmed(form, q.usd, q.paid);
  const first = [...data.episodes].sort((a, b) => a.number - b.number)[0]!;
  await queue({
    projectSlug: slug,
    episodeId: first.id,
    preset: "brainstorm",
    scopeKind: "episode",
    instruction: seasonRefineInstruction(data, data.episodes.length, note),
    model: q.model,
    withPlan: "1",
    ...(q.paid ? { confirmedTotalUsd: q.usd.toFixed(4) } : {}),
  });
  revalidatePath(`/projects/${slug}`, "layout");
  return { ok: true as const, message: "Plan saved. Prism is revising it…" };
}

/**
 * Prism's Bible draft, reviewed in editable fields:
 *  - apply: the ticked fields, as edited, go into the Bible (everything else stays as it is);
 *  - refine: Prism revises the draft as it now reads (edits included) with the note; the Bible is unchanged;
 *  - discard: set the draft aside.
 */
async function reviewBible_impl(form: FormData) {
  const slug = str(form, "projectSlug");
  const intent = str(form, "intent") || "apply";
  const data = await requireProjectFresh(slug);
  const writing = await getWritingRepo();
  const proposal = await writing.getProposal(data.project.id, str(form, "proposalId"));
  if (!proposal || !isBibleRequest(proposal.instruction) || proposal.status !== "ready" || !proposal.result)
    throw new UserFacingError("That Bible draft is not ready.");
  const proposed = parseBibleIdeas(proposal.result.ideas);
  const shown = BIBLE_AI_FIELDS.filter((f) => proposed[f.key] !== undefined && form.has(`text_${f.key}`));

  if (intent === "discard") {
    await writing.rejectProposal(data.project.id, proposal.id, new Date().toISOString());
    revalidatePath(`/projects/${slug}`, "layout");
    return { ok: true as const, message: "Draft discarded." };
  }

  if (intent === "refine") {
    const note = str(form, "note").slice(0, REFINE_NOTE_MAX);
    if (!note) throw new UserFacingError("Tell Prism what to change in the draft.");
    const draft = bibleAsText(data.bible);
    for (const f of shown) draft[f.key] = String(form.get(`text_${f.key}`) ?? "").slice(0, 1500);
    const q = quoteBible(data, str(form, "model"), { refine: true });
    if (!q.ok) throw new UserFacingError(q.reason);
    confirmed(form, q.usd, q.paid);
    const first = [...data.episodes].sort((a, b) => a.number - b.number)[0]!;
    await queue({
      projectSlug: slug,
      episodeId: first.id,
      preset: "brainstorm",
      scopeKind: "episode",
      instruction: bibleRefineInstruction(data, note),
      model: q.model,
      withPlan: "1",
      withBible: "1",
      bibleDraft: JSON.stringify(draft),
      ...(q.paid ? { confirmedTotalUsd: q.usd.toFixed(4) } : {}),
    });
    revalidatePath(`/projects/${slug}`, "layout");
    return { ok: true as const, message: "Prism is revising the draft…" };
  }

  const chosen = shown.filter((f) => str(form, `use_${f.key}`) === "1");
  if (chosen.length === 0) throw new UserFacingError("Tick the fields you want to use.");
  const next = { ...data.bible, updatedAt: new Date().toISOString() };
  for (const f of chosen)
    (next as Record<string, unknown>)[f.key] = bibleFieldValue(
      f.key,
      String(form.get(`text_${f.key}`) ?? ""),
    );
  await (await getRepo()).saveBible(bibleSchema.parse(next));
  revalidatePath(`/projects/${slug}`, "layout");
  return { ok: true as const, message: `${chosen.length} field${chosen.length === 1 ? "" : "s"} applied.` };
}

/** Write one Episode, every unwritten Episode, or the whole film: one request each, reviewed on its Write page. */
async function writeWhole_impl(form: FormData) {
  const slug = str(form, "projectSlug");
  const data = await requireProjectFresh(slug);
  // the episodes picked (ids), else "all" or "one"
  const picked = str(form, "episodeIds")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const scope = picked.length ? picked : str(form, "scope") === "all" ? "all" : "one";
  if (picked.length && episodesToWrite(data, picked).length !== new Set(picked).size)
    throw new UserFacingError("One of the episodes picked has a script already, or is not in this project.");
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

export async function draftBible(form: FormData): Promise<ActionResult> {
  return runAction(() => draftBible_impl(form), { name: "draftBible" });
}

export async function applyBibleDraft(form: FormData): Promise<ActionResult> {
  return runAction(() => applyBibleDraft_impl(form), { name: "applyBibleDraft" });
}

export async function saveSeasonPlan(form: FormData): Promise<ActionResult> {
  return runAction(() => saveSeasonPlan_impl(form), { name: "saveSeasonPlan" });
}

export async function applySeasonPlan(form: FormData): Promise<ActionResult> {
  return runAction(() => applySeasonPlan_impl(form), { name: "applySeasonPlan" });
}

export async function editSeasonPlan(form: FormData): Promise<ActionResult> {
  return runAction(() => editSeasonPlan_impl(form), { name: "editSeasonPlan" });
}

export async function reviewBible(form: FormData): Promise<ActionResult> {
  return runAction(() => reviewBible_impl(form), { name: "reviewBible" });
}

export async function writeWhole(form: FormData): Promise<ActionResult> {
  return runAction(() => writeWhole_impl(form), { name: "writeWhole" });
}
