import { PageHeader } from "@/components/ui";
import { QaPolicyForm } from "@/components/continuity/qa-policy-form";
import { analysisSpendBlockers } from "@/domain/continuity/analysis/cost";
import { getAnalysisConfig, getAnalyzerStatuses, getMediaQaRepo } from "@/server/media-qa";
import { requireProject } from "@/server/repo";

export const dynamic = "force-dynamic";

/** Phase 3A.2: the Project's Shot QA automation policy (owner only, RLS-bound). */
export default async function ShotQaSettingsPage({ params }: { params: Promise<{ project: string }> }) {
  const { project: slug } = await params;
  const data = await requireProject(slug);
  const policy = await (await getMediaQaRepo()).getQaPolicy(data.project.id);
  const config = getAnalysisConfig();
  const analyzers = getAnalyzerStatuses().map((s) => ({
    id: s.id,
    label: `${s.providerName} · ${s.modelLabel}`,
    kind: s.kind,
    usable: s.usable || s.kind === "mock",
    blockers: [
      ...(s.missingConfig.length ? [`missing ${s.missingConfig.join(", ")}.`] : []),
      ...(s.kind === "model"
        ? analysisSpendBlockers({ policy: config.paid, maxEstimateUsd: 0, spentLast24hUsd: 0 }).map(
            (b) => b.message,
          )
        : []),
    ],
  }));
  return (
    <div>
      <PageHeader
        title="Shot QA automation"
        subtitle="QA advises; a person decides. Automation never approves, rejects, retries or regenerates anything."
      />
      <div className="max-w-3xl space-y-4 p-6" data-testid="qa-settings">
        <section
          className="border border-line bg-panel p-3 text-[12px]"
          data-testid="qa-deterministic-always"
        >
          <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted">
            Automatic deterministic QA · Always on
          </h2>
          <p className="mt-1 text-muted">
            When a generated Shot becomes reviewable, or its delivery master changes, Prism checks duration,
            aspect ratio, resolution, frame rate, container, audio and the delivery master on this server. No
            external model, no AI fee, nothing leaves Prism. It runs whenever you next have Prism open.
          </p>
        </section>
        <section className="border border-line bg-panel p-3" data-testid="qa-policy">
          <div className="mb-2 text-[11px] text-faint" data-testid="qa-policy-revision">
            Policy revision {policy.revision}
            {policy.revision === 0 ? " (never saved: semantic automation is off)" : ""}
          </div>
          <QaPolicyForm
            projectSlug={slug}
            initial={{
              semanticMode: policy.semanticMode,
              analyzer: policy.analyzer,
              externalMediaAllowed: policy.externalMediaAllowed,
              maxCostPerRunUsd: policy.maxCostPerRunUsd,
              maxCostPerDayUsd: policy.maxCostPerDayUsd,
              revision: policy.revision,
            }}
            analyzers={analyzers}
          />
        </section>
      </div>
    </div>
  );
}
