import type { ContinuityAnalysisProvider } from "@/continuity/analysis/provider";
import { PageHeader } from "@/components/ui";
import { QaPolicyForm } from "@/components/continuity/qa-policy-form";
import { analysisSpendBlockers } from "@/domain/continuity/analysis/cost";
import {
  getAnalysisConfig,
  getAnalyzerStatuses,
  getMediaQaRepo,
  getPreviewProviders,
} from "@/server/media-qa";
import { requireProject } from "@/server/repo";

export const dynamic = "force-dynamic";

/** Phase 3A.2: the Project's Shot QA automation policy (owner only, RLS-bound). */
function sequenceCapability(provider: ContinuityAnalysisProvider | undefined) {
  if (!provider?.modes().includes("sequence_transition"))
    return { available: false, label: "cannot analyse cuts on this server" };
  const c = provider.crossCutCalibration();
  if (c.acceptedFamilies.length === 0)
    return { available: false, label: "no cut family has passed calibration on this configuration" };
  const eyeline = c.acceptedFamilies.includes("eyeline") ? "" : "; eyeline unavailable";
  return {
    available: true,
    label: `${c.acceptedFamilies.length} cut families accepted (${c.version})${eyeline}`,
  };
}

export default async function ShotQaSettingsPage({ params }: { params: Promise<{ project: string }> }) {
  const { project: slug } = await params;
  const data = await requireProject(slug);
  const qa = await getMediaQaRepo();
  const policy = await qa.getQaPolicy(data.project.id);
  const sequenceReady = await qa.sequenceAutomationReady();
  const config = getAnalysisConfig();
  const providers = getPreviewProviders();
  const analyzers = getAnalyzerStatuses().map((s) => ({
    id: s.id,
    label: `${s.providerName} · ${s.modelLabel}`,
    kind: s.kind,
    usable: s.usable || s.kind === "mock",
    // 3A.3: what this server can do with video for this analyzer (the Project permission is separate)
    temporal: providers.get(s.id)?.modes().includes("direct_video")
      ? { available: true, label: "temporal QA available (video capable, server enabled)" }
      : s.id === "gemini"
        ? { available: false, label: "server disabled (direct video is off on this server)" }
        : { available: false, label: "this analyzer does not support temporal video" },
    // 3A.4F: only a calibrated family can run; the analyzer's own decision, on this server's exact configuration
    sequence: sequenceCapability(providers.get(s.id)),
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
              directVideoAllowed: policy.directVideoAllowed,
              sequenceSemanticMode: policy.sequenceSemanticMode,
              maxTransitionsPerBatch: policy.maxTransitionsPerBatch,
              revision: policy.revision,
            }}
            analyzers={analyzers}
            sequenceReady={sequenceReady}
          />
        </section>
      </div>
    </div>
  );
}
