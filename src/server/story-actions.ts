"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { StoryProposalError, type StoryProposalRecord } from "@/data/story-repository";
import { assetSchema, type ProjectData } from "@/domain/schemas";
import { planApply } from "@/domain/story/apply";
import { PROPOSAL_SCHEMA_VERSION } from "@/domain/story/proposal";
import {
  EDITABLE,
  ITEM_KINDS,
  MATCH_DECISIONS,
  MAX_EDIT,
  type ItemKind,
  type MatchDecision,
  type ProposalReview,
} from "@/domain/story/review";
import {
  MAX_SOURCE_CHARS,
  estimateInputTokens,
  lineCount,
  normalizeSourceText,
  sourceFingerprint,
  type PageMap,
  type StorySourceKind,
} from "@/domain/story/source";
import { buildObjectPath } from "@/lib/storage-paths";
import { extractStoryText, STORY_UPLOAD_MAX_BYTES } from "@/story/extract";
import { PROPOSAL_SECTIONS, STORY_PROMPT_VERSION, type ProposalSection } from "@/story/prompt";
import { estimateUsd } from "@/story/provider";
import { runAction, UserFacingError, type ActionResult } from "./action-result";
import { requireUser } from "./auth";
import { getRepo, requireProjectFresh } from "./repo";
import { checksum, getUploadStorage, storageForAsset } from "./storage";
import { getStoryRegistry, getStoryRepo } from "./story";
import { reviewOf } from "./story-review";

/**
 * Phase 5B-S1: Import Story → Production Proposal → review → Apply selected. These actions QUEUE an analysis (the
 * Story worker calls the provider), keep the creator's review, and apply ONLY what the creator selected through
 * deterministic code (`planApply`). The model never writes Prism records. Nothing is applied automatically.
 */
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const refresh = (slug: string) => revalidatePath(`/projects/${slug}`, "layout");
const now = () => new Date().toISOString();

interface FrozenSource {
  kind: StorySourceKind;
  text: string;
  assetId: string | null;
  episodeId: string | null;
  meta: StoryProposalRecord["sourceMeta"];
}

function chooseModel(form: FormData) {
  const registry = getStoryRegistry();
  const [provider = "", modelId = ""] = str(form, "model").split("/");
  const model = registry.model(provider, modelId);
  if (!model) throw new UserFacingError("Choose a Prism AI model.");
  const listed = registry.models().find((m) => m.provider === provider && m.modelId === modelId);
  if (!listed?.available) throw new UserFacingError(listed?.reason ?? "That model is not available.");
  return { registry, model };
}

/** Prices the request and enforces the explicit confirmation for a paid model (nothing silently spends). */
function priced(form: FormData, text: string) {
  const { registry, model } = chooseModel(form);
  const inputTokens = estimateInputTokens(text);
  if (inputTokens + model.maxOutputTokens > model.contextTokens)
    throw new UserFacingError(
      `This text is too long for ${model.label} (about ${inputTokens.toLocaleString("en-US")} tokens). Analyse a part of it.`,
    );
  const usd = estimateUsd(model, inputTokens);
  let confirmedUsd: number | null = null;
  if (model.paid) {
    if (usd > registry.spend.maxUsd)
      throw new UserFacingError(
        `The estimated cost ($${usd.toFixed(4)}) is over this server's limit ($${registry.spend.maxUsd.toFixed(2)}).`,
      );
    const confirmed = Number(str(form, "confirmedTotalUsd"));
    if (!str(form, "confirmedTotalUsd") || !Number.isFinite(confirmed) || confirmed + 1e-9 < usd)
      throw new UserFacingError(
        `Estimated cost: $${usd.toFixed(4)} (about ${inputTokens.toLocaleString("en-US")} input tokens and up to ${model.maxOutputTokens.toLocaleString("en-US")} output tokens with ${model.label}). Enter ${usd.toFixed(4)} in "Confirm total" to analyse.`,
      );
    confirmedUsd = confirmed;
  }
  return { model, estimate: { inputTokens, maxOutputTokens: model.maxOutputTokens, usd }, confirmedUsd };
}

async function frozenSource(form: FormData, data: ProjectData, userId: string): Promise<FrozenSource> {
  const mode = str(form, "sourceMode");
  const meta = (text: string, extra: Partial<FrozenSource["meta"]> = {}): FrozenSource["meta"] => ({
    filename: null,
    mime: null,
    byteSize: null,
    checksum: null,
    fileKind: null,
    pages: null,
    lineCount: lineCount(text),
    chars: text.length,
    ...extra,
  });
  const bounded = (text: string) => {
    if (!text) throw new UserFacingError("There is no text to analyse.");
    if (text.length > MAX_SOURCE_CHARS)
      throw new UserFacingError("The text is too long (limit 1.5 million characters).");
    return text;
  };
  if (mode === "paste") {
    const text = bounded(normalizeSourceText(String(form.get("text") ?? "")));
    return { kind: "paste", text, assetId: null, episodeId: null, meta: meta(text, { fileKind: "paste" }) };
  }
  if (mode === "episode") {
    const episode = data.episodes.find((e) => e.id === str(form, "episodeId"));
    if (!episode) throw new UserFacingError("Choose one of this project's Episodes.");
    const text = bounded(normalizeSourceText(episode.scriptText));
    return {
      kind: "episode_script",
      text,
      assetId: null,
      episodeId: episode.id,
      meta: meta(text, { fileKind: "episode_script" }),
    };
  }
  if (mode === "asset") {
    // re-analyse an earlier uploaded document of THIS project (never another project's)
    const asset = data.assets.find((a) => a.id === str(form, "assetId") && a.projectId === data.project.id);
    if (!asset || asset.type !== "document" || !asset.objectPath)
      throw new UserFacingError("That document is not one of this project's sources.");
    const storage = await storageForAsset(asset);
    const bytes = storage ? await storage.get(asset.objectPath) : null;
    if (!bytes) throw new UserFacingError("That document's file is missing.");
    const ex = extractStoryText(asset.originalFilename || asset.name, bytes);
    if (!ex.ok) throw new UserFacingError(ex.reason);
    const text = bounded(ex.text);
    return {
      kind: "upload",
      text,
      assetId: asset.id,
      episodeId: null,
      meta: meta(text, {
        filename: asset.originalFilename,
        mime: asset.mime,
        byteSize: asset.byteSize,
        checksum: asset.checksum,
        fileKind: ex.kind,
        pages: ex.pages,
      }),
    };
  }
  if (mode === "upload") {
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) throw new UserFacingError("Choose a file to upload.");
    if (file.size > STORY_UPLOAD_MAX_BYTES) throw new UserFacingError("The file is too large (limit 10 MB).");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const ex = extractStoryText(file.name, bytes);
    if (!ex.ok) throw new UserFacingError(ex.reason);
    const text = bounded(ex.text);
    // the original file becomes an immutable project Asset (never deleted after extraction)
    const id = randomUUID();
    const objectPath = buildObjectPath(data.project.id, id, file.name);
    const storage = await getUploadStorage();
    await storage.put(objectPath, bytes, ex.mime);
    const stamp = now();
    const asset = assetSchema.parse({
      id,
      projectId: data.project.id,
      createdBy: userId,
      type: "document",
      purpose: "document",
      source: "upload",
      name: file.name,
      originalFilename: file.name,
      storageProvider: storage.name,
      bucket: storage.bucket,
      objectPath,
      mime: ex.mime,
      byteSize: bytes.length,
      checksum: checksum(bytes),
      width: null,
      height: null,
      durationMs: null,
      frameRate: null,
      sampleRate: null,
      channels: null,
      tags: ["story-source"],
      notes: "Story source (Import Story)",
      metadata: { storySource: { fileKind: ex.kind, pages: ex.pages?.length ?? null } },
      createdAt: stamp,
      updatedAt: stamp,
    });
    await (await getRepo()).upsert(data.project.id, "assets", asset);
    return {
      kind: "upload",
      text,
      assetId: asset.id,
      episodeId: null,
      meta: meta(text, {
        filename: file.name,
        mime: ex.mime,
        byteSize: bytes.length,
        checksum: asset.checksum,
        fileKind: ex.kind,
        pages: ex.pages as PageMap | null,
      }),
    };
  }
  throw new UserFacingError("Paste a script, upload a file or choose an Episode script.");
}

async function analyzeStory_impl(form: FormData) {
  const slug = str(form, "projectSlug");
  const user = await requireUser();
  const data = await requireProjectFresh(slug);
  // price and confirm BEFORE storing anything (a refused confirmation stores no file)
  const preview =
    str(form, "sourceMode") === "paste"
      ? normalizeSourceText(String(form.get("text") ?? ""))
      : str(form, "sourceMode") === "episode"
        ? normalizeSourceText(data.episodes.find((e) => e.id === str(form, "episodeId"))?.scriptText ?? "")
        : null;
  if (preview !== null) priced(form, preview || " ");
  const source = await frozenSource(form, data, user.kind === "supabase" ? user.id : "local-user");
  const { model, estimate, confirmedUsd } = priced(form, source.text);
  const repo = await getStoryRepo();
  const record = await repo.create({
    id: randomUUID(),
    projectId: data.project.id,
    parentId: null,
    scope: { kind: "full" },
    sourceKind: source.kind,
    sourceAssetId: source.assetId,
    sourceEpisodeId: source.episodeId,
    sourceFingerprint: sourceFingerprint(source.text),
    sourceMeta: source.meta,
    inputText: source.text,
    title: str(form, "title").slice(0, 200) || null,
    baseProposal: null,
    provider: model.provider,
    model: model.modelId,
    schemaVersion: PROPOSAL_SCHEMA_VERSION,
    promptVersion: STORY_PROMPT_VERSION,
    estimate,
    confirmedUsd,
    createdBy: user.kind === "supabase" ? user.id : null,
    createdAt: now(),
  });
  refresh(slug);
  redirect(`/projects/${slug}/story/${record.id}`);
}

export async function analyzeStory(form: FormData): Promise<ActionResult> {
  return runAction(() => analyzeStory_impl(form), { name: "analyzeStory" });
}

/** Regenerate the whole proposal, or ONE section of it: always a NEW version (the earlier one is never changed). */
async function regenerate_impl(form: FormData) {
  const slug = str(form, "projectSlug");
  const user = await requireUser();
  const data = await requireProjectFresh(slug);
  const repo = await getStoryRepo();
  const parent = await repo.get(data.project.id, str(form, "proposalId"));
  if (!parent) throw new UserFacingError("That proposal no longer exists.");
  const section = str(form, "section");
  const isSection = (PROPOSAL_SECTIONS as readonly string[]).includes(section);
  if (isSection && !parent.proposal)
    throw new UserFacingError("Only a finished proposal can be revised by section.");
  const { model, estimate, confirmedUsd } = priced(form, parent.inputText);
  const record = await repo.create({
    id: randomUUID(),
    projectId: data.project.id,
    parentId: parent.id,
    scope: isSection
      ? { kind: "section", section: section as ProposalSection, note: str(form, "note").slice(0, 500) }
      : { kind: "full" },
    sourceKind: parent.sourceKind,
    sourceAssetId: parent.sourceAssetId,
    sourceEpisodeId: parent.sourceEpisodeId,
    sourceFingerprint: parent.sourceFingerprint,
    sourceMeta: parent.sourceMeta,
    inputText: parent.inputText,
    title: parent.title,
    baseProposal: isSection ? parent.proposal : null,
    provider: model.provider,
    model: model.modelId,
    schemaVersion: PROPOSAL_SCHEMA_VERSION,
    promptVersion: STORY_PROMPT_VERSION,
    estimate,
    confirmedUsd,
    createdBy: user.kind === "supabase" ? user.id : null,
    createdAt: now(),
  });
  refresh(slug);
  redirect(`/projects/${slug}/story/${record.id}`);
}

export async function regenerateProposal(form: FormData): Promise<ActionResult> {
  return runAction(() => regenerate_impl(form), { name: "regenerateProposal" });
}

/** Reads the review form: include / reject / match decision / edits per item, story edits, the target Episode. */
function reviewFromForm(
  form: FormData,
  record: StoryProposalRecord,
  base: ProposalReview,
  data: ProjectData,
) {
  const p = record.proposal!;
  const review: ProposalReview = structuredClone(base);
  const keys: Record<ItemKind, string[]> = {
    character: p.characters.map((x) => x.key),
    location: p.locations.map((x) => x.key),
    scene: p.scenes.map((x) => x.key),
    shot: p.shots.map((x) => x.key),
  };
  for (const kind of ITEM_KINDS)
    for (const key of keys[kind]) {
      const id = `${kind}:${key}`;
      const item = review.items[id] ?? { selected: true, rejected: false, edits: {}, match: null };
      item.selected = form.get(`include:${id}`) === "1";
      item.rejected = form.get(`reject:${id}`) === "1";
      for (const field of EDITABLE[kind]) {
        const v = form.get(`edit:${id}:${field}`);
        if (typeof v === "string") {
          const original = String(
            (p as unknown as Record<string, Array<Record<string, unknown>>>)[`${kind}s`]!.find(
              (x) => x.key === key,
            )?.[field] ?? "",
          );
          if (v.trim() && v !== original) item.edits[field] = v.slice(0, MAX_EDIT);
          else delete item.edits[field];
        }
      }
      const decision = str(form, `match:${id}`);
      if (item.match && decision)
        item.match.decision = (MATCH_DECISIONS as readonly string[]).includes(decision)
          ? (decision as MatchDecision)
          : null;
      review.items[id] = item;
    }
  for (const field of EDITABLE.story) {
    const v = form.get(`story:${field}`);
    if (typeof v === "string") {
      const original = String((p.story as Record<string, unknown>)[field] ?? "");
      if (v.trim() && v !== original) review.story[field] = v.slice(0, MAX_EDIT);
      else delete review.story[field];
    }
  }
  const target = str(form, "target");
  if (target === "new" || !target) review.target = { kind: "new_episode" };
  else if (data.episodes.some((e) => e.id === target))
    review.target = { kind: "existing_episode", episodeId: target };
  else throw new UserFacingError("Choose one of this project's Episodes.");
  return review;
}

async function loadReview(form: FormData) {
  const slug = str(form, "projectSlug");
  await requireUser();
  const data = await requireProjectFresh(slug);
  const repo = await getStoryRepo();
  const record = await repo.get(data.project.id, str(form, "proposalId"));
  if (!record) throw new UserFacingError("That proposal no longer exists.");
  if (record.status === "applied") throw new UserFacingError("This proposal was already applied.");
  if (record.status !== "ready" || !record.proposal)
    throw new UserFacingError("This proposal is not ready yet.");
  const parent = record.parentId ? await repo.get(data.project.id, record.parentId) : null;
  const base = (await reviewOf(record, data, parent))!;
  return { slug, data, repo, record, review: reviewFromForm(form, record, base, data) };
}

/** Repository refusals (already applied, not ready, gone) are shown to the creator as they are. */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof StoryProposalError) throw new UserFacingError(err.message);
    throw err;
  }
}

async function saveReview_impl(form: FormData) {
  const { slug, data, repo, record, review } = await loadReview(form);
  await guarded(() => repo.saveReview(data.project.id, record.id, review));
  refresh(slug);
}

export async function saveProposalReview(form: FormData): Promise<ActionResult> {
  return runAction(() => saveReview_impl(form), { name: "saveProposalReview" });
}

/** APPLY SELECTED: deterministic records for exactly what the creator selected; the proposal then freezes. */
async function apply_impl(form: FormData): Promise<ActionResult> {
  const { slug, data, repo, record, review } = await loadReview(form);
  await guarded(() => repo.saveReview(data.project.id, record.id, review));
  const plan = planApply({
    proposalId: record.id,
    proposal: record.proposal!,
    review,
    data,
    sourceText: record.inputText,
    sourceKind: record.sourceKind,
    now: now(),
  });
  if (plan.errors.length) throw new UserFacingError(plan.errors.slice(0, 3).join(" "));
  const projectRepo = await getRepo();
  const pid = data.project.id;
  for (const c of [...plan.characters.create, ...plan.characters.update])
    await projectRepo.upsert(pid, "characters", c);
  for (const l of [...plan.locations.create, ...plan.locations.update])
    await projectRepo.upsert(pid, "locations", l);
  if (plan.episode.create) await projectRepo.upsert(pid, "episodes", plan.episode.create);
  for (const s of plan.scenes) await projectRepo.upsert(pid, "scenes", s);
  for (const s of plan.shots) await projectRepo.upsert(pid, "shots", s);
  await guarded(() =>
    repo.markApplied(
      pid,
      record.id,
      {
        ...plan.summary,
        episodeId: plan.episode.id,
        episodeSlug:
          plan.episode.create?.slug ?? data.episodes.find((e) => e.id === plan.episode.id)?.slug ?? null,
        sceneIds: plan.scenes.map((s) => s.id),
        shotIds: plan.shots.map((s) => s.id),
      },
      now(),
    ),
  );
  refresh(slug);
  const s = plan.summary;
  return {
    ok: true,
    message: `Applied: ${s.charactersCreated} Characters, ${s.locationsCreated} Locations, ${s.scenes} Scenes, ${s.shots} Shots created${s.charactersReused + s.locationsReused ? ` (${s.charactersReused + s.locationsReused} existing reused)` : ""}.`,
  };
}

export async function applyProposal(form: FormData): Promise<ActionResult> {
  return runAction(() => apply_impl(form), { name: "applyProposal" });
}

/** The review form's buttons: Save review, Apply selected, Select all, Select none (one form, one action). */
async function submitReview_impl(form: FormData): Promise<ActionResult | void> {
  const intent = str(form, "intent");
  if (intent === "apply") return apply_impl(form);
  if (intent === "select_all" || intent === "select_none") {
    const { slug, data, repo, record, review } = await loadReview(form);
    for (const item of Object.values(review.items)) {
      item.selected = intent === "select_all";
      if (intent === "select_all") item.rejected = false;
    }
    await guarded(() => repo.saveReview(data.project.id, record.id, review));
    refresh(slug);
    return { ok: true, message: intent === "select_all" ? "Everything selected" : "Nothing selected" };
  }
  await saveReview_impl(form);
  return { ok: true, message: "Review saved" };
}

export async function submitProposalReview(form: FormData): Promise<ActionResult> {
  return runAction(() => submitReview_impl(form), { name: "submitProposalReview" });
}
