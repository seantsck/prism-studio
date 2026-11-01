import { createHash } from "node:crypto";
import {
  analysisSpendBlockers,
  type AnalysisSpendPolicy,
  type CostEstimateUsd,
} from "@/domain/continuity/analysis/cost";
import {
  buildSequencePlan,
  sequenceInputSide,
  toSequenceCriterion,
  transitionInputProblem,
  NOT_CALIBRATED_SEQUENCE_REASON,
} from "@/domain/continuity/analysis/sequence-plan";
import { derivationKey } from "@/domain/framing/conform";
import type { MediaProcessor } from "@/media/types";
import {
  ANALYSIS_SCHEMA_VERSION,
  DEFAULT_ANALYSIS_BUDGET,
  SEQUENCE_RUBRIC_VERSION,
  type AnalysisMedia,
  type TransitionContinuityAnalysisInput,
} from "@/domain/continuity/analysis/types";
import { projectBudgetBlockers, type ProjectQaPolicy } from "@/domain/continuity/automation";
import {
  buildEpisodeCuts,
  CUT_EDGE_POLICY,
  type CutSide,
  type CutTransition,
  type TransitionRunTruth,
} from "@/domain/continuity/sequence";
import type { EpisodeEditView } from "@/domain/edit/view";
import type { Asset, ProjectData } from "@/domain/schemas";
import {
  MediaQaError,
  type DerivedAsset,
  type MediaQaRepository,
  type TransitionAnalysisJob,
  type TransitionRunView,
} from "@/data/media-qa-repository";
import { derive, readVerified, type DeliveryDeps } from "@/media/delivery";
import { inputAssetIdsOf } from "./analysis/prepare";
import type { ContinuityAnalysisProvider } from "./analysis/provider";
import { newTransitionRun } from "./sequence-runs";

/**
 * Phase 3A.4D: MANUAL semantic review of selected cuts (Sequence Continuity). Never automatic: a person selects actual
 * cuts of the persisted edit, reads the exact disclosure, and confirms. Then, in this order:
 *   1. the server re-reads the edit and rebuilds the cuts (stale browser truth is refused);
 *   2. the plan (per cut) proves which criteria may be analysed by THIS analyzer (calibration-gated families);
 *   3. media eligibility, the Project's consent (`direct_video_allowed`; external media for a model analyzer);
 *   4. the WHOLE batch's worst-case cost against the Project and global gates, before anything is spent;
 *   5. only then are the selected cuts' edge media derived (persisted Assets, reused by derivation key);
 *   6. each cut's run + subject + findings + job + estimate + event is frozen atomically and queued.
 * Nothing here calls an analyzer: the worker executes the frozen job. A page read derives nothing.
 */

/** Conservative manual batch bound (3A.4F adds automatic waves and Project batch caps). */
export const MAX_MANUAL_SEQUENCE_CUTS = 4;

export class SequenceReviewError extends Error {
  constructor(
    readonly code:
      | "no_selection"
      | "too_many"
      | "cut_changed"
      | "not_allowed"
      | "nothing_to_analyse"
      | "cost_unknown"
      | "cost_changed"
      | "transfer_changed"
      | "budget_blocked"
      | "needs_ack"
      | "media"
      | "limit",
    message: string,
  ) {
    super(message);
    this.name = "SequenceReviewError";
  }
}

// ───────────────────────── media (pending descriptors or derived Assets) ─────────────────────────

export interface EdgeAssets {
  clip: Asset;
  still: Asset;
}

const stillId = (side: "left" | "right") => (side === "left" ? "left:last" : "right:first");

/** A pending clip's size for the disclosure: proportional to the window, doubled for re-encoding headroom. */
function estimatedClipBytes(parent: Asset | undefined, windowMs: number): number | null {
  if (!parent?.byteSize || !parent.durationMs) return null;
  return Math.ceil(((parent.byteSize * windowMs) / parent.durationMs) * 2);
}

function sideMedia(args: {
  side: CutSide;
  which: "left" | "right";
  view: EpisodeEditView;
  assets: readonly Asset[];
  edge: EdgeAssets | null;
}): { media: AnalysisMedia[]; uses: Record<string, string[]> } {
  const { side, which, edge } = args;
  const p = side.picture;
  const uses: Record<string, string[]> = {};
  const media: AnalysisMedia[] = [];
  if (p.kind === "video" && side.window && side.still && p.assetChecksum) {
    const parent = args.assets.find((a) => a.id === p.assetId);
    const map = {
      policy: CUT_EDGE_POLICY.id,
      parentAssetId: p.assetId,
      parentChecksum: p.assetChecksum,
      sourceInMs: p.sourceInMs,
      itemEditStartMs: args.view.items[side.index]?.timing.startMs ?? 0,
    };
    const label = side.shotCode ?? "Shot";
    media.push({
      inputId: `${which}:clip`,
      kind: "video",
      role: "edge_clip",
      label: `${label} ${which === "left" ? "last" : "first"} ${side.window.durationMs} ms before/after the cut`,
      assetId: edge?.clip.id ?? `pending:${which}:clip`,
      checksum: edge ? edge.clip.checksum : `pending:${p.assetChecksum}`,
      mime: edge ? edge.clip.mime : (parent?.mime ?? null),
      width: edge ? edge.clip.width : (parent?.width ?? null),
      height: edge ? edge.clip.height : (parent?.height ?? null),
      byteSize: edge ? edge.clip.byteSize : estimatedClipBytes(parent, side.window.durationMs),
      durationMs: edge ? edge.clip.durationMs : side.window.durationMs,
      atMs: null,
      side: which,
      edge: { ...map, startMs: side.window.startMs, endMs: side.window.endMs },
    });
    media.push({
      inputId: stillId(which),
      kind: "output_frame",
      role: "edge_frame",
      label: `${label} ${which === "left" ? "last" : "first"} displayed frame`,
      assetId: edge?.still.id ?? `pending:${which}:still`,
      checksum: edge ? edge.still.checksum : `pending:${p.assetChecksum}`,
      mime: edge ? edge.still.mime : "image/png",
      width: edge ? edge.still.width : (parent?.width ?? null),
      height: edge ? edge.still.height : (parent?.height ?? null),
      byteSize: edge ? edge.still.byteSize : null,
      durationMs: null,
      atMs: side.still.atMs,
      side: which,
      edge: { ...map, startMs: side.still.atMs, endMs: side.still.atMs },
    });
  }
  const counters = new Map<string, number>();
  for (const r of side.references) {
    const a = r.assetId ? args.assets.find((x) => x.id === r.assetId) : undefined;
    if (!a || a.type !== "image" || !a.objectPath) continue;
    const n = (counters.get(r.role) ?? 0) + 1;
    counters.set(r.role, n);
    const inputId = `ref:${which}:${r.role}:${n}`;
    uses[inputId] = [...r.usedBy];
    media.push({
      inputId,
      kind: "reference",
      role: r.role,
      label: `${which} reference (${r.role.replace(/_/g, " ")})`,
      assetId: a.id,
      checksum: a.checksum,
      mime: a.mime,
      width: a.width,
      height: a.height,
      byteSize: a.byteSize,
      durationMs: null,
      atMs: null,
      side: which,
    });
  }
  return { media, uses };
}

export function cutMedia(args: {
  cut: CutTransition;
  view: EpisodeEditView;
  assets: readonly Asset[];
  edge: { left: EdgeAssets; right: EdgeAssets } | null;
}) {
  const l = sideMedia({ ...args, side: args.cut.left, which: "left", edge: args.edge?.left ?? null });
  const r = sideMedia({ ...args, side: args.cut.right, which: "right", edge: args.edge?.right ?? null });
  return { media: [...l.media, ...r.media], uses: { ...l.uses, ...r.uses } };
}

// ───────────────────────── frozen input + identity ─────────────────────────

export function buildTransitionInput(args: {
  cut: CutTransition;
  view: EpisodeEditView;
  data: ProjectData;
  provider: ContinuityAnalysisProvider;
  directVideoAllowed: boolean;
  edge: { left: EdgeAssets; right: EdgeAssets } | null;
  runKey: string;
}): TransitionContinuityAnalysisInput {
  const { cut, view, provider } = args;
  const { media, uses } = cutMedia({ cut, view, assets: args.data.assets, edge: args.edge });
  const plan = buildSequencePlan({
    analyzer: provider.plannerView(),
    criteria: cut.criteria,
    media,
    referenceUses: uses,
    directVideoAllowed: args.directVideoAllowed,
    budget: DEFAULT_ANALYSIS_BUDGET,
  });
  const calibration = provider.crossCutCalibration();
  return {
    version: 1,
    subjectKind: "transition",
    runKey: args.runKey,
    transition: {
      transitionKey: cut.transitionKey,
      editId: cut.address.editId,
      episodeId: view.edit.episodeId,
      editRevision: view.edit.revision,
      leftItemId: cut.address.leftItemId,
      rightItemId: cut.address.rightItemId,
      leftShotId: cut.left.shotId,
      rightShotId: cut.right.shotId,
      subjectFingerprint: cut.truth.subjectFingerprint,
      leftSubjectFingerprint: cut.truth.leftSubjectFingerprint,
      rightSubjectFingerprint: cut.truth.rightSubjectFingerprint,
      criteriaFingerprint: cut.truth.criteriaFingerprint,
      referenceFingerprint: cut.truth.referenceFingerprint,
      rulesVersion: cut.truth.rulesVersion,
    },
    edgePolicy: CUT_EDGE_POLICY.id,
    calibration: { version: calibration.version, acceptedFamilies: [...calibration.acceptedFamilies].sort() },
    criteria: cut.criteria.flatMap((c) => {
      const ac = toSequenceCriterion(c);
      return ac ? [ac] : [];
    }),
    media,
    framing: { productionAspectRatio: args.data.bible?.aspectRatio || null },
    analyzer: provider.id,
    analyzerVersion: provider.analysisVersion("sequence_transition") ?? "unsupported",
    model: provider.model,
    promptVersions: { sequence_transition: plan.batches[0]?.promptVersion ?? "" },
    rubricVersion: SEQUENCE_RUBRIC_VERSION,
    schemaVersion: ANALYSIS_SCHEMA_VERSION,
    plan,
  };
}

/**
 * sha256(transition truth | provider | sequence analyzer version | model | prompt | sequence rubric | cut-edge policy |
 * calibration version | accepted families | nonce). Never a timestamp: a retry of the SAME confirmed submission (same
 * nonce) replays; a fresh manual batch uses a fresh nonce.
 */
export function sequenceIdempotencyKey(
  truth: TransitionRunTruth,
  provider: ContinuityAnalysisProvider,
  promptVersion: string,
  nonce: string,
): string {
  const cal = provider.crossCutCalibration();
  return createHash("sha256")
    .update(
      [
        truth.transitionKey,
        truth.subjectFingerprint,
        truth.criteriaFingerprint,
        truth.referenceFingerprint,
        truth.rulesVersion,
        provider.id,
        provider.analysisVersion("sequence_transition") ?? "",
        provider.model,
        promptVersion,
        SEQUENCE_RUBRIC_VERSION,
        CUT_EDGE_POLICY.id,
        cal.version,
        [...cal.acceptedFamilies].sort().join(","),
        nonce,
      ].join("|"),
    )
    .digest("hex");
}

// ───────────────────────── disclosure (pure read: derives nothing) ─────────────────────────

export type EdgeTransfer = "inline" | "provider_file" | "not_sent";

export interface SideDisclosure {
  itemId: string;
  shotCode: string;
  sourceAssetId: string | null;
  sourceAssetName: string | null;
  /** the pinned source is not the Shot's currently selected delivery master */
  differsFromCurrentDelivery: boolean;
  window: { startMs: number; endMs: number; durationMs: number } | null;
  still: { atMs: number; frame: "last_displayed" | "first_displayed" } | null;
  references: Array<{ role: string; count: number }>;
  /** how the edge clip would leave Prism; confirmed exactly and re-verified on the derived bytes before queueing */
  transfer: EdgeTransfer;
  /** "exact" = from the derived clip's real size; "estimated" = no derivation exists yet */
  transferBasis: "exact" | "estimated";
  clipBytes: number | null;
}

export interface CutDisclosure {
  transitionKey: string;
  title: string;
  truth: TransitionRunTruth;
  left: SideDisclosure;
  right: SideDisclosure;
  planned: string[];
  unavailable: Array<{ key: string; reason: string }>;
  maxUsd: number | null;
}

export interface SequenceReviewDisclosure {
  analyzer: { id: string; label: string; model: string; kind: "mock" | "model" };
  cuts: CutDisclosure[];
  audio: "not sent";
  totalMaxUsd: number | null;
  /** reasons the whole batch cannot be submitted (empty = it can, once confirmed) */
  blockers: string[];
}

/** How ONE clip of this size would leave Prism with this analyzer (the worker's own rule). */
export function clipTransfer(
  provider: ContinuityAnalysisProvider,
  bytes: number | null,
  sends: boolean,
): EdgeTransfer {
  if (provider.kind === "mock" || !sends) return "not_sent";
  if (bytes == null || !provider.videoTransfer) return "provider_file"; // the more persistent method when unknown
  return provider.videoTransfer(bytes);
}

function sideDisclosure(
  side: CutSide,
  view: EpisodeEditView,
  data: ProjectData,
  provider: ContinuityAnalysisProvider,
  media: AnalysisMedia[],
  which: "left" | "right",
  sends: boolean,
  exact: boolean,
): SideDisclosure {
  const p = side.picture;
  const asset = p.kind === "video" ? data.assets.find((a) => a.id === p.assetId) : undefined;
  const iv = view.items[side.index];
  const clip = media.find((m) => m.inputId === `${which}:clip`);
  const refs = new Map<string, number>();
  for (const m of media.filter((x) => x.kind === "reference" && sequenceInputSide(x.inputId) === which))
    refs.set(m.role, (refs.get(m.role) ?? 0) + 1);
  return {
    itemId: side.itemId,
    shotCode: side.shotCode ?? "(missing Shot)",
    sourceAssetId: p.kind === "video" ? p.assetId : null,
    sourceAssetName: asset?.name ?? null,
    differsFromCurrentDelivery:
      iv?.visual.kind === "video" ? Boolean(iv.visual.newerDeliveryMasterAssetId) : false,
    window: side.window
      ? { startMs: side.window.startMs, endMs: side.window.endMs, durationMs: side.window.durationMs }
      : null,
    still: side.still ? { atMs: side.still.atMs, frame: side.still.frame } : null,
    references: [...refs.entries()].map(([role, count]) => ({ role, count })),
    transfer: clipTransfer(provider, clip?.byteSize ?? null, sends),
    transferBasis: exact ? "exact" : "estimated",
    clipBytes: clip?.byteSize ?? null,
  };
}

/**
 * What a confirmation WOULD do, for exactly these cuts. Pure read: no Asset, derivation, run or job is created. When a
 * cut's edge media were already derived (`edges`, looked up read-only), the disclosure uses their EXACT sizes.
 */
export function previewSequenceReview(args: {
  data: ProjectData;
  view: EpisodeEditView;
  transitionKeys: string[];
  provider: ContinuityAnalysisProvider;
  qaPolicy: ProjectQaPolicy;
  paid: AnalysisSpendPolicy;
  spentLast24hUsd: number;
  projectSpentLast24hUsd: number;
  now: Date;
  edges?: ReadonlyMap<string, { left: EdgeAssets; right: EdgeAssets }>;
}): SequenceReviewDisclosure {
  const { data, view, provider } = args;
  const cuts = buildEpisodeCuts({ data, view }).filter((c) => args.transitionKeys.includes(c.transitionKey));
  const blockers: string[] = [];
  if (cuts.length === 0) blockers.push("Select at least one cut of the current edit.");
  if (cuts.length > MAX_MANUAL_SEQUENCE_CUTS)
    blockers.push(`At most ${MAX_MANUAL_SEQUENCE_CUTS} cuts can be reviewed in one manual batch.`);
  const consent = consentProblem(args.qaPolicy, provider);
  if (consent) blockers.push(consent);
  const disclosed: CutDisclosure[] = cuts.map((cut) => {
    const edge = args.edges?.get(cut.transitionKey) ?? null;
    const input = buildTransitionInput({
      cut,
      view,
      data,
      provider,
      directVideoAllowed: args.qaPolicy.directVideoAllowed,
      edge,
      runKey: "preview",
    });
    const est = provider.estimate(input, args.now);
    const sends = input.plan.batches.length > 0;
    return {
      transitionKey: cut.transitionKey,
      title: `${cut.left.shotCode ?? "?"} → ${cut.right.shotCode ?? "?"}`,
      truth: cut.truth,
      left: sideDisclosure(cut.left, view, data, provider, input.media, "left", sends, edge != null),
      right: sideDisclosure(cut.right, view, data, provider, input.media, "right", sends, edge != null),
      planned: input.plan.items.filter((i) => i.status === "planned").map((i) => i.criterionKey),
      unavailable: input.plan.items
        .filter((i) => i.status === "unsupported" || i.status === "no_media" || i.status === "not_allowed")
        .map((i) => ({ key: i.criterionKey, reason: i.reason })),
      maxUsd: Number.isFinite(est.maxUsd) ? est.maxUsd : null,
    };
  });
  for (const c of disclosed)
    if (c.planned.length === 0)
      blockers.push(
        `${c.title}: no cut criterion can be analysed by ${provider.label} (${c.unavailable[0]?.reason ?? NOT_CALIBRATED_SEQUENCE_REASON}).`,
      );
  const total = disclosed.some((c) => c.maxUsd == null)
    ? null
    : disclosed.reduce((n, c) => n + (c.maxUsd ?? 0), 0);
  blockers.push(...costBlockers({ ...args, totalMaxUsd: total }));
  return {
    analyzer: { id: provider.id, label: provider.label, model: provider.model, kind: provider.kind },
    cuts: disclosed,
    audio: "not sent",
    totalMaxUsd: total,
    blockers,
  };
}

/** `direct_video_allowed` is required (bounded cut-edge video leaves Prism); a model analyzer also needs external media. */
function consentProblem(policy: ProjectQaPolicy, provider: ContinuityAnalysisProvider): string | null {
  if (!policy.directVideoAllowed)
    return "The Project has not allowed bounded video to leave Prism (Shot QA settings → full-video consent), so cut-edge clips cannot be reviewed.";
  if (provider.kind === "model" && !policy.externalMediaAllowed)
    return "The Project has not allowed media to be sent to an external analyzer (Shot QA settings).";
  return null;
}

/** The WHOLE batch's worst case, before the first submission: never a partial spend until the budget runs out. */
function costBlockers(args: {
  provider: ContinuityAnalysisProvider;
  qaPolicy: ProjectQaPolicy;
  paid: AnalysisSpendPolicy;
  spentLast24hUsd: number;
  projectSpentLast24hUsd: number;
  totalMaxUsd: number | null;
}): string[] {
  if (args.provider.kind !== "model") return [];
  if (args.totalMaxUsd == null)
    return ["The batch's worst-case cost cannot be estimated, so it cannot be submitted."];
  return [
    ...projectBudgetBlockers({
      policy: args.qaPolicy,
      maxEstimateUsd: args.totalMaxUsd,
      projectSpentLast24hUsd: args.projectSpentLast24hUsd,
    }),
    ...analysisSpendBlockers({
      policy: args.paid,
      maxEstimateUsd: args.totalMaxUsd,
      spentLast24hUsd: args.spentLast24hUsd,
    }),
  ].map((b) => b.message);
}

// ───────────────────────── derivation (only after every gate) ─────────────────────────

/** The derivation parameters of one side's edge clip and still: their identity (never the file name). */
function edgeParameters(side: CutSide) {
  return {
    clip: {
      startMs: side.window!.startMs,
      endMs: side.window!.endMs,
      audio: "stripped",
      policy: CUT_EDGE_POLICY.id,
    },
    still: { atMs: side.still!.atMs, policy: CUT_EDGE_POLICY.id },
  };
}

/**
 * READ-ONLY: the already-derived edge Assets of a cut, by derivation key (no media work, nothing written), so a
 * disclosure after a derivation shows the EXACT clip sizes and transfer methods. null = not both sides derived yet.
 */
export async function findEdgeAssets(args: {
  cut: CutTransition;
  processor: MediaProcessor;
  qa: Pick<MediaQaRepository, "findDerivationByKey">;
  projectId: string;
}): Promise<{ left: EdgeAssets; right: EdgeAssets } | null> {
  const identity = await args.processor.identity();
  const processorVersion = `${identity.name}/${identity.adapterVersion}`;
  const out: Partial<Record<"left" | "right", EdgeAssets>> = {};
  for (const which of ["left", "right"] as const) {
    const side = args.cut[which];
    const p = side.picture;
    if (p.kind !== "video" || !side.window || !side.still || !p.assetChecksum) return null;
    const params = edgeParameters(side);
    const key = (operation: string, parameters: Record<string, unknown>) =>
      derivationKey({ parentChecksum: p.assetChecksum!, operation, parameters, processorVersion });
    const clip = await args.qa.findDerivationByKey(args.projectId, key("trim", params.clip));
    const still = await args.qa.findDerivationByKey(args.projectId, key("frame_extract", params.still));
    if (!clip || !still) return null;
    out[which] = { clip: clip.asset, still: still.asset };
  }
  return { left: out.left!, right: out.right! };
}

/**
 * The exact edge clip and edge still of one side, as ordinary persisted derived Assets (`trim` / `frame_extract`),
 * reused by derivation key. Both come from the PARENT pinned clip (the still is never taken from the lossy clip).
 * `attemptId: null` keeps them out of the Shot's own derivation slots (review frames, delivery). The file name follows
 * the container actually encoded; it is never part of the identity.
 */
export async function ensureEdgeAssets(args: {
  side: CutSide;
  which: "left" | "right";
  assets: readonly Asset[];
  deps: DeliveryDeps;
}): Promise<{ clip: DerivedAsset & { created: boolean }; still: DerivedAsset & { created: boolean } }> {
  const { side, which, deps } = args;
  const p = side.picture;
  if (p.kind !== "video" || !side.window || !side.still || !p.assetChecksum)
    throw new SequenceReviewError(
      "media",
      `The ${which} side has no generated clip with a recorded checksum.`,
    );
  const parent = args.assets.find((a) => a.id === p.assetId);
  if (!parent) throw new SequenceReviewError("media", `The ${which} source Asset no longer exists.`);
  let bytes: Uint8Array | null = null;
  const parentBytes = async () => (bytes ??= await readVerified(parent, deps.storage));
  const w = side.window;
  const params = edgeParameters(side);
  const code = (side.shotCode ?? "shot").replace(/[^A-Za-z0-9_-]/g, "");
  const clip = await derive({
    deps,
    parent,
    parentChecksum: p.assetChecksum,
    attemptId: null,
    operation: "trim",
    slot: `cut-edge:${which}:clip`,
    parameters: params.clip,
    // the extension of what was actually encoded (MP4/H.264, or the WebM/VP9 fallback): never assumed
    name: (out) => `${code}-cut-edge-${which}-${w.startMs}-${w.endMs}ms.${out.extension}`,
    tags: ["cut-edge", "derived"],
    produce: async () => deps.processor.extractWindow(await parentBytes(), w.startMs, w.endMs),
  });
  const at = side.still.atMs;
  const still = await derive({
    deps,
    parent,
    parentChecksum: p.assetChecksum,
    attemptId: null,
    operation: "frame_extract",
    slot: `cut-edge:${which}:still`,
    parameters: params.still,
    name: `${code}-cut-edge-${which}-frame-${at}ms.png`,
    tags: ["cut-edge", "derived"],
    produce: async () => {
      const f = await deps.processor.extractFrame(await parentBytes(), at);
      return { bytes: f.bytes, mime: f.mime, extension: "png", probe: await deps.processor.probe(f.bytes) };
    },
  });
  return { clip, still };
}

// ───────────────────────── submission ─────────────────────────

export interface SequenceSelection {
  transitionKey: string;
  /** the truth the person reviewed in the disclosure (stale browser truth is refused, never refreshed silently) */
  subjectFingerprint: string;
  criteriaFingerprint: string;
  referenceFingerprint: string;
  /** the transfer methods the person confirmed for the two edge clips */
  transfer: { left: EdgeTransfer; right: EdgeTransfer };
}

type Submitted = { run: TransitionRunView; job: TransitionAnalysisJob; duplicate: boolean };

/**
 * One confirmed manual batch, ALL OR NONE. Before any derivation: changed cut truth, consent, plan, the whole batch's
 * worst-case cost (also against the confirmed ceiling) and the shared active capacity for the NEW jobs (replays take no
 * slot). Then `queueTransitionBatch`, the machinery automatic waves share.
 */
export async function submitSequenceReview(args: {
  data: ProjectData;
  /** `buildEpisodeEditView` of the edit as RE-READ now */
  view: EpisodeEditView;
  selections: SequenceSelection[];
  provider: ContinuityAnalysisProvider;
  qaPolicy: ProjectQaPolicy;
  paid: AnalysisSpendPolicy;
  deps: DeliveryDeps;
  /** the person confirmed the exact disclosure (media + cost) */
  confirmed: boolean;
  /** the worst-case total the person confirmed (null = none disclosed: a model analyzer is then refused) */
  confirmedMaxUsd: number | null;
  nonce: string;
  limits: { maxActivePerProject: number; maxJobAttempts: number };
  now?: Date;
}): Promise<Submitted[]> {
  const { data, view, provider, deps } = args;
  const now = args.now ?? deps.now?.() ?? new Date();
  if (args.selections.length === 0) throw new SequenceReviewError("no_selection", "Select at least one cut.");
  if (args.selections.length > MAX_MANUAL_SEQUENCE_CUTS)
    throw new SequenceReviewError(
      "too_many",
      `At most ${MAX_MANUAL_SEQUENCE_CUTS} cuts can be reviewed in one manual batch.`,
    );
  if (!args.confirmed)
    throw new SequenceReviewError("needs_ack", "Confirm the disclosed media and cost to start the review.");

  // 1. the cuts as they are NOW; each must still be exactly the cut that was disclosed
  const all = buildEpisodeCuts({ data, view });
  const cuts = args.selections.map((s) => {
    const cut = all.find((c) => c.transitionKey === s.transitionKey);
    if (
      !cut ||
      cut.truth.subjectFingerprint !== s.subjectFingerprint ||
      cut.truth.criteriaFingerprint !== s.criteriaFingerprint ||
      cut.truth.referenceFingerprint !== s.referenceFingerprint
    )
      throw new SequenceReviewError(
        "cut_changed",
        "A selected cut changed since it was disclosed (its items, picture, truth or references). Nothing was derived or queued; review the disclosure again.",
      );
    return cut;
  });

  // 2. consent and plan
  const consent = consentProblem(args.qaPolicy, provider);
  if (consent) throw new SequenceReviewError("not_allowed", consent);
  const build = (cut: CutTransition, edge: { left: EdgeAssets; right: EdgeAssets } | null, runKey: string) =>
    buildTransitionInput({
      cut,
      view,
      data,
      provider,
      directVideoAllowed: args.qaPolicy.directVideoAllowed,
      edge,
      runKey,
    });
  const previews = cuts.map((cut) => build(cut, null, "preview"));
  for (const [i, p] of previews.entries())
    if (p.plan.batches.length === 0)
      throw new SequenceReviewError(
        "nothing_to_analyse",
        `${title(cuts[i]!)}: no cut criterion can be analysed by ${provider.label} (${p.plan.items.find((x) => x.mode === "sequence_transition")?.reason ?? NOT_CALIBRATED_SEQUENCE_REASON}). Nothing was derived or queued.`,
      );

  // 3. the whole batch's worst case, before derivation (also against what the person confirmed)
  const budget = async (inputs: TransitionContinuityAnalysisInput[], stage: string) => {
    const estimates = inputs.map((p) => provider.estimate(p, now));
    const total = estimates.every((e) => Number.isFinite(e.maxUsd))
      ? estimates.reduce((n, e) => n + e.maxUsd, 0)
      : null;
    if (provider.kind !== "model") return estimates;
    if (total == null || args.confirmedMaxUsd == null || total > args.confirmedMaxUsd + 1e-9)
      throw new SequenceReviewError(
        "cost_changed",
        `${stage}: the worst-case cost (${total == null ? "unknown" : `$${total.toFixed(4)}`}) is not within the confirmed $${(args.confirmedMaxUsd ?? 0).toFixed(4)}. Nothing was queued; review the disclosure again.`,
      );
    const since = new Date(now.getTime() - 24 * 3600_000).toISOString();
    const blockers = costBlockers({
      provider,
      qaPolicy: args.qaPolicy,
      paid: args.paid,
      totalMaxUsd: total,
      spentLast24hUsd: await deps.qa.analysisSpentSince(null, since),
      projectSpentLast24hUsd: await deps.qa.analysisSpentSince(data.project.id, since),
    });
    if (blockers.length > 0) throw new SequenceReviewError("budget_blocked", blockers.join(" "));
    return estimates;
  };
  await budget(previews, "Before preparing media");

  // 4. the shared active capacity for the NEW jobs only (an exact replay takes no slot), before derivation
  const keys = cuts.map((cut, i) =>
    sequenceIdempotencyKey(cut.truth, provider, previews[i]!.plan.batches[0]!.promptVersion, args.nonce),
  );
  const existing = await deps.qa.findTransitionJobsByKeys(data.project.id, keys);
  const known = new Set(existing.map((j) => j.idempotencyKey));
  const fresh = new Set(keys.filter((k) => !known.has(k)));
  if (fresh.size === 0) {
    // the SAME confirmation again: return the queued batch as it is (no derivation, no capacity)
    return Promise.all(
      keys.map(async (k) => {
        const job = existing.find((j) => j.idempotencyKey === k)!;
        return { run: (await deps.qa.getTransitionRun(job.runId))!, job, duplicate: true };
      }),
    );
  }
  const active = (await deps.qa.listActiveProjectAnalysisJobs(data.project.id)).length;
  const free = Math.max(0, args.limits.maxActivePerProject - active);
  if (fresh.size > free)
    throw new SequenceReviewError(
      "limit",
      `This review needs ${fresh.size} analysis slot(s) but the project has ${free} free (${active} in progress, limit ${args.limits.maxActivePerProject}). Nothing was derived or queued.`,
    );

  return queueTransitionBatch({
    data,
    view,
    cuts,
    keys,
    provider,
    qaPolicy: args.qaPolicy,
    deps,
    limits: args.limits,
    now,
    authority: {
      kind: "manual",
      approved: args.selections.map((x) => x.transfer),
      checkBudget: (inputs) => budget(inputs, "After preparing the exact media"),
    },
  });
}

/** Under what authority a batch is queued. The two are never mixed: an automatic wave fakes no human confirmation. */
export type SequenceBatchAuthority =
  /** a person confirmed these exact transfer methods and worst case in a disclosure */
  | {
      kind: "manual";
      approved: Array<{ left: EdgeTransfer; right: EdgeTransfer }>;
      checkBudget: (inputs: TransitionContinuityAnalysisInput[]) => Promise<CostEstimateUsd[]>;
    }
  /** the Project's persisted standing authorisation, which disclosed inline and temporary-file transfer in advance */
  | {
      kind: "automatic";
      queuedNote: string;
      checkBudget: (inputs: TransitionContinuityAnalysisInput[]) => Promise<CostEstimateUsd[]>;
    };

/**
 * Manual and automatic share everything from here, ALL OR NONE: derive (or reuse) every cut's exact edge media, rebuild
 * and validate every frozen input (media contract, exact transfer method, recomputed worst case), then ONE atomic batch
 * write. A refusal after derivation queues nothing: the derived Assets remain as reusable deterministic derivations
 * (they are not rolled back), and no run / job / cost / event exists.
 */
export async function queueTransitionBatch(args: {
  data: ProjectData;
  view: EpisodeEditView;
  cuts: CutTransition[];
  keys: string[];
  provider: ContinuityAnalysisProvider;
  qaPolicy: ProjectQaPolicy;
  deps: DeliveryDeps;
  limits: { maxActivePerProject: number; maxJobAttempts: number };
  now: Date;
  authority: SequenceBatchAuthority;
}): Promise<Submitted[]> {
  const { data, view, cuts, keys, provider, deps, authority, now } = args;
  // 5. derive (or reuse) every selected cut's exact edge media, then build and VALIDATE every frozen input
  const finals: TransitionContinuityAnalysisInput[] = [];
  for (const [i, cut] of cuts.entries()) {
    const left = await ensureEdgeAssets({ side: cut.left, which: "left", assets: data.assets, deps });
    const right = await ensureEdgeAssets({ side: cut.right, which: "right", assets: data.assets, deps });
    const draft = buildTransitionInput({
      cut,
      view,
      data,
      provider,
      directVideoAllowed: args.qaPolicy.directVideoAllowed,
      edge: {
        left: { clip: left.clip.asset, still: left.still.asset },
        right: { clip: right.clip.asset, still: right.still.asset },
      },
      runKey: keys[i]!.slice(0, 16),
    });
    if (draft.plan.batches.length === 0)
      throw new SequenceReviewError(
        "media",
        `The exact edge media of ${title(cut)} is outside the cut-edge bounds (${draft.plan.items.find((x) => x.status === "no_media")?.reason ?? "no batch"}). Nothing was queued for this review.`,
      );
    // the transfer method of each derived clip is frozen on the media; a person's review must have confirmed it exactly
    for (const which of ["left", "right"] as const) {
      const clip = draft.media.find((m) => m.inputId === `${which}:clip`)!;
      const actual = clipTransfer(provider, clip.byteSize, true);
      if (authority.kind === "manual" && actual !== authority.approved[i]![which])
        throw new SequenceReviewError(
          "transfer_changed",
          `The exact ${which} edge clip of ${title(cut)} (${clip.byteSize ?? "?"} bytes) would be sent as ${actual === "provider_file" ? "a temporary provider file" : actual === "inline" ? "inline data" : "nothing (not sent)"}, not as disclosed (${authority.approved[i]![which]}). Nothing was queued or sent; review the disclosure again (it now shows the exact media).`,
        );
      clip.edge = { ...clip.edge!, transfer: actual };
    }
    const problem = transitionInputProblem(draft);
    if (problem) throw new SequenceReviewError("media", `${title(cut)}: ${problem} Nothing was queued.`);
    finals.push(draft);
  }

  // 6. the recomputed worst case of the EXACT media, again before anything is queued
  const estimates = await authority.checkBudget(finals);

  // 7. ONE atomic batch write: replays resolved, the shared limit re-checked, every run + job or none
  try {
    return await deps.qa.createTransitionBatchWithJobs({
      limits: { maxActivePerProject: args.limits.maxActivePerProject },
      entries: cuts.map((cut, i) => {
        const input = finals[i]!;
        const estimate = estimates[i]!;
        return {
          limits: { maxActivePerProject: args.limits.maxActivePerProject },
          ...(authority.kind === "automatic" ? { queuedNote: authority.queuedNote } : {}),
          run: {
            ...newTransitionRun({ cut, view, userId: deps.userId, now: now.toISOString() }),
            analyzer: provider.id,
            analyzerVersion: input.analyzerVersion,
            analyzerKind: provider.kind,
            analysisStatus: "queued",
            analysisPlan: input.plan,
            externalManifest: input.plan.manifest,
            promptVersion: input.promptVersions.sequence_transition,
            rubricVersion: SEQUENCE_RUBRIC_VERSION,
            model: provider.model,
            automationKey: authority.kind === "automatic" ? keys[i]! : null,
          },
          job: {
            idempotencyKey: keys[i]!,
            analyzer: provider.id,
            model: provider.model,
            snapshot: input,
            inputAssetIds: inputAssetIdsOf(input),
            maxAttempts: args.limits.maxJobAttempts,
            estimate: {
              maxUsd: Number.isFinite(estimate.maxUsd) ? estimate.maxUsd : null,
              expectedUsd: Number.isFinite(estimate.expectedUsd) ? estimate.expectedUsd : null,
              usage: { tokens: estimate.tokens, basis: estimate.basis },
              pricingVersion: estimate.pricingVersion,
            },
          },
        };
      }),
    });
  } catch (err) {
    if (err instanceof MediaQaError && err.code === "invalid")
      throw new SequenceReviewError("limit", err.message);
    throw err;
  }
}

const title = (cut: CutTransition) => `${cut.left.shotCode ?? "?"} → ${cut.right.shotCode ?? "?"}`;
