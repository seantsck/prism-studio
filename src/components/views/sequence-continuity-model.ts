import { CUT_INTENT_KIND_LABELS, cutIntentEffective, type CutIntent } from "@/domain/continuity/cut-intent";
import { CATEGORY_LABELS, RESULT_LABELS, type ContinuityResult } from "@/domain/continuity/model";
import {
  assessTransition,
  buildEpisodeCuts,
  editOrderInfo,
  type CutCriterion,
  type CutFinding,
  type CutSide,
  type CutTransition,
  transitionFreshness,
  type TransitionRun,
  type TransitionState,
} from "@/domain/continuity/sequence";
import type { SequenceAutoView } from "@/continuity/sequence-automation";
import type { SequenceReviewDisclosure } from "@/continuity/sequence-review";
import { sequenceInputSide } from "@/domain/continuity/analysis/sequence-plan";
import type { TransitionRunView } from "@/data/media-qa-repository";
import { assetUrl } from "@/lib/utils";
import { SEVERITY_LABELS } from "@/domain/continuity/status";
import type { EditMediaFacts } from "@/domain/edit/eligibility";
import type { EpisodeEdit } from "@/domain/edit/model";
import { buildEpisodeEditView, type EpisodeEditView } from "@/domain/edit/view";
import type { Episode, ProjectData } from "@/domain/schemas";
import { episodePath, shotPath } from "@/lib/paths";
import { cutAnchor, type CutFilter } from "./cut-marker-model";
import { picture, runsOf, type PictureVM, type RunVM, type Tone } from "./episode-edit-model";

/**
 * Phase 3A.4B display model of the Continuity Supervisor: the ACTUAL cuts of the persisted Episode Edit, in edit order,
 * with the 3A.4A cut projection's deterministic findings, its semantic `unchecked` / `n_a` projection and its advisory
 * state. Pure once its inputs are loaded: it never writes, derives media, starts an analysis or follows anything, and
 * it re-derives no cut logic (everything comes from src/domain/continuity/sequence.ts).
 *
 * No transition run exists before 3A.4C, so every cut is assessed with `run: null`: a normal cut reads "No sequence QA
 * yet" and only a current `cut:source_integrity` failure reads "Critical continuity break". Deterministic warnings are
 * shown as findings whatever the state: the state and the findings answer different questions.
 *
 * Current Shot QA of the pinned attempts is NOT loaded in 3A.4B (the Supervisor keeps to the Episode Edit's own read
 * path), so `cut:shot_qa` is absent; each video side links to its attempt's Shot QA page instead.
 *
 * Previews are the PINNED sources through the private asset route. The edge windows and edge frames are the 3A.4A
 * descriptors (text): no derived edge-frame media exists yet, so nothing is ever called the exact edge frame.
 */

/** Shown only on a cut with a generated-clip side: a placeholder still never gets temporal edge media. */
export const EDGE_MEDIA_NOTE =
  "Exact cut-edge media (2 s per side, audio stripped, plus the exact edge frames) is derived only when you confirm a Sequence Continuity review of this cut.";
export const SEMANTIC_NOTE =
  "Sequence Continuity criteria stay unchecked until a review of this cut runs. A family an analyzer has not been calibrated for stays unchecked.";
export const NO_EDIT_MESSAGE =
  "Sequence Continuity needs a persisted Episode Edit because the edit determines the actual cuts.";
export const SEQUENCE_MODE_LABELS = { off: "Off", suggest: "Suggest", automatic: "Automatic" } as const;

export const NO_CUTS_MESSAGE = "This edit has no cuts to review yet.";
export const RUNS_NOTE =
  "Sequence Continuity reviews run only when you select cuts and confirm the disclosure. Nothing runs on page load or edit changes.";

export interface FindingVM {
  key: string;
  title: string;
  result: ContinuityResult;
  resultLabel: string;
  tone: Tone;
  severity: string;
  reason: string;
  expected: string;
  sourceRef: string;
  /** "deterministic" | "analyzer" | "manual" (deterministic findings are never called a model result) */
  handler: CutCriterion["handler"];
  /** 3A.4D: the result comes from the CURRENT Sequence Continuity run (null = projection) and whose analyzer */
  analyzed?: { analyzer: string; mock: boolean } | null;
  /** 3A.4D: a declared intent covers this warn / fail (the stored result is unchanged) */
  intentional?: boolean;
  evidence?: EvidenceVM[];
}

/** 3A.4D: one sided evidence item with Prism's time mapping (clip-local → source → edit time). */
export interface EvidenceVM {
  input: string;
  side: "left" | "right" | null;
  /** "left clip at 1.200 s → source 3.200 s → edit 7.700 s" */
  where: string;
  observation: string;
}

/** 3A.4D: one Sequence Continuity run of this cut (newest first). */
export interface RunHistoryVM {
  runNumber: number;
  status: string;
  analyzer: string;
  model: string;
  mock: boolean;
  freshness: "current" | "stale";
  staleReasons: string[];
  error: string;
  createdAt: string;
  /** the exact derived edge media the run used (private asset route) */
  edgeMedia: Array<{ inputId: string; url: string | null; mediaType: "video" | "image" }>;
}

export interface SideVM {
  label: string;
  itemId: string;
  shotCode: string;
  shotTitle: string;
  scene: string;
  run: string;
  picture: PictureVM;
  /** the edit's used interval of the pinned clip; null for stills */
  trim: string | null;
  /** the 3A.4A descriptor of the window a future semantic analysis would examine (text, not media) */
  window: string | null;
  /** the computed source time of A's last / B's first displayed frame (text, not media) */
  edgeFrame: string | null;
  usable: boolean;
  violations: string[];
  current: boolean;
  currentness: string[];
  location: string;
  characters: string[];
  direction: string | null;
  time: string | null;
  shotPrepUrl: string | null;
  /** the pinned attempt's Shot QA page (video sides only) */
  shotQaUrl: string | null;
}

export interface TopIssueVM {
  tone: Tone;
  text: string;
}

/** 3A.4C: the person's declared intent for this cut (stored on the right item, bound to the left one). */
export interface CutIntentVM {
  /** effective for THIS predecessor (always, once persisted: a changed predecessor clears it) */
  effective: boolean;
  kinds: string[];
  /** "Every continuity category" when the scope is empty */
  scope: string[];
  note: string;
  declaredAt: string;
  declaredBy: string | null;
  /** the raw values, so the form can be prefilled */
  raw: CutIntent;
}

export interface CutRowVM {
  anchor: string;
  index: number;
  leftItemId: string;
  rightItemId: string;
  title: string;
  context: string;
  crossesScene: boolean;
  state: TransitionState;
  stateLabel: string;
  stateTone: Tone;
  left: SideVM;
  right: SideVM;
  /** deterministic FAIL / WARN: shown first, never among the passes */
  attention: FindingVM[];
  /** the other deterministic results (pass / n_a / unchecked) */
  checks: FindingVM[];
  /** the semantic cross-cut criteria: `unchecked` (with why) or Prism's `n_a` */
  semantic: FindingVM[];
  semanticUnchecked: number;
  info: string[];
  topIssue: TopIssueVM | null;
  mediaEligible: boolean;
  mediaReasons: string[];
  /** a side is a generated clip with edge descriptors: the exact-edge-media note applies */
  hasClipEdge: boolean;
  /** 3A.4C: the declared intent (null = none). It never changes the state or a finding. */
  intent: CutIntentVM | null;
  /** 3A.4D: the cut's address, for selecting it for a manual Sequence Continuity review */
  transitionKey: string;
  runs: RunHistoryVM[];
  flags: { hasFail: boolean; hasWarn: boolean; hasUnchecked: boolean };
}

export interface SummaryCountsVM {
  cuts: number;
  criticalBreaks: number;
  warningCuts: number;
  semanticUnchecked: number;
  sceneBoundaries: number;
  /** cuts whose media a future semantic analysis could not use (placeholder, no picture, unusable or unchecksummed clip) */
  semanticMediaBlocked: number;
}

export interface SupervisorLinks {
  edit: string;
  sequence: string;
}

export type ContinuityPageVM =
  | { state: "no_edit"; links: SupervisorLinks }
  | { state: "error"; message: string; links: SupervisorLinks }
  | {
      state: "edit";
      links: SupervisorLinks;
      projectSlug: string;
      editId: string;
      revision: number;
      rows: CutRowVM[];
      summary: SummaryCountsVM;
      filterCounts: Record<CutFilter, number>;
      info: string[];
      /** 3A.4D: the exact disclosure of the cuts selected for review (GET only: derives nothing) */
      review: { disclosure: SequenceReviewDisclosure; nonce: string } | null;
      analyzers: Array<{ id: string; label: string }>;
      selectedAnalyzer: string | null;
      /** 3A.4F: the Project's Sequence automation status (null = it could not be read; nothing depends on it) */
      autoSequence?: SequenceAutoView | null;
      episodeId?: string;
    };

export const supervisorLinks = (data: ProjectData, episode: Episode): SupervisorLinks => ({
  edit: episodePath(data.project.slug, episode.slug, "/edit"),
  sequence: episodePath(data.project.slug, episode.slug, "/sequence"),
});

const RESULT_TONE: Record<ContinuityResult, Tone> = {
  fail: "fail",
  warn: "warn",
  pass: "neutral",
  n_a: "neutral",
  unchecked: "info",
};
const STATE_TONE: Record<TransitionState, Tone> = {
  no_sequence_qa: "neutral",
  sequence_stale: "warn",
  critical_break: "fail",
  analysis_running: "info",
  needs_review: "warn",
  unchecked_transition: "info",
  intentional_accepted: "accent",
  no_blocking_mismatch: "neutral",
};

const secs = (ms: number) => `${(ms / 1000).toFixed(3)} s`;
const SEVERITY_RANK = { critical: 0, major: 1, minor: 2 } as const;

function findingVM(c: CutCriterion, f: CutFinding): FindingVM {
  return {
    key: c.key,
    title: c.title,
    result: f.result,
    resultLabel: RESULT_LABELS[f.result],
    tone: RESULT_TONE[f.result],
    severity: SEVERITY_LABELS[c.severity],
    reason: f.reason,
    expected: c.expected,
    sourceRef: c.sourceRef,
    handler: c.handler,
  };
}

function sideVM(
  data: ProjectData,
  episode: Episode,
  view: EpisodeEditView,
  media: EditMediaFacts,
  runs: RunVM[],
  side: CutSide,
  which: "left" | "right",
): SideVM {
  const iv = view.items[side.index]!;
  const shot = data.shots.find((s) => s.id === side.shotId);
  const scene = shot ? data.scenes.find((s) => s.id === shot.sceneId) : undefined;
  const run = runs.find((r) => side.index >= r.firstIndex && side.index <= r.lastIndex);
  const p = side.picture;
  const t = side.truth;
  const slug = data.project.slug;
  const direction = t
    ? [
        t.continuity.screenDirection && `screen: ${t.continuity.screenDirection}`,
        t.continuity.facingDirection && `facing: ${t.continuity.facingDirection}`,
      ]
        .filter(Boolean)
        .join(" · ")
    : "";
  const time = t
    ? [t.continuity.timeOfDay, t.continuity.weather, side.declaredExtra.lighting].filter(Boolean).join(" · ")
    : "";
  return {
    label: which === "left" ? "Outgoing (A)" : "Incoming (B)",
    itemId: side.itemId,
    shotCode: side.shotCode ?? "(missing Shot)",
    shotTitle: shot?.title ?? "",
    scene: scene ? `Scene ${scene.sceneNumber}` : "Scene missing",
    run: run?.label ?? "",
    picture: picture(data, iv.item, media),
    trim:
      p.kind === "video" ? `Used trim ${secs(p.sourceInMs)} – ${secs(p.sourceOutMs)} (source time)` : null,
    window: side.window
      ? `Future edge window ${secs(side.window.startMs)} – ${secs(side.window.endMs)} · ${secs(side.window.durationMs)} at ${side.window.fps} fps, audio stripped (${side.window.policy})`
      : null,
    edgeFrame: side.still
      ? `${side.still.frame === "last_displayed" ? "Last displayed frame" : "First displayed frame"} at source ${secs(side.still.atMs)} (computed)`
      : null,
    usable: side.usable,
    violations: side.violations,
    current: !side.currentness.stale,
    currentness: side.currentness.reasons,
    location: t
      ? `${t.location?.name ?? "No Location"}${t.locationView ? ` · View ${t.locationView.name}` : ""}`
      : "Shot not in this Episode",
    characters: (t?.characters ?? []).map(
      (c) =>
        `${c.name} (${c.authority === "lock" && c.lock ? `Lock “${c.lock.name}”` : `live${c.lookName ? ` · ${c.lookName}` : ""}`})`,
    ),
    direction: direction || null,
    time: time || null,
    shotPrepUrl: shot ? shotPath(slug, episode.slug, shot.id) : null,
    shotQaUrl: p.kind === "video" ? `/projects/${slug}/generations/${p.attemptId}/continuity` : null,
  };
}

/** Display-only prioritisation: a deterministic FAIL, else a deterministic WARN, else an important semantic gap. */
function topIssue(cut: CutTransition, rows: FindingVM[], semanticUnchecked: FindingVM[]): TopIssueVM | null {
  const rank = (f: FindingVM) => {
    const c = cut.criteria.find((x) => x.key === f.key)!;
    return SEVERITY_RANK[c.severity];
  };
  const pick = (result: ContinuityResult) =>
    rows.filter((f) => f.result === result).sort((a, b) => rank(a) - rank(b))[0];
  const fail = pick("fail");
  if (fail) return { tone: "fail", text: `${fail.title}: ${fail.reason}` };
  const warn = pick("warn");
  if (warn) return { tone: "warn", text: `${warn.title}: ${warn.reason}` };
  const gap = semanticUnchecked[0];
  if (gap)
    return {
      tone: "info",
      text: `${semanticUnchecked.length} semantic criteri${semanticUnchecked.length === 1 ? "on" : "a"} unchecked: ${gap.reason}`,
    };
  return null;
}

/** 3A.4D: a stored transition run as the assessment reads it (human overrides applied: latest override wins). */
export function transitionRunOf(v: TransitionRunView): TransitionRun {
  return {
    truth: {
      transitionKey: v.subject.transitionKey,
      leftSubjectFingerprint: v.subject.leftSide.subjectFingerprint,
      rightSubjectFingerprint: v.subject.rightSide.subjectFingerprint,
      subjectFingerprint: v.run.subjectFingerprint,
      criteriaFingerprint: v.run.criteriaFingerprint,
      referenceFingerprint: v.run.referenceFingerprint,
      rulesVersion: v.run.rulesVersion,
    },
    analysisStatus: v.run.analysisStatus,
    findings: v.findings.map(({ finding, overrides }) => ({
      criterionKey: finding.criterionKey,
      category: finding.category,
      severity: finding.severity,
      result: overrides[0]?.result ?? finding.result,
      intentCoverable: false,
    })),
  };
}

const RUN_STATUS: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  complete: "Complete",
  failed: "Failed",
};

/** Prism's projection of one evidence item: clip-local -> parent source -> edit time (never a rewrite of the answer). */
function evidenceVM(
  item: { input?: unknown; atMs?: unknown; endMs?: unknown; observation?: unknown },
  run: TransitionRunView,
  view: EpisodeEditView,
  cut: CutTransition,
): EvidenceVM {
  const input = String(item.input ?? "");
  // the same canonical authority the provider-answer validator uses: the input id, never a redundant field
  const side = sequenceInputSide(input);
  const at = typeof item.atMs === "number" ? item.atMs : null;
  const end = typeof item.endMs === "number" ? item.endMs : null;
  const frozen = side === "left" ? run.subject.leftSide : side === "right" ? run.subject.rightSide : null;
  const live = side === "left" ? cut.left : side === "right" ? cut.right : null;
  const p = frozen?.picture;
  const editAt = (sourceMs: number) => {
    if (!live || !p || p.kind !== "video") return null;
    const start = view.items[live.index]?.timing.startMs;
    return start == null ? null : start + (sourceMs - p.sourceInMs);
  };
  const chain = (localMs: number | null, still: boolean) => {
    const source = still
      ? (frozen?.still?.atMs ?? null)
      : frozen?.window && localMs != null
        ? frozen.window.startMs + localMs
        : null;
    const edit = source != null ? editAt(source) : null;
    return [
      !still && localMs != null ? `clip ${secs(localMs)}` : null,
      source != null ? `source ${secs(source)}` : null,
      edit != null ? `edit ${secs(edit)}` : null,
    ]
      .filter(Boolean)
      .join(" → ");
  };
  const where = input.endsWith(":clip")
    ? `${side} edge clip ${chain(at, false)}${end != null ? ` until ${chain(end, false)}` : ""}`
    : input === "left:last" || input === "right:first"
      ? `${side} ${input === "left:last" ? "last" : "first"} displayed frame (${chain(null, true)})`
      : `${side ?? ""} reference ${input}`.trim();
  return { input, side, where, observation: String(item.observation ?? "") };
}

function runHistoryVM(data: ProjectData, cut: CutTransition, v: TransitionRunView): RunHistoryVM {
  const fresh = assessTransition({ cut, run: transitionRunOf(v) }).freshness;
  const manifest = v.run.externalManifest?.entries ?? [];
  return {
    runNumber: v.run.runNumber,
    status: RUN_STATUS[v.run.analysisStatus] ?? v.run.analysisStatus,
    analyzer: v.run.analyzer,
    model: v.run.model ?? "",
    mock: v.run.analyzerKind === "mock",
    freshness: fresh?.status === "current" ? "current" : "stale",
    staleReasons: fresh?.reasons ?? [],
    error: v.run.analysisError,
    createdAt: v.run.createdAt,
    edgeMedia: manifest
      .filter((e) => e.sent && e.kind !== "reference")
      .map((e) => {
        const a = data.assets.find((x) => x.id === e.assetId) ?? null;
        return {
          inputId: e.inputId,
          url: assetUrl(a),
          mediaType: e.kind === "video" ? ("video" as const) : ("image" as const),
        };
      }),
  };
}

function cutRow(
  data: ProjectData,
  episode: Episode,
  view: EpisodeEditView,
  media: EditMediaFacts,
  runs: RunVM[],
  cut: CutTransition,
  history: readonly TransitionRunView[] = [],
): CutRowVM {
  const declared = view.items[cut.index + 1]?.item.incomingCutIntent ?? null;
  // the NEWEST run whose frozen truth is CURRENT for this cut (history is newest-first): a cut returned to an earlier
  // truth makes that earlier run current again. Not "newest successful": a newer failed run of the same current truth
  // wins. With no current run, the newest run still drives the stale-history state.
  const latest =
    history.find((v) => transitionFreshness(transitionRunOf(v).truth, cut).status === "current") ??
    history[0] ??
    null;
  const assessment = assessTransition({
    cut,
    run: latest ? transitionRunOf(latest) : null,
    intent: declared,
  });
  const current = latest != null && assessment.freshness?.status === "current";
  const effective = new Map(assessment.findings.map((f) => [f.criterionKey, f.result]));
  const intentOn = assessment.intentEffective && declared != null;
  const pairs = cut.criteria.map((c) => {
    const base = findingVM(
      c,
      cut.findings.find((f) => f.criterionKey === c.key)!,
    );
    if (c.handler === "deterministic" || c.applicability !== "applies" || !latest) return { c, vm: base };
    const stored = latest.findings.find((f) => f.finding.criterionKey === c.key)?.finding ?? null;
    if (!current)
      return { c, vm: { ...base, reason: `${base.reason} (the latest Sequence Continuity run is stale)` } };
    if (latest.run.analysisStatus !== "complete")
      return {
        c,
        vm: {
          ...base,
          reason:
            latest.run.analysisStatus === "failed"
              ? `Sequence Continuity run failed: ${latest.run.analysisError || "no result"}. Stays unchecked.`
              : "Sequence Continuity review in progress.",
        },
      };
    const result = effective.get(c.key) ?? base.result;
    const items = (stored?.evidence as { items?: unknown[] } | undefined)?.items ?? [];
    const coverable =
      intentOn && c.intentCoverable && (declared!.scope.length === 0 || declared!.scope.includes(c.category));
    // the worker also records why a criterion was never sent (unsupported family, no media, not allowed) with this
    // source: only a criterion the run PLANNED was judged by the analyzer
    const planStatus = latest.run.analysisPlan?.items.find((i) => i.criterionKey === c.key)?.status;
    const analyzed = stored?.resultSource === "analyzer" && (planStatus == null || planStatus === "planned");
    return {
      c,
      vm: {
        ...base,
        result,
        resultLabel: RESULT_LABELS[result],
        tone: RESULT_TONE[result],
        reason: analyzed ? stored!.actual || base.reason : stored?.notes || stored?.actual || base.reason,
        analyzed: analyzed
          ? { analyzer: latest.run.analyzer, mock: latest.run.analyzerKind === "mock" }
          : null,
        intentional: coverable && (result === "warn" || result === "fail"),
        evidence: items.map((it) => evidenceVM(it as Record<string, unknown>, latest, view, cut)),
      },
    };
  });
  const deterministic = pairs.filter((p) => p.c.handler === "deterministic").map((p) => p.vm);
  const semantic = pairs.filter((p) => p.c.handler !== "deterministic").map((p) => p.vm);
  // an important applicable semantic criterion still unchecked (Prism's n_a never counts)
  const importantUnchecked = pairs
    .filter(
      (p) =>
        p.c.handler !== "deterministic" &&
        p.c.applicability === "applies" &&
        p.c.severity !== "minor" &&
        p.vm.result === "unchecked",
    )
    .map((p) => p.vm);
  const semanticUnchecked = semantic.filter((f) => f.result === "unchecked").length;
  const attention = deterministic.filter((f) => f.result === "fail" || f.result === "warn");
  const left = sideVM(data, episode, view, media, runs, cut.left, "left");
  const right = sideVM(data, episode, view, media, runs, cut.right, "right");
  return {
    anchor: cutAnchor(cut.address),
    index: cut.index,
    leftItemId: cut.address.leftItemId,
    rightItemId: cut.address.rightItemId,
    title: `${left.shotCode} → ${right.shotCode}`,
    context: cut.crossesScene
      ? `${left.run || left.scene} → ${right.run || right.scene}`
      : right.run || right.scene,
    crossesScene: cut.crossesScene,
    state: assessment.state,
    stateLabel: assessment.label,
    stateTone: STATE_TONE[assessment.state],
    left,
    right,
    attention,
    checks: deterministic.filter((f) => f.result !== "fail" && f.result !== "warn"),
    semantic,
    semanticUnchecked,
    info: cut.info.map((i) => i.message),
    topIssue: topIssue(cut, deterministic, importantUnchecked),
    mediaEligible: cut.semantic.mediaEligible,
    mediaReasons: cut.semantic.reasons,
    hasClipEdge: left.edgeFrame !== null || right.edgeFrame !== null,
    intent: declared
      ? {
          effective: cutIntentEffective(declared, cut.address),
          kinds: declared.kinds.map((k) => CUT_INTENT_KIND_LABELS[k]),
          scope: declared.scope.length
            ? declared.scope.map((c) => CATEGORY_LABELS[c])
            : ["Every continuity category"],
          note: declared.note,
          declaredAt: declared.declaredAt,
          declaredBy: declared.declaredBy,
          raw: declared,
        }
      : null,
    transitionKey: cut.transitionKey,
    runs: history.map((v) => runHistoryVM(data, cut, v)),
    flags: {
      hasFail: deterministic.some((f) => f.result === "fail"),
      hasWarn: deterministic.some((f) => f.result === "warn"),
      hasUnchecked: importantUnchecked.length > 0,
    },
  };
}

/** The Supervisor of a persisted edit. Pure: the caller loaded the edit and its media facts (both read-only). */
export function continuityPage(args: {
  data: ProjectData;
  episode: Episode;
  edit: EpisodeEdit;
  media: EditMediaFacts;
  /** 3A.4D: stored transition runs per transition key, newest first (read-only) */
  transitionRuns?: ReadonlyMap<string, readonly TransitionRunView[]>;
  review?: { disclosure: SequenceReviewDisclosure; nonce: string } | null;
  analyzers?: Array<{ id: string; label: string }>;
  selectedAnalyzer?: string | null;
}): Extract<ContinuityPageVM, { state: "edit" }> {
  const { data, episode, edit, media } = args;
  const view = buildEpisodeEditView(data, edit, media);
  const runs = runsOf(data, view);
  const rows = buildEpisodeCuts({ data, view }).map((cut) =>
    cutRow(data, episode, view, media, runs, cut, args.transitionRuns?.get(cut.transitionKey) ?? []),
  );
  const orderInfo = editOrderInfo(view);
  return {
    state: "edit",
    links: supervisorLinks(data, episode),
    projectSlug: data.project.slug,
    editId: edit.id,
    revision: edit.revision,
    rows,
    summary: {
      cuts: rows.length,
      criticalBreaks: rows.filter((r) => r.state === "critical_break").length,
      warningCuts: rows.filter((r) => r.flags.hasWarn).length,
      semanticUnchecked: rows.reduce((n, r) => n + r.semanticUnchecked, 0),
      sceneBoundaries: rows.filter((r) => r.crossesScene).length,
      semanticMediaBlocked: rows.filter((r) => !r.mediaEligible).length,
    },
    filterCounts: {
      all: rows.length,
      critical: rows.filter((r) => r.flags.hasFail).length,
      warnings: rows.filter((r) => r.flags.hasWarn).length,
      unchecked: rows.filter((r) => r.flags.hasUnchecked).length,
      scene: rows.filter((r) => r.crossesScene).length,
      media_blocked: rows.filter((r) => !r.mediaEligible).length,
    },
    info: orderInfo ? [orderInfo.message] : [],
    review: args.review ?? null,
    analyzers: args.analyzers ?? [],
    selectedAnalyzer: args.selectedAnalyzer ?? null,
  };
}
