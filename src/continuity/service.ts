import { buildShotContext } from "@/domain/context";
import { fingerprint } from "@/domain/hash";
import { parseAdaptationPlan, type GenerationAdaptationPlan } from "@/domain/framing/adaptation";
import { assembleGenerationPackage, type GenerationPackage } from "@/domain/generation-package";
import { criteriaFor, type ContinuityAnalyzer, type AnalyzerFrame } from "@/domain/continuity/analyzer";
import { runDeterministicChecks, type MediaFacts } from "@/domain/continuity/checks";
import {
  buildCriteria,
  buildReferenceSet,
  criteriaFingerprint,
  type ReferenceExtras,
} from "@/domain/continuity/criteria";
import {
  CONTINUITY_RULES_VERSION,
  type ContinuityCriterion,
  type ReferenceSet,
} from "@/domain/continuity/model";
import {
  effective,
  qaStatus,
  staleness,
  summarize,
  type EffectiveFinding,
  type ContinuitySummary,
  type QaStatus,
  type StaleReasons,
} from "@/domain/continuity/status";
import type { AttemptView } from "@/data/generation-repository";
import type {
  AttemptDelivery,
  ContinuityRun,
  ContinuityRunView,
  MediaQaRepository,
  NewFinding,
} from "@/data/media-qa-repository";
import type { Asset, ProjectData } from "@/domain/schemas";
import { ensureReviewArtifacts, readVerified, type DeliveryDeps } from "@/media/delivery";
import type { MediaProbe } from "@/media/types";

/**
 * Everything a QA run is judged from, derived from CURRENT production truth and the attempt's actual outputs.
 * Pure given its inputs: the server action creates a run from it, and the review page recomputes it to decide
 * whether an old run is stale (a run itself never changes).
 */
export interface QaInputs {
  pkg: GenerationPackage;
  adaptation: GenerationAdaptationPlan | null;
  criteria: ContinuityCriterion[];
  criteriaFingerprint: string;
  references: ReferenceSet;
  /** The asset judged: selected delivery master, else the provider's primary output (null: no output yet). */
  subject: Asset | null;
  original: Asset | null;
  subjectIsOriginal: boolean;
  subjectFingerprint: string;
  packageFingerprint: string;
  outputCount: number;
  /** Explicit production pixel size from the bible (null: only the aspect ratio is production truth). */
  deliverySize: { width: number; height: number } | null;
}

export function computeQaInputs(args: {
  data: ProjectData;
  view: AttemptView;
  delivery: AttemptDelivery | null;
  now?: Date;
}): QaInputs | null {
  const { data, view, delivery } = args;
  const shot = data.shots.find((s) => s.id === view.attempt.shotId);
  if (!shot) return null;
  const ctx = buildShotContext(data, shot.id);
  const pkg = assembleGenerationPackage(ctx, args.now);
  const adaptation = parseAdaptationPlan(view.attempt.adaptationPlan);

  const primary =
    view.outputs.find((o) => o.output.role === "primary")?.asset ?? view.outputs[0]?.asset ?? null;
  const selected = delivery ? (data.assets.find((a) => a.id === delivery.assetId) ?? null) : null;
  const subject = selected ?? primary;
  const original = primary;
  const subjectIsOriginal = !subject || !original ? true : subject.id === original.id;

  const deliverySize =
    data.bible.deliveryWidth && data.bible.deliveryHeight
      ? { width: data.bible.deliveryWidth, height: data.bible.deliveryHeight }
      : null;
  const criteria = buildCriteria({
    pkg,
    adaptation,
    protectedComposition: shot.generation.protectedComposition,
    deliverySize,
  });

  const extras: ReferenceExtras = { previousShotOutput: null, nextShotStoryboard: null };
  const prevId = pkg.continuity.previousShot?.id;
  if (prevId) {
    const prevAttempt = data.attempts.find((a) => a.shotId === prevId && a.approved && a.outputAssetId);
    const asset = prevAttempt ? data.assets.find((a) => a.id === prevAttempt.outputAssetId) : null;
    if (asset) {
      extras.previousShotOutput = {
        assetId: asset.id,
        checksum: asset.checksum,
        label: `Previous shot ${pkg.continuity.previousShot?.code} (approved output)`,
      };
    }
  }
  const nextId = pkg.continuity.nextShot?.id;
  if (nextId) {
    const frame = data.frames.find((f) => f.shotId === nextId && f.approved && f.assetId);
    const asset = frame ? data.assets.find((a) => a.id === frame.assetId) : null;
    if (asset) {
      extras.nextShotStoryboard = {
        assetId: asset.id,
        checksum: asset.checksum,
        label: `Next shot ${pkg.continuity.nextShot?.code} (storyboard)`,
      };
    }
  }

  return {
    pkg,
    adaptation,
    criteria,
    criteriaFingerprint: criteriaFingerprint(criteria),
    references: buildReferenceSet(pkg, adaptation, extras),
    subject,
    original,
    subjectIsOriginal,
    subjectFingerprint: fingerprint({
      subject: subject ? [subject.id, subject.checksum] : null,
      original: original ? [original.id, original.checksum] : null,
      adaptation: adaptation?.fingerprint ?? null,
    }),
    packageFingerprint: pkg.provenance.fingerprint,
    outputCount: view.outputs.length,
    deliverySize,
  };
}

// ───────────────────────── projection of a stored run ─────────────────────────

export interface RunProjection {
  view: ContinuityRunView;
  findings: EffectiveFinding[];
  summary: ContinuitySummary;
  status: QaStatus;
  analyzerKind: "mock" | "model" | "none";
  freshness: StaleReasons | null;
}

export function projectRun(view: ContinuityRunView, current: QaInputs | null): RunProjection {
  const findings = view.findings.map(({ finding, overrides }) =>
    effective(
      {
        id: finding.id,
        criterionKey: finding.criterionKey,
        category: finding.category,
        severity: finding.severity,
        systemResult: finding.result,
      },
      overrides.map((o) => ({
        result: o.result,
        notes: o.notes,
        createdAt: o.createdAt,
        createdBy: o.createdBy,
      })),
    ),
  );
  const summary = summarize(findings);
  const analysisDone = view.run.analysisStatus === "complete" || view.run.analysisStatus === "failed";
  return {
    view,
    findings,
    summary,
    status: qaStatus({
      hasRun: true,
      analysisComplete: analysisDone,
      finalized: view.run.finalizedAt !== null,
      summary,
    }),
    analyzerKind:
      view.run.analyzerKind === "mock" ? "mock" : view.run.analyzerKind === "model" ? "model" : "none",
    freshness: current
      ? staleness(
          {
            subjectFingerprint: view.run.subjectFingerprint,
            criteriaFingerprint: view.run.criteriaFingerprint,
            referenceFingerprint: view.run.referenceFingerprint,
            packageFingerprint: view.run.packageFingerprint,
          },
          {
            subjectFingerprint: current.subjectFingerprint,
            criteriaFingerprint: current.criteriaFingerprint,
            referenceFingerprint: current.references.fingerprint,
            packageFingerprint: current.packageFingerprint,
          },
        )
      : null,
  };
}

// ───────────────────────── running a review ─────────────────────────

export interface RunDeps extends DeliveryDeps {
  analyzer: ContinuityAnalyzer | null;
}

const toFacts = (asset: Asset, p: MediaProbe): MediaFacts => ({
  assetId: asset.id,
  checksum: asset.checksum,
  kind: p.kind,
  container: p.container,
  videoCodec: p.videoCodec,
  audioCodec: p.audioCodec,
  width: p.width,
  height: p.height,
  fps: p.fps,
  durationMs: p.durationMs,
  hasAudio: p.hasAudio,
  byteSize: p.byteSize,
});

/**
 * Creates a QA run: freezes criteria, references and subject; fills in the deterministic results; extracts the
 * review frames and contact sheet; then runs the analyzer (queued → running → complete|failed). Advisory only:
 * nothing here changes creative review state.
 */
export async function runContinuityReview(args: {
  inputs: QaInputs;
  view: AttemptView;
  deps: RunDeps;
}): Promise<ContinuityRunView> {
  const { inputs, view, deps } = args;
  const { subject } = inputs;
  if (!subject) throw new Error("This attempt has no output to review.");
  const now = () => (deps.now?.() ?? new Date()).toISOString();
  const attemptLabel = `a${view.attempt.attemptNumber}`;

  const bytes = await readVerified(subject, deps.storage);
  const probe = await deps.processor.probe(bytes);

  const pkg = inputs.pkg;
  const deterministic = runDeterministicChecks(inputs.criteria, {
    subject: toFacts(subject, probe),
    subjectIsOriginal: inputs.subjectIsOriginal,
    outputCount: inputs.outputCount,
    adaptation: inputs.adaptation,
    production: {
      aspectRatio: pkg.style.aspectRatio || null,
      durationMs: pkg.timing.durationMs > 0 ? pkg.timing.durationMs : null,
      fps: pkg.generation.fps || null,
      deliverySize: inputs.deliverySize,
      expectsAudio: pkg.performance.some((p) => p.selectedTake?.audioAssetId),
    },
  });
  const byKey = new Map(deterministic.map((r) => [r.criterionKey, r]));

  const findings: NewFinding[] = inputs.criteria.map((c) => {
    const r = byKey.get(c.key);
    return {
      criterionKey: c.key,
      category: c.category,
      severity: c.severity,
      title: c.title,
      sourceRef: c.sourceRef,
      expected: c.expected,
      actual: r?.actual ?? "",
      result: r?.result ?? "unchecked",
      resultSource: r ? r.source : "none",
      confidence: r?.confidence ?? null,
      notes: r?.notes ?? "",
      evidence: r?.evidence ?? {},
      position: c.position,
    };
  });

  const analyzer = deps.analyzer;
  const run = await deps.qa.createRun(
    {
      projectId: view.attempt.projectId,
      attemptId: view.attempt.id,
      subjectAssetId: subject.id,
      originalAssetId: inputs.original?.id ?? null,
      analyzer: analyzer?.id ?? "deterministic",
      analyzerVersion: analyzer?.version ?? CONTINUITY_RULES_VERSION,
      analyzerKind: analyzer ? analyzer.kind : "deterministic",
      rulesVersion: CONTINUITY_RULES_VERSION,
      analysisStatus: "queued",
      packageFingerprint: inputs.packageFingerprint,
      subjectFingerprint: inputs.subjectFingerprint,
      criteriaFingerprint: inputs.criteriaFingerprint,
      referenceFingerprint: inputs.references.fingerprint,
      referenceSet: JSON.parse(JSON.stringify(inputs.references)) as Record<string, unknown>,
      createdBy: deps.userId,
      now: now(),
    },
    findings,
  );

  try {
    await deps.qa.setAnalysisStatus(run.run.id, "running", now());
    // Review frames (first / 25% / 50% / 75% / last) + contact sheet are derived assets: idempotent per output.
    let frames: AnalyzerFrame[] = [];
    try {
      const art = await ensureReviewArtifacts({ attemptId: view.attempt.id, attemptLabel, subject, deps });
      frames = art.frames.map((f) => ({
        atMs: f.atMs,
        assetId: f.derived.asset.id,
        checksum: f.derived.asset.checksum,
      }));
    } catch {
      // A missing frame set never fails the review: the deterministic findings are already recorded.
      frames = [];
    }
    if (analyzer) {
      const mine = criteriaFor(analyzer, inputs.criteria);
      if (mine.length > 0) {
        const results = await analyzer.analyze({
          runId: run.run.id,
          attemptId: view.attempt.id,
          subject: { assetId: subject.id, checksum: subject.checksum, kind: probe.kind },
          frames,
          references: inputs.references.items,
          criteria: mine,
        });
        await deps.qa.applyAnalysis(
          run.run.id,
          results.map((r) => ({ ...r, evidence: r.evidence as Record<string, unknown> })),
        );
      }
    }
    await deps.qa.setAnalysisStatus(run.run.id, "complete", now());
  } catch (err) {
    await deps.qa.setAnalysisStatus(
      run.run.id,
      "failed",
      now(),
      err instanceof Error ? err.message.slice(0, 300) : "Analysis failed",
    );
  }
  return (await deps.qa.getRun(run.run.id)) ?? run;
}

/** Helper for read paths: the latest run of an attempt, projected against current truth. */
export async function latestProjection(
  qa: MediaQaRepository,
  attemptId: string,
  current: QaInputs | null,
): Promise<RunProjection | null> {
  const runs = await qa.listAttemptRuns(attemptId);
  return runs[0] ? projectRun(runs[0], current) : null;
}

export type { ContinuityRun };
