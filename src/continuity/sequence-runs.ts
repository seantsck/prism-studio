import {
  buildEpisodeCuts,
  persistedCutSide,
  SEQUENCE_RULES_VERSION,
  type CutTransition,
  type TransitionRunTruth,
} from "@/domain/continuity/sequence";
import type { EpisodeEditView } from "@/domain/edit/view";
import type { ProjectData } from "@/domain/schemas";
import {
  MediaQaError,
  type MediaQaRepository,
  type NewFinding,
  type NewTransitionRun,
  type TransitionRunView,
} from "@/data/media-qa-repository";

/**
 * Phase 3A.4C: freezing a transition run (structurally ready; 3A.4D's semantic analysis builds on it). Nothing in 3A.4C
 * calls this from a page or the UI: the Continuity Supervisor still computes deterministic QA on read and writes no
 * run. The caller re-reads the persisted edit and passes its CURRENT view; the cut is rebuilt from it and must still
 * be the cut the person reviewed (same address, same subject / criteria / reference fingerprints and rules) or the
 * request is refused (no silent refresh). The repository then re-checks adjacency inside its own unit.
 */

export const TRANSITION_TRUTH_CHANGED_MESSAGE =
  "This cut changed since it was reviewed (its picture, continuity truth or references). Nothing was recorded; review it again.";

const sameTruth = (a: TransitionRunTruth, b: TransitionRunTruth) =>
  a.transitionKey === b.transitionKey &&
  a.leftSubjectFingerprint === b.leftSubjectFingerprint &&
  a.rightSubjectFingerprint === b.rightSubjectFingerprint &&
  a.subjectFingerprint === b.subjectFingerprint &&
  a.criteriaFingerprint === b.criteriaFingerprint &&
  a.referenceFingerprint === b.referenceFingerprint &&
  a.rulesVersion === b.rulesVersion;

/** The deterministic projection of a cut as frozen findings (semantic criteria stay `unchecked` / `n_a`). */
export function transitionFindings(cut: CutTransition): NewFinding[] {
  return cut.criteria.map((c) => {
    const f = cut.findings.find((x) => x.criterionKey === c.key)!;
    return {
      criterionKey: c.key,
      category: c.category,
      severity: c.severity,
      title: c.title,
      sourceRef: c.sourceRef,
      expected: c.expected,
      actual: "",
      result: f.result,
      resultSource: c.handler === "deterministic" ? "deterministic" : "none",
      confidence: null,
      notes: f.reason,
      evidence: f.side ? { side: f.side } : {},
      position: c.position,
    };
  });
}

/** The frozen run of exactly this cut: its address, both side snapshots, its truth and its deterministic findings. */
export function newTransitionRun(args: {
  cut: CutTransition;
  view: EpisodeEditView;
  userId: string | null;
  now: string;
}): NewTransitionRun {
  const { cut, view } = args;
  return {
    projectId: view.edit.projectId,
    analyzer: "deterministic",
    analyzerVersion: SEQUENCE_RULES_VERSION,
    analyzerKind: "deterministic",
    rulesVersion: cut.truth.rulesVersion,
    analysisStatus: "complete",
    subjectFingerprint: cut.truth.subjectFingerprint,
    criteriaFingerprint: cut.truth.criteriaFingerprint,
    referenceFingerprint: cut.truth.referenceFingerprint,
    referenceSet: { items: [...cut.left.references, ...cut.right.references] },
    subject: {
      editId: cut.address.editId,
      episodeId: view.edit.episodeId,
      editRevision: view.edit.revision,
      transitionKey: cut.transitionKey,
      leftItemId: cut.address.leftItemId,
      rightItemId: cut.address.rightItemId,
      leftShotId: cut.left.shotId,
      rightShotId: cut.right.shotId,
      leftSide: persistedCutSide(cut, "left"),
      rightSide: persistedCutSide(cut, "right"),
      crossesScene: cut.crossesScene,
    },
    findings: transitionFindings(cut),
    createdBy: args.userId,
    now: args.now,
  };
}

export async function recordTransitionRun(args: {
  qa: Pick<MediaQaRepository, "createTransitionRun">;
  data: ProjectData;
  /** `buildEpisodeEditView` of the edit as re-read now */
  view: EpisodeEditView;
  /** the truth of the cut the person reviewed */
  reviewed: TransitionRunTruth;
  userId: string | null;
  now: string;
}): Promise<TransitionRunView> {
  const cut = buildEpisodeCuts({ data: args.data, view: args.view }).find(
    (c) => c.transitionKey === args.reviewed.transitionKey,
  );
  if (!cut)
    throw new MediaQaError(
      "conflict",
      "This cut no longer exists in the edit (its items are not adjacent any more). Nothing was recorded.",
    );
  if (!sameTruth(cut.truth, args.reviewed))
    throw new MediaQaError("conflict", TRANSITION_TRUTH_CHANGED_MESSAGE);
  return args.qa.createTransitionRun(
    newTransitionRun({ cut, view: args.view, userId: args.userId, now: args.now }),
  );
}
