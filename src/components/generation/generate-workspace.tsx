import { buildGenerationRequest } from "@/domain/generation/gate";
import { isActive } from "@/domain/generation/job-state";
import { deriveShotGenerationState } from "@/domain/generation/lifecycle";
import { buildPromptPlan } from "@/domain/generation/prompt-plan";
import { generationSignature } from "@/domain/generation/signature";
import { renderGenerationBrief } from "@/domain/generation-package";
import type { ProjectData } from "@/domain/schemas";
import type { CompiledRequestSummary } from "@/generation/provider";
import { buildSharedEvaluation, evaluateShotForModel } from "@/generation/submission";
import { getGenerationRepo, getRegistry } from "@/server/generation";
import { AttemptCard } from "./attempt-card";
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

  const options: ModelOption[] = evaluations.map((e, i) => {
    const m = models[i]!;
    const a = e.availability!;
    const c = e.compatibility!;
    return {
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

  const slug = data.project.slug;
  const sorted = [...views].sort((a, b) => b.attempt.attemptNumber - a.attempt.attemptNumber);

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
      />

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
