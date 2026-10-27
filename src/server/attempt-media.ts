import "server-only";
import { computeQaInputs, projectRun, type QaInputs, type RunProjection } from "@/continuity/service";
import { approvalAdvisories, type QaStatus } from "@/domain/continuity/status";
import { NO_SHOT_QA, type ShotQaAssessment } from "@/domain/continuity/shot-qa";
import { parseAdaptationPlan, type GenerationAdaptationPlan } from "@/domain/framing/adaptation";
import type { AttemptView } from "@/data/generation-repository";
import type { AttemptDelivery, DerivedAsset } from "@/data/media-qa-repository";
import type { Asset, ProjectData } from "@/domain/schemas";
import { getMediaQaRepo } from "./media-qa";

/** Everything the review UI needs about one attempt's media + QA, from narrow queries. */
export interface AttemptMedia {
  plan: GenerationAdaptationPlan | null;
  original: Asset | null;
  /** The selected delivery master; equals `original` when no conform was needed or chosen. */
  delivery: { asset: Asset; selection: AttemptDelivery | null; isOriginal: boolean } | null;
  /** Conformed delivery versions, newest first (crop v1, v2...). */
  versions: DerivedAsset[];
  frames: Array<{ atMs: number; asset: Asset }>;
  contactSheet: Asset | null;
  inputs: QaInputs | null;
  latestRun: RunProjection | null;
  allRuns: RunProjection[];
  qaStatus: QaStatus;
  qaStale: boolean;
  advisories: string[];
  /** 3A.1: the advisory Shot QA decision projection of the latest run (NO_SHOT_QA when none exists). */
  shotQa: ShotQaAssessment;
}

export async function loadAttemptMedia(data: ProjectData, view: AttemptView): Promise<AttemptMedia> {
  const qa = await getMediaQaRepo();
  const [selection, derivations, runs] = await Promise.all([
    qa.getDelivery(view.attempt.id),
    qa.listAttemptDerivations(view.attempt.id),
    qa.listAttemptRuns(view.attempt.id),
  ]);
  const inputs = computeQaInputs({ data, view, delivery: selection });
  const original = inputs?.original ?? null;
  const deliveryAsset = inputs?.subject ?? null;
  const projections = runs.map((r) => projectRun(r, inputs));
  const latest = projections[0] ?? null;

  const subjectId = latest?.view.run.subjectAssetId ?? deliveryAsset?.id ?? original?.id ?? null;
  const frames = derivations
    .filter((d) => d.derivation.operation === "frame_extract" && d.derivation.parentAssetId === subjectId)
    .map((d) => ({ atMs: Number(d.derivation.parameters.atMs ?? 0), asset: d.asset }))
    .sort((a, b) => a.atMs - b.atMs);
  const sheet =
    derivations
      .filter((d) => d.derivation.operation === "contact_sheet" && d.derivation.parentAssetId === subjectId)
      .at(-1)?.asset ?? null;

  const qaStatus: QaStatus = latest ? latest.status : "not_started";
  const qaStale = latest?.freshness?.stale ?? false;
  return {
    plan: parseAdaptationPlan(view.attempt.adaptationPlan),
    original,
    delivery: deliveryAsset
      ? { asset: deliveryAsset, selection, isOriginal: original ? deliveryAsset.id === original.id : true }
      : null,
    versions: derivations
      .filter((d) => d.derivation.slot === "delivery")
      .sort((a, b) => b.derivation.version - a.derivation.version),
    frames,
    contactSheet: sheet,
    inputs,
    latestRun: latest,
    allRuns: projections,
    qaStatus,
    qaStale,
    advisories: approvalAdvisories({
      status: qaStatus,
      stale: qaStale,
      summary: latest?.summary ?? null,
    }),
    shotQa: latest?.assessment ?? NO_SHOT_QA,
  };
}
