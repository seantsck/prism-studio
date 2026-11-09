"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { WritingError, type WritingProposal, type WritingSession } from "@/data/writing-repository";
import type { Episode, ProjectData } from "@/domain/schemas";
import { parseScreenplay } from "@/domain/script";
import { changedSceneIds, sceneRanges } from "@/domain/story/revisions";
import { sourceFingerprint } from "@/domain/story/source";
import {
  applyAlternative,
  canonical,
  estimateWritingInputTokens,
  LIMITS,
  lineOfOffset,
  looksLikeBrainstorm,
  requestedCount,
  scopeOf,
  SCOPE_KINDS,
  WRITING_PRESETS,
  WRITING_SCHEMA_VERSION,
  writingOutputTokens,
  type ScopeKind,
  type WritingMode,
  type WritingPreset,
  type WritingScope,
} from "@/domain/story/writing";
import { estimateUsd } from "@/story/provider";
import { buildWritingContext } from "@/story/writing-context";
import { WRITING_INSTRUCTIONS, WRITING_PROMPT_VERSION, writingInput } from "@/story/writing-prompt";
import { runAction, UserFacingError, type ActionResult } from "./action-result";
import { getRepo, requireProjectFresh } from "./repo";
import { actorId, syncEpisodeScript } from "./script-sync";
import { getStoryRegistry, getWritingRepo } from "./story";

/**
 * Phase 5B-S2: the AI writing assistant. Prism PROPOSES; the creator decides what becomes canon.
 *
 *   Ask Prism → a QUEUED Story Revision Proposal (the Story worker calls the provider) → the creator reviews the diff →
 *   Accept (a NEW immutable script revision becomes canonical; the old one stays recoverable) / Reject (nothing
 *   changes) / Revise again (a NEW proposal) / Save as alternate (a bookmark, never canon).
 *
 * The screenplay never changes except through Accept or Restore, and both go through the same structure sync as the
 * Script page. Brainstorms never change anything.
 */
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const refresh = (slug: string) => revalidatePath(`/projects/${slug}`, "layout");
const now = () => new Date().toISOString();
const usd4 = (n: number) => n.toFixed(4);

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof WritingError) throw new UserFacingError(err.message);
    throw err;
  }
}

function episodeOf(data: ProjectData, form: FormData): Episode {
  const episode = data.episodes.find((e) => e.id === str(form, "episodeId"));
  if (!episode) throw new UserFacingError("Choose one of this project's Episodes.");
  return episode;
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

/** The target of a request: a verified selection, a Scene, or the Episode (bounded). */
function resolveScope(form: FormData, data: ProjectData, episode: Episode, text: string): WritingScope {
  const kind = str(form, "scopeKind") as ScopeKind;
  if (!(SCOPE_KINDS as readonly string[]).includes(kind))
    throw new UserFacingError("Choose what Prism works on.");
  const ranges = sceneRanges(text, data, episode.id);
  if (kind === "episode") {
    if (text.length > LIMITS.episodeChars)
      throw new UserFacingError("This Episode is long. Choose a Scene or select a passage instead.");
    return scopeOf(text, "episode", { start: 0, end: text.length }, null);
  }
  if (kind === "scene") {
    const sceneId = str(form, "sceneId");
    const range = ranges.get(sceneId);
    if (!range) throw new UserFacingError("Choose one of this Episode's Scenes.");
    return scopeOf(text, "scene", range, sceneId);
  }
  const start = Number(str(form, "selStart"));
  const end = Number(str(form, "selEnd"));
  const selected = String(form.get("selText") ?? "").replace(/\r\n?/g, "\n");
  if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start || !selected.trim())
    throw new UserFacingError("Select some text first, or choose the Scene.");
  if (text.slice(start, end) !== selected)
    throw new UserFacingError("The screenplay changed since this page loaded. Reload and select again.");
  const inScene = [...ranges.entries()].find(([, r]) => start >= r.start && end <= r.end)?.[0] ?? null;
  return scopeOf(text, "selection", { start, end }, inScene);
}

async function sessionFor(form: FormData, data: ProjectData, episode: Episode): Promise<WritingSession> {
  const repo = await getWritingRepo();
  const id = str(form, "sessionId");
  if (id) {
    const s = await repo.getSession(data.project.id, id);
    if (!s || s.episodeId !== episode.id)
      throw new UserFacingError("That writing session is not of this Episode.");
    return s;
  }
  return guarded(() =>
    repo.createSession({
      id: randomUUID(),
      projectId: data.project.id,
      episodeId: episode.id,
      title: "",
      createdBy: null,
      createdAt: now(),
    }),
  );
}

function conversationOf(turns: WritingProposal[]) {
  return turns.map((t) => ({
    instruction: t.instruction,
    reply: t.result?.message ?? t.error?.message ?? "",
    chosen:
      t.acceptedAlternative != null ? (t.result?.alternatives[t.acceptedAlternative]?.text ?? null) : null,
  }));
}

/**
 * ASK PRISM: build the frozen request (target, instruction, textual context), price it, authorize the spend (explicit
 * confirmation or the session's capped allowance) and queue it. Nothing in the screenplay changes.
 */
async function ask_impl(form: FormData): Promise<ActionResult> {
  const actor = await actorId();
  const slug = str(form, "projectSlug");
  const data = await requireProjectFresh(slug);
  const episode = episodeOf(data, form);
  const text = canonical(episode.scriptText);
  const repo = await getWritingRepo();
  const session = await sessionFor(form, data, episode);
  const turns = await repo.listProposals(data.project.id, session.id);

  // Revise again / write a brainstorm idea: the parent fixes the target; a revised version becomes the DRAFT.
  const parentId = str(form, "parentId") || null;
  const parent = parentId ? (turns.find((t) => t.id === parentId) ?? null) : null;
  if (parentId && !parent) throw new UserFacingError("That proposal is not in this conversation.");
  const parentAlt =
    parent && str(form, "parentAlternative") !== "" ? Number(str(form, "parentAlternative")) : null;
  if (parent && parent.baseFingerprint !== sourceFingerprint(text))
    throw new UserFacingError(
      "The screenplay changed since that proposal. Select the passage again and ask Prism.",
    );

  const preset = (str(form, "preset") || "ask") as WritingPreset;
  const spec = WRITING_PRESETS[preset];
  if (!spec) throw new UserFacingError("Choose what Prism should do.");
  const typed = str(form, "instruction").slice(0, LIMITS.instruction);
  const instruction = typed || spec.instruction || "";
  if (!instruction)
    throw new UserFacingError(
      preset === "tone"
        ? "Describe the tone you want (for example: more restrained)."
        : "Type what you would like Prism to do.",
    );
  let mode: WritingMode = parent && parent.mode !== "brainstorm" ? parent.mode : spec.mode;
  if (parent?.mode === "brainstorm") mode = "rewrite";
  if (!parent && preset === "ask" && looksLikeBrainstorm(instruction)) mode = "brainstorm";
  if (mode === "brainstorm" && parent) mode = "rewrite";

  const scope = parent ? parent.scope : resolveScope(form, data, episode, text);
  const targetText = parent ? parent.targetText : text.slice(scope.start, scope.end);
  if (!targetText.trim() && mode !== "continue")
    throw new UserFacingError("There is no text there to work on.");
  const draftText =
    parent && parentAlt != null && parent.mode !== "brainstorm"
      ? (parent.result?.alternatives[parentAlt]?.text ?? null)
      : null;
  if (parent && parent.mode !== "brainstorm" && parentAlt != null && draftText == null)
    throw new UserFacingError("That version does not exist.");

  const count =
    mode === "brainstorm"
      ? Math.min(LIMITS.ideas, requestedCount(instruction, "ideas") ?? 5)
      : Math.min(
          LIMITS.alternatives,
          Math.max(
            1,
            requestedCount(instruction, "alternatives") ?? (Number(str(form, "alternatives")) || 1),
          ),
        );

  const context = buildWritingContext({
    data,
    episode,
    text,
    scope,
    instruction,
    conversation: conversationOf(turns),
  });

  // price it; nothing silently spends
  const { registry, model } = chooseModel(form);
  const promptText = writingInput({
    mode,
    instruction,
    count,
    scopeKind: scope.kind,
    context,
    targetText,
    draftText,
  });
  const inputTokens = estimateWritingInputTokens(WRITING_INSTRUCTIONS, promptText);
  const maxOutputTokens = writingOutputTokens(
    mode,
    count,
    targetText.length,
    model.maxOutputTokens || 32_000,
  );
  if (model.paid && inputTokens + maxOutputTokens > model.contextTokens)
    throw new UserFacingError("This request is too long for the model. Choose a Scene or a shorter passage.");
  const usd = estimateUsd(model, inputTokens, maxOutputTokens);
  let confirmedUsd: number | null = null;
  let spendAuthorization: WritingProposal["spendAuthorization"] = "free";
  let reserveUsd: number | null = null;
  if (model.paid) {
    if (usd > registry.spend.maxUsd)
      throw new UserFacingError(
        `The estimated cost ($${usd4(usd)}) is over this server's per-request limit ($${registry.spend.maxUsd.toFixed(2)}).`,
      );
    const confirmed = Number(str(form, "confirmedTotalUsd"));
    const sessionLive =
      session.budgetExpiresAt != null &&
      session.budgetExpiresAt > now() &&
      session.reservedUsd + usd <= session.budgetUsd + 1e-9;
    if (str(form, "confirmedTotalUsd") && Number.isFinite(confirmed) && confirmed + 1e-9 >= usd) {
      confirmedUsd = confirmed;
      spendAuthorization = "confirmed";
    } else if (sessionLive) {
      confirmedUsd = usd;
      spendAuthorization = "session";
      reserveUsd = usd;
    } else
      throw new UserFacingError(
        `Estimated cost: $${usd4(usd)} (about ${inputTokens.toLocaleString("en-US")} input tokens and up to ${maxOutputTokens.toLocaleString("en-US")} output tokens with ${model.label}). Enter ${usd4(usd)} in "Confirm total", or allow a capped writing session.`,
      );
  }

  const revisions = await repo.listRevisions(data.project.id, episode.id);
  const latest = revisions[0];
  const record = await guarded(() =>
    repo.createProposal(
      {
        id: randomUUID(),
        projectId: data.project.id,
        sessionId: session.id,
        episodeId: episode.id,
        parentId: parent?.id ?? null,
        parentAlternative: parent && draftText != null ? parentAlt : null,
        mode,
        scope,
        instruction,
        alternativesRequested: count,
        baseFingerprint: sourceFingerprint(text),
        baseRevisionId:
          latest && sourceFingerprint(canonical(latest.text)) === sourceFingerprint(text) ? latest.id : null,
        targetText,
        draftText,
        context,
        provider: model.provider,
        model: model.modelId,
        schemaVersion: WRITING_SCHEMA_VERSION,
        promptVersion: WRITING_PROMPT_VERSION,
        estimate: { inputTokens, maxOutputTokens, usd },
        confirmedUsd,
        spendAuthorization,
        createdBy: actor,
        createdAt: now(),
      },
      { reserveUsd, now: now() },
    ),
  ).catch((err: unknown) => {
    if (err instanceof UserFacingError && /allowance/.test(err.message))
      throw new UserFacingError(
        `${err.message} Estimated cost: $${usd4(usd)}. Enter ${usd4(usd)} in "Confirm total", or allow a new capped session.`,
      );
    throw err;
  });
  refresh(slug);
  if (!str(form, "sessionId"))
    redirect(
      `/projects/${slug}/episodes/${episode.slug}/write?session=${session.id}${scope.sceneId ? `&scene=${scope.sceneId}` : ""}`,
    );
  return {
    ok: true,
    message: record.mode === "brainstorm" ? "Prism is brainstorming…" : "Prism is writing a proposal…",
  };
}

export async function askPrism(form: FormData): Promise<ActionResult> {
  return runAction(() => ask_impl(form), { name: "askPrism" });
}

async function loadProposal(form: FormData) {
  const slug = str(form, "projectSlug");
  const data = await requireProjectFresh(slug);
  const repo = await getWritingRepo();
  const proposal = await repo.getProposal(data.project.id, str(form, "proposalId"));
  if (!proposal) throw new UserFacingError("That proposal no longer exists.");
  const episode = data.episodes.find((e) => e.id === proposal.episodeId);
  if (!episode) throw new UserFacingError("That Episode no longer exists.");
  return { slug, data, repo, proposal, episode };
}

/**
 * ACCEPT: the chosen version becomes canon as a NEW immutable script revision (the previous text is kept), Scenes with
 * production breakdown whose text changed are flagged, then the structure syncs exactly like a Script-page save.
 * Refused when the screenplay changed after Prism wrote the proposal (its range would no longer be the same text).
 */
async function accept_impl(form: FormData): Promise<ActionResult> {
  const actor = await actorId();
  const { slug, data, repo, proposal, episode } = await loadProposal(form);
  if (proposal.mode === "brainstorm")
    throw new UserFacingError("A brainstorm has no text to accept. Write one of its ideas first.");
  if (proposal.status === "accepted" || proposal.status === "rejected")
    throw new UserFacingError(`This proposal was already ${proposal.status}.`);
  if (proposal.status !== "ready" || !proposal.result)
    throw new UserFacingError("This proposal is not ready yet.");
  const index = Number(str(form, "alternative"));
  const alt = proposal.result.alternatives[index];
  if (!Number.isInteger(index) || !alt) throw new UserFacingError("Choose one of the versions.");
  const base = canonical(episode.scriptText);
  if (sourceFingerprint(base) !== proposal.baseFingerprint)
    throw new UserFacingError(
      "The screenplay changed after Prism wrote this proposal, so it can no longer be applied safely. Ask Prism again (your instruction is kept in the conversation).",
    );
  const next = applyAlternative(base, proposal.scope, proposal.mode, alt.text);
  const before = parseScreenplay(base).map((s) => s.slugline);
  const after = parseScreenplay(next.text).map((s) => s.slugline);
  if (proposal.mode !== "continue" && JSON.stringify(before) !== JSON.stringify(after))
    throw new UserFacingError(
      "This version would change the Episode's scene headings, so it cannot be accepted.",
    );
  const scenes = changedSceneIds(base, next.text, data, episode.id);
  const revision = await guarded(() =>
    repo.acceptProposal(data.project.id, proposal.id, index, {
      id: randomUUID(),
      projectId: data.project.id,
      episodeId: episode.id,
      origin: "ai_revision",
      text: next.text,
      fingerprint: sourceFingerprint(next.text),
      previousText: episode.scriptText,
      changedRange: {
        startLine: lineOfOffset(next.text, next.changedStart),
        endLine: lineOfOffset(next.text, Math.max(next.changedStart, next.changedEnd - 1)),
      },
      changedSceneIds: scenes.changed,
      flagSceneIds: scenes.withBreakdown,
      createdBy: actor,
      createdAt: now(),
    }),
  );
  await syncEpisodeScript(data, await getRepo(), episode, next.text);
  refresh(slug);
  return {
    ok: true,
    message: `Version ${alt.label} accepted — revision ${revision.number} is now the screenplay.${
      scenes.withBreakdown.length
        ? ` ${scenes.withBreakdown.length} Scene${scenes.withBreakdown.length === 1 ? "" : "s"} marked "Story changed after production breakdown".`
        : ""
    }`,
  };
}

export async function acceptWritingProposal(form: FormData): Promise<ActionResult> {
  return runAction(() => accept_impl(form), { name: "acceptWritingProposal" });
}

/** The proposal card's buttons: Accept (a version), Reject, Save as alternate. One form, one action. */
async function decide_impl(form: FormData): Promise<ActionResult> {
  const intent = str(form, "intent");
  if (intent === "accept") return accept_impl(form);
  const { slug, data, repo, proposal } = await loadProposal(form);
  if (intent === "reject") {
    await guarded(() => repo.rejectProposal(data.project.id, proposal.id, now()));
    refresh(slug);
    return { ok: true, message: "Rejected — the screenplay is unchanged." };
  }
  if (intent === "save") {
    const index = Number(str(form, "alternative"));
    await guarded(() => repo.saveAlternative(data.project.id, proposal.id, index));
    refresh(slug);
    return { ok: true, message: "Saved as an alternate (not part of the screenplay)." };
  }
  throw new UserFacingError("Choose Accept, Reject or Save as alternate.");
}

export async function decideWritingProposal(form: FormData): Promise<ActionResult> {
  return runAction(() => decide_impl(form), { name: "decideWritingProposal" });
}

/** RESTORE an earlier revision: a NEW revision with that text (history is never rewritten). */
async function restore_impl(form: FormData): Promise<ActionResult> {
  const actor = await actorId();
  const slug = str(form, "projectSlug");
  const data = await requireProjectFresh(slug);
  const episode = episodeOf(data, form);
  const repo = await getWritingRepo({ startInlineWorker: false });
  const old = await repo.getRevision(data.project.id, str(form, "revisionId"));
  if (!old || old.episodeId !== episode.id)
    throw new UserFacingError("That revision is not of this Episode.");
  if (old.text === episode.scriptText)
    return { ok: true, message: "That revision is already the screenplay." };
  const scenes = changedSceneIds(canonical(episode.scriptText), canonical(old.text), data, episode.id);
  const revision = await guarded(() =>
    repo.recordRevision({
      id: randomUUID(),
      projectId: data.project.id,
      episodeId: episode.id,
      origin: "restore",
      text: old.text,
      fingerprint: sourceFingerprint(old.text),
      previousText: episode.scriptText,
      restoredFromId: old.id,
      changedSceneIds: scenes.changed,
      flagSceneIds: scenes.withBreakdown,
      createdBy: actor,
      createdAt: now(),
    }),
  );
  await syncEpisodeScript(data, await getRepo(), episode, old.text);
  refresh(slug);
  return { ok: true, message: `Revision ${old.number} restored as revision ${revision.number}.` };
}

export async function restoreScriptRevision(form: FormData): Promise<ActionResult> {
  return runAction(() => restore_impl(form), { name: "restoreScriptRevision" });
}

/** "Story changed after production breakdown" → the creator reviewed the Scene's breakdown. */
async function reviewed_impl(form: FormData): Promise<ActionResult> {
  const slug = str(form, "projectSlug");
  const data = await requireProjectFresh(slug);
  const scene = data.scenes.find((s) => s.id === str(form, "sceneId"));
  if (!scene) throw new UserFacingError("That Scene no longer exists.");
  await guarded(async () =>
    (await getWritingRepo({ startInlineWorker: false })).markSceneReviewed(data.project.id, scene.id, now()),
  );
  refresh(slug);
  return { ok: true, message: "Marked as reviewed." };
}

export async function markSceneBreakdownReviewed(form: FormData): Promise<ActionResult> {
  return runAction(() => reviewed_impl(form), { name: "markSceneBreakdownReviewed" });
}

/** A new writing conversation on this Episode. */
async function newSession_impl(form: FormData) {
  const actor = await actorId();
  const slug = str(form, "projectSlug");
  const data = await requireProjectFresh(slug);
  const episode = episodeOf(data, form);
  const session = await guarded(async () =>
    (await getWritingRepo()).createSession({
      id: randomUUID(),
      projectId: data.project.id,
      episodeId: episode.id,
      title: "",
      createdBy: actor,
      createdAt: now(),
    }),
  );
  refresh(slug);
  redirect(`/projects/${slug}/episodes/${episode.slug}/write?session=${session.id}`);
}

export async function newWritingSession(form: FormData): Promise<ActionResult> {
  return runAction(() => newSession_impl(form), { name: "newWritingSession" });
}

/**
 * A CAPPED writing session: the creator allows up to $X (≤ the server's session cap) for a few hours, so small paid
 * rewrites need no per-request typing. Every request still carries its own estimate, is reserved against the cap
 * atomically, stays under the per-request ceiling, and is re-checked by the worker. Never unlimited.
 */
async function authorize_impl(form: FormData): Promise<ActionResult> {
  const slug = str(form, "projectSlug");
  const data = await requireProjectFresh(slug);
  const registry = getStoryRegistry();
  if (!registry.spend.paidEnabled) throw new UserFacingError("Paid Prism AI is switched off on this server.");
  const cap = registry.spend.sessionMaxUsd;
  const amount = Number(str(form, "amountUsd"));
  const hours = Number(str(form, "hours") || "2");
  if (!Number.isFinite(amount) || amount <= 0 || amount > cap)
    throw new UserFacingError(`Allow between $0.01 and $${cap.toFixed(2)} for this session.`);
  if (!Number.isFinite(hours) || hours < 0.25 || hours > 8)
    throw new UserFacingError("Choose between 15 minutes and 8 hours.");
  const s = await guarded(async () =>
    (await getWritingRepo()).authorizeBudget(
      data.project.id,
      str(form, "sessionId"),
      Math.round(amount * 1e6) / 1e6,
      new Date(Date.now() + hours * 3_600_000).toISOString(),
    ),
  );
  refresh(slug);
  return {
    ok: true,
    message: `This session may spend up to $${(s.budgetUsd - s.reservedUsd).toFixed(2)} more until ${new Date(s.budgetExpiresAt!).toLocaleTimeString("en-US")}.`,
  };
}

export async function authorizeWritingSession(form: FormData): Promise<ActionResult> {
  return runAction(() => authorize_impl(form), { name: "authorizeWritingSession" });
}
