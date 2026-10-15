import { createHash } from "node:crypto";
import { CONTINUITY_RULES_VERSION } from "@/domain/continuity/model";
import type { AttemptView } from "@/data/generation-repository";
import { MediaQaError, type AnalysisJob, type ContinuityRunView } from "@/data/media-qa-repository";
import { RUBRIC_VERSION } from "@/domain/continuity/analysis/types";
import type { Asset } from "@/domain/schemas";
import { ensureReviewArtifacts, readVerified, type DeliveryDeps } from "@/media/delivery";
import { deterministicFindings, type QaInputs } from "@/continuity/service";
import type { AnalysisSpendPolicy } from "@/domain/continuity/analysis/cost";
import { analysisSpendBlockers } from "@/domain/continuity/analysis/cost";
import { buildAnalysisInput, buildAnalysisMedia, inputAssetIdsOf, type OutputMediaSet } from "./prepare";
import type { ContinuityAnalysisProvider } from "./provider";

export class AnalysisSubmitError extends Error {
  constructor(
    readonly code: "spend_blocked" | "needs_ack" | "no_output" | "nothing_to_analyse" | "limit",
    message: string,
  ) {
    super(message);
    this.name = "AnalysisSubmitError";
  }
}

/** Stable per (attempt, subject, criteria, references, analyzer, model, prompt+rubric) + a client nonce. */
export function analysisIdempotencyKey(
  inputs: QaInputs,
  provider: ContinuityAnalysisProvider,
  nonce: string,
): string {
  return createHash("sha256")
    .update(
      [
        inputs.subjectFingerprint,
        inputs.criteriaFingerprint,
        inputs.references.fingerprint,
        provider.id,
        provider.version,
        provider.model,
        RUBRIC_VERSION,
        nonce,
      ].join("|"),
    )
    .digest("hex");
}

/**
 * Creates the run + frozen input + queued job. Does NOT call any analyzer: execution belongs to the worker.
 *  1. ensures review frames/contact sheet exist (bounded local media work, idempotent);
 *  2. builds the deterministic plan, manifest and estimate;
 *  3. applies the analysis spend gate (server-side policy only) and the acknowledgement requirement;
 *  4. writes everything atomically.
 */
export async function submitAnalysis(args: {
  inputs: QaInputs;
  view: AttemptView;
  assets: Asset[];
  provider: ContinuityAnalysisProvider;
  policy: AnalysisSpendPolicy;
  deps: DeliveryDeps;
  acknowledged: boolean;
  nonce: string;
  limits: { maxActivePerProject: number; maxJobAttempts: number };
  now?: Date;
}): Promise<{ run: ContinuityRunView; job: AnalysisJob; duplicate: boolean }> {
  const { inputs, view, provider, deps } = args;
  const subject = inputs.subject;
  if (!subject) throw new AnalysisSubmitError("no_output", "This attempt has no output to analyse.");
  const now = args.now ?? deps.now?.() ?? new Date();
  const attemptLabel = `a${view.attempt.attemptNumber}`;

  const art = await ensureReviewArtifacts({ attemptId: view.attempt.id, attemptLabel, subject, deps });
  const output: OutputMediaSet = {
    frames: art.frames.map((f) => ({ atMs: f.atMs, asset: f.derived.asset })),
    contactSheet: art.contactSheet?.asset ?? null,
  };
  const assets = [
    ...args.assets,
    ...art.frames.map((f) => f.derived.asset),
    ...(art.contactSheet ? [art.contactSheet.asset] : []),
  ];
  const media = buildAnalysisMedia({ inputs, assets, output, subject });
  const key = analysisIdempotencyKey(inputs, provider, args.nonce);
  const input = {
    ...buildAnalysisInput({ inputs, media, provider, runKey: key.slice(0, 16), subject }),
    attemptId: view.attempt.id,
  };
  if (input.plan.batches.length === 0) {
    throw new AnalysisSubmitError(
      "nothing_to_analyse",
      "No criterion can be analysed automatically with this analyzer (all are deterministic, manual, unsupported or lack media).",
    );
  }

  const estimate = provider.estimate(input, now);
  const maxUsd = Number.isFinite(estimate.maxUsd) ? estimate.maxUsd : null;
  if (provider.kind === "model") {
    const since = new Date(now.getTime() - 24 * 3600_000).toISOString();
    const spent = await deps.qa.analysisSpentSince(null, since);
    const blockers = analysisSpendBlockers({
      policy: args.policy,
      maxEstimateUsd: maxUsd,
      spentLast24hUsd: spent,
    });
    if (blockers.length > 0)
      throw new AnalysisSubmitError("spend_blocked", blockers.map((b) => b.message).join(" "));
    if (!args.acknowledged) {
      throw new AnalysisSubmitError(
        "needs_ack",
        "Acknowledge the estimated analysis cost and the media sent to the external analyzer to continue.",
      );
    }
  }

  const bytes = await readVerified(subject, deps.storage);
  const probe = await deps.processor.probe(bytes);
  const findings = deterministicFindings(inputs, subject, probe);

  try {
    return await deps.qa.createAnalysisRunWithJob({
      run: {
        projectId: view.attempt.projectId,
        attemptId: view.attempt.id,
        subjectAssetId: subject.id,
        originalAssetId: inputs.original?.id ?? null,
        analyzer: provider.id,
        analyzerVersion: provider.version,
        analyzerKind: provider.kind,
        rulesVersion: CONTINUITY_RULES_VERSION,
        analysisStatus: "queued",
        packageFingerprint: inputs.packageFingerprint,
        subjectFingerprint: inputs.subjectFingerprint,
        criteriaFingerprint: inputs.criteriaFingerprint,
        referenceFingerprint: inputs.references.fingerprint,
        referenceSet: JSON.parse(JSON.stringify(inputs.references)) as Record<string, unknown>,
        createdBy: deps.userId,
        now: now.toISOString(),
        analysisPlan: input.plan,
        externalManifest: input.plan.manifest,
        promptVersion: input.plan.batches[0]?.promptVersion ?? null,
        rubricVersion: RUBRIC_VERSION,
        model: provider.model,
      },
      findings,
      job: {
        idempotencyKey: key,
        analyzer: provider.id,
        model: provider.model,
        snapshot: input,
        inputAssetIds: inputAssetIdsOf(input),
        maxAttempts: args.limits.maxJobAttempts,
        estimate: {
          maxUsd,
          expectedUsd: Number.isFinite(estimate.expectedUsd) ? estimate.expectedUsd : null,
          usage: { tokens: estimate.tokens, basis: estimate.basis },
          pricingVersion: estimate.pricingVersion,
        },
      },
      limits: { maxActivePerProject: args.limits.maxActivePerProject },
    });
  } catch (err) {
    if (err instanceof MediaQaError && err.code === "invalid")
      throw new AnalysisSubmitError("limit", err.message);
    throw err;
  }
}
