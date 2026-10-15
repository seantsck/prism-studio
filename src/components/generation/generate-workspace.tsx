import { DURATION_LABELS, FRAMING_LABELS, type FramingStrategy } from "@/domain/framing/adaptation";
import { buildGenerationRequest } from "@/domain/generation/gate";
import { isActive } from "@/domain/generation/job-state";
import { deriveShotGenerationState } from "@/domain/generation/lifecycle";
import { buildPromptPlan } from "@/domain/generation/prompt-plan";
import { generationSignature } from "@/domain/generation/signature";
import { renderGenerationBrief } from "@/domain/generation-package";
import type { ProjectData } from "@/domain/schemas";
import type { CompiledRequestSummary } from "@/generation/provider";
import { buildSharedEvaluation, evaluateShotForModel } from "@/generation/submission";
import { loadAttemptMedia } from "@/server/attempt-media";
import { getGenerationConfig, getGenerationRepo, getRegistry } from "@/server/generation";
import { AttemptCard } from "./attempt-card";
import { assetUrl } from "@/lib/utils";
import {
  summarizeEvaluation,
  summarizePlan,
  variantKey,
  type AdaptationOptions,
  type VariantEvaluation,
} from "./adaptation-summary";
import { BenchmarkBanner } from "@/components/candidates/benchmark-banner";
import { ModelComparePanel } from "@/components/candidates/model-compare-panel";
import { buildModelComparison } from "@/generation/model-comparison";
import { getCandidateRepo } from "@/server/candidates";
import { GeneratePanel, type ModelOption } from "./generate-panel";
import { LifecycleBadge } from "./parts";
import { GenerationPoller } from "./poller";
import { PromptInspector } from "./prompt-inspector";

/**
 * The Generate workspace of Shot Prep: state, model choice with explicit compatibility, attempt history and
 * the prompt inspector. Reads narrow generation state; the project data is passed in by the page.
 */
export async function GenerateWorkspace({ data, shotId }: { data: ProjectData; shotId: string }) {
  const registry = getRegistry();
  const repo = await getGenerationRepo();
  const views = await repo.listShotAttempts(shotId);
  const shot = data.shots.find((s) => s.id === shotId)!;

  const shared = buildSharedEvaluation(data, shotId);
  const models = registry.models();
  const evaluations = models.map((m) =>
    evaluateShotForModel({ data, shotId, registry, provider: m.provider, modelId: m.modelId, shared }),
  );

  /**
   * Adaptation is an explicit user choice, so every reachable choice is evaluated up front (cheap, pure) and the
   * client panel just selects among the results: the server action re-evaluates the chosen one from fresh data.
   */
  const adaptationFor = (i: number): AdaptationOptions | null => {
    const m = models[i]!;
    const plan = evaluations[i]!.compatibility?.adaptation;
    if (!plan) return null;
    const needsFraming = plan.framing.status === "needs_choice" || plan.framing.status === "blocked";
    const needsDuration = plan.duration.status === "needs_choice" || plan.duration.status === "blocked";
    if (!needsFraming && !needsDuration) return null;
    const framings: string[] = needsFraming
      ? ["", ...plan.framing.options.filter((o) => o.usable).map((o) => o.strategy)]
      : [""];
    const durations: string[] = needsDuration
      ? [
          "",
          ...(plan.duration.recommended === "generate_longer_then_trim" ? ["generate_longer_then_trim"] : []),
        ]
      : [""];
    const variants: Record<string, VariantEvaluation> = {};
    for (const f of framings) {
      for (const d of durations) {
        const ev = evaluateShotForModel({
          data,
          shotId,
          registry,
          provider: m.provider,
          modelId: m.modelId,
          shared,
          adaptation: {
            framing: (f || null) as FramingStrategy | null,
            duration: (d || null) as "generate_longer_then_trim" | null,
          },
        });
        variants[variantKey(f, d)] = summarizeEvaluation(ev);
      }
    }
    return {
      needsFraming,
      needsDuration,
      framing: plan.framing.options.map((o) => ({
        strategy: o.strategy,
        label: FRAMING_LABELS[o.strategy],
        usable: o.usable,
        reason: o.reason,
        recommended: plan.framing.recommended === o.strategy,
      })),
      duration: needsDuration
        ? [
            {
              strategy: "generate_longer_then_trim",
              label: DURATION_LABELS.generate_longer_then_trim,
              usable: plan.duration.recommended === "generate_longer_then_trim",
              reason: plan.duration.reason,
              recommended: plan.duration.recommended === "generate_longer_then_trim",
            },
          ]
        : [],
      variants,
    };
  };

  const options: ModelOption[] = evaluations.map((e, i) => {
    const m = models[i]!;
    const a = e.availability!;
    const c = e.compatibility!;
    return {
      adaptation: adaptationFor(i),
      basePlan: summarizePlan(c.adaptation),
      key: `${m.provider}/${m.modelId}`,
      provider: m.provider,
      providerName: a.providerName,
      modelId: m.modelId,
      label: m.displayName,
      description: m.description,
      kind: m.kind,
      available: a.available,
      unavailableReason: !a.enabled
        ? "disabled"
        : !a.configured
          ? `not configured (${a.missingConfig.join(", ")})`
          : a.lifecycle === "retired"
            ? "retired"
            : !a.paidGenerationEnabled
              ? "paid generation is switched off"
              : null,
      modality: c.modality,
      compatible: c.compatible,
      errors: c.errors.map((x) => x.message),
      ignored: c.ignoredFeatures.map((f) => ({ id: f.id, label: f.label, impact: f.impact })),
      inputs: c.inputs.map((x) => ({ kind: x.kind, label: x.label, used: x.used })),
      duration: c.duration,
      estimate: e.estimate,
      blockers: e.gate.blockers.map((b) => b.message),
    };
  });

  const preferred =
    shot.generation.provider && shot.generation.model
      ? `${shot.generation.provider}/${shot.generation.model}`
      : null;
  const defaultOption =
    options.find((o) => o.key === preferred && o.available) ??
    options.find(
      (o) =>
        o.available &&
        o.compatible &&
        o.blockers.length === 0 &&
        o.kind === "mock" &&
        o.modelId === "mock-video-1",
    ) ??
    options.find((o) => o.available && o.compatible) ??
    options.find((o) => o.available) ??
    null;

  const state = deriveShotGenerationState({
    ready: shared.basePreflight.ready,
    attempts: views.map((v) => v.attempt),
    jobs: views.flatMap((v) => (v.job ? [v.job] : [])),
  });
  const activeJob = views.some((v) => v.job && isActive(v.job.status));
  const signature = generationSignature(
    views.map((v) => ({
      attemptId: v.attempt.id,
      jobStatus: v.job?.status ?? null,
      attemptStatus: v.attempt.status,
      review: v.attempt.reviewStatus,
      updatedAt: v.job?.updatedAt ?? null,
    })),
  );

  // Prompt inspector: current package, chosen model.
  let compiled: CompiledRequestSummary | null = null;
  const inspectIndex = defaultOption ? options.findIndex((o) => o.key === defaultOption.key) : -1;
  const inspected = inspectIndex >= 0 ? evaluations[inspectIndex]! : null;
  const plan = buildPromptPlan(shared.pkg);
  if (inspected?.model && inspected.compatibility?.compatible && inspected.compatibility.modality) {
    const adapter = registry.adapter(inspected.model.provider);
    if (adapter) {
      const req = buildGenerationRequest({
        pkg: shared.pkg,
        model: inspected.model,
        compatibility: inspected.compatibility,
        plan,
        idempotencyKey: "inspector-preview-key",
      });
      compiled = adapter.compileRequest(req, plan);
    }
  }

  // Phase 2E: model comparison + candidate sets (advisory; nothing here generates by itself)
  const candidateRepo = await getCandidateRepo();
  const outcomes = await candidateRepo.listOutcomeRecords(data.project.id);
  const comparison = buildModelComparison({ data, shotId, registry, outcomes });
  const cfg = getGenerationConfig();
  const setsForShot = await candidateRepo.listSets(data.project.id, { shotId, limit: 10 });

  const storyboardUrl = assetUrl(data.assets.find((x) => x.id === shared.ctx.approvedFrame?.assetId));
  const slug = data.project.slug;
  const sorted = [...views].sort((a, b) => b.attempt.attemptNumber - a.attempt.attemptNumber);
  const candidateOf = new Map<string, { setId: string; label: string; title: string }>();
  for (const s of setsForShot)
    for (const m of s.members)
      if (m.attemptId) candidateOf.set(m.attemptId, { setId: s.set.id, label: m.label, title: s.set.title });
  const mediaByAttempt = new Map(
    await Promise.all(sorted.map(async (v) => [v.attempt.id, await loadAttemptMedia(data, v)] as const)),
  );

  return (
    <div className="space-y-4" data-testid="generate-workspace">
      <div className="flex flex-wrap items-center gap-3">
        <LifecycleBadge state={state} />
        <span className="text-[11px] text-muted">
          package <span className="font-mono">{shared.pkg.provenance.fingerprint.slice(0, 8)}</span>
        </span>
        <GenerationPoller projectSlug={slug} shotId={shotId} signature={signature} active={activeJob} />
      </div>

      <GeneratePanel
        projectSlug={slug}
        shotId={shotId}
        options={options}
        defaultKey={defaultOption?.key ?? null}
        activeJob={activeJob}
        storyboardUrl={storyboardUrl}
        protectedNotes={shot.generation.protectedComposition}
      />

      <details className="border border-line bg-panel" data-testid="compare-models-section" open>
        <summary className="cursor-pointer px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
          Compare models for this shot (candidate set)
        </summary>
        <div className="space-y-2 p-3">
          {data.project.purpose !== "production" ? <BenchmarkBanner /> : null}
          <ModelComparePanel
            projectSlug={slug}
            shotId={shotId}
            rows={comparison.rows}
            historyNote={comparison.recommendation.historyNote}
            profileLabel={comparison.profileLabel}
            preference={comparison.recommendation.preference}
            coldStart={comparison.recommendation.coldStart}
            engineVersion={comparison.recommendation.engineVersion}
            maxCandidates={cfg.candidateSet.maxCandidates}
            setCeilingUsd={cfg.candidateSet.maxUsd}
            paidEnabled={cfg.paid.enabled}
          />
          {setsForShot.length > 0 ? (
            <div className="text-[11.5px]" data-testid="shot-candidate-sets">
              <span className="text-muted">Experiments for this shot: </span>
              {setsForShot.map((s) => (
                <a
                  key={s.set.id}
                  href={`/projects/${slug}/candidates/${s.set.id}`}
                  className="mr-3 underline"
                >
                  {s.set.title || "Candidate set"}
                </a>
              ))}
            </div>
          ) : null}
        </div>
      </details>

      <PromptInspector
        brief={renderGenerationBrief(shared.pkg)}
        plan={plan}
        compiled={compiled}
        heading="Prompt inspector (current shot)"
      />

      <div>
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
          Attempt history ({sorted.length})
        </h3>
        <div className="space-y-3" data-testid="attempt-history">
          {sorted.map((v, i) => {
            const prev = sorted[i + 1];
            return (
              <AttemptCard
                key={v.attempt.id}
                view={v}
                projectSlug={slug}
                media={mediaByAttempt.get(v.attempt.id) ?? null}
                candidate={candidateOf.get(v.attempt.id) ?? null}
                compareWith={prev ? { id: prev.attempt.id, number: prev.attempt.attemptNumber } : undefined}
              />
            );
          })}
          {sorted.length === 0 ? (
            <div className="border border-dashed border-line2 p-3 text-muted">
              No attempts yet. Every attempt is kept — rejected and failed ones included.
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
