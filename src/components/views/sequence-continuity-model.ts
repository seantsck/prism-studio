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
  type TransitionState,
} from "@/domain/continuity/sequence";
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
  "For generated clips, exact cut-edge media will be available when cut-edge derivation is implemented.";
export const SEMANTIC_NOTE =
  "Semantic sequence analysis is not available yet: these cross-cut criteria are listed so you can see what is not checked. Nothing was analysed.";
export const NO_EDIT_MESSAGE =
  "Sequence Continuity needs a persisted Episode Edit because the edit determines the actual cuts.";
export const NO_CUTS_MESSAGE = "This edit has no cuts to review yet.";
export const RUNS_UNAVAILABLE =
  "Reviewed, stale and intentional counts are unavailable: transition runs and cut intent are not stored yet.";

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

function cutRow(
  data: ProjectData,
  episode: Episode,
  view: EpisodeEditView,
  media: EditMediaFacts,
  runs: RunVM[],
  cut: CutTransition,
): CutRowVM {
  const pairs = cut.criteria.map((c) => ({
    c,
    vm: findingVM(
      c,
      cut.findings.find((f) => f.criterionKey === c.key)!,
    ),
  }));
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
  const declared = view.items[cut.index + 1]?.item.incomingCutIntent ?? null;
  // no transition run is stored yet: with or without intent the state is the no-run state (intent only reinterprets
  // the findings of an evaluated run, 3A.4A precedence)
  const assessment = assessTransition({ cut, run: null, intent: declared });
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
}): Extract<ContinuityPageVM, { state: "edit" }> {
  const { data, episode, edit, media } = args;
  const view = buildEpisodeEditView(data, edit, media);
  const runs = runsOf(data, view);
  const rows = buildEpisodeCuts({ data, view }).map((cut) => cutRow(data, episode, view, media, runs, cut));
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
  };
}
