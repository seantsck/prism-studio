import { BenchmarkBanner } from "@/components/candidates/benchmark-banner";
import { Badge, PageHeader, Panel } from "@/components/ui";
import { catalogModel, defaultTier } from "@/domain/generation/models/catalog";
import type { CatalogModel, Support } from "@/domain/generation/models/types";
import { generationModelHealth } from "@/domain/generation/model-health";
import {
  aggregateByModel,
  aggregateByModelAndBucket,
  aggregateByProvider,
  providerReliability,
  RELIABILITY_NOTE,
} from "@/domain/generation/performance";
import { NEGATIVE_LABELS, POSITIVE_LABELS } from "@/domain/generation/reviews";
import { getCandidateRepo } from "@/server/candidates";
import { getRegistry } from "@/server/generation";
import { requireProject } from "@/server/repo";

export const dynamic = "force-dynamic";

const money = (n: number | null) => (n == null ? "—" : `$${n.toFixed(n < 1 ? 3 : 2)}`);
const dur = (ms: number | null) => (ms == null ? "—" : `${Math.round(ms / 1000)} s`);
const SUP: Record<Support, string> = { supported: "yes", unsupported: "no", unknown: "unknown" };
const supTone = (s: Support) => (s === "supported" ? "pass" : s === "unsupported" ? "neutral" : "warn");

const HEALTH_TONE = {
  recent_success: "pass",
  configured: "neutral",
  disabled: "neutral",
  not_configured: "warn",
  unavailable: "fail",
  rate_limited: "warn",
  recent_provider_failure: "fail",
} as const;

/** Production utility, not a marketing catalog: what each model can do, what it costs, how it has done HERE. */
export default async function ModelsPage({ params }: { params: Promise<{ project: string }> }) {
  const { project: slug } = await params;
  const data = await requireProject(slug);
  const registry = getRegistry();
  const candidates = await getCandidateRepo();
  const outcomes = await candidates.listOutcomeRecords(data.project.id);
  // A benchmark project shows ITS OWN data, labelled; a production project never sees benchmark data here.
  const scope = data.project.purpose !== "production" ? "benchmark" : "production";
  const byModel = new Map(
    aggregateByModel(outcomes, scope).map((p) => [`${p.provider}/${p.model}`, p] as const),
  );
  const buckets = aggregateByModelAndBucket(outcomes, scope).filter((b) => b.reviewed > 0);
  const providers = aggregateByProvider(outcomes, scope).filter((p) => p.reviewed > 0);
  const reliabilityByModel = new Map(
    providerReliability(outcomes, scope).map((r) => [`${r.provider}/${r.model}`, r] as const),
  );
  const models = registry.models().filter((m) => m.capabilities.video != null);

  return (
    <div data-testid="models-page">
      <PageHeader
        title="Models"
        subtitle="Capabilities, versioned pricing and this project's human-review history. Advisory: Prism never switches models for you."
      />
      <div className="space-y-4 p-6">
        {data.project.purpose !== "production" ? <BenchmarkBanner /> : null}
        {models.map((m) => {
          const cat = catalogModel(m.provider, m.modelId);
          const a = registry.availabilityOf(m);
          const perf = byModel.get(`${m.provider}/${m.modelId}`) ?? null;
          const records = outcomes.filter((o) => o.provider === m.provider && o.model === m.modelId);
          const health = generationModelHealth({
            enabled: a.enabled,
            configured: a.configured,
            available: a.lifecycle !== "retired" && cat?.availability !== "unavailable",
            records,
          });
          return (
            <Panel
              key={`${m.provider}/${m.modelId}`}
              title={
                <>
                  {m.displayName} <span className="text-faint normal-case">· {a.providerName}</span>
                </>
              }
              actions={
                <span className="flex items-center gap-1.5">
                  {m.kind === "mock" ? <Badge>mock · free</Badge> : null}
                  <span data-testid="model-health">
                    <Badge tone={HEALTH_TONE[health.state]}>{health.state.replace(/_/g, " ")}</Badge>
                  </span>
                </span>
              }
            >
              <div data-testid="model-card" data-model={m.modelId}>
                <p className="mb-2 text-[11.5px] text-muted">{m.description}</p>
                <div className="grid gap-4 md:grid-cols-3">
                  <Capabilities m={m} cat={cat} />
                  <Pricing m={m} cat={cat} />
                  <div className="text-[11.5px]">
                    <div className="mb-1 text-[10.5px] uppercase tracking-wide text-muted">
                      Human history here
                    </div>
                    {perf && perf.reviewed > 0 ? (
                      <ul className="space-y-0.5" data-testid="model-history-stats">
                        <li>
                          Reviewed {perf.reviewed} · good {perf.approved} · shortlisted {perf.shortlisted} ·
                          rejected {perf.rejected}
                        </li>
                        <li>
                          Preferred wins {perf.preferredWins} · generated {perf.generated}
                        </li>
                        <li>
                          Common rejections:{" "}
                          {perf.topRejectionReasons.length
                            ? perf.topRejectionReasons
                                .map((r) => `${NEGATIVE_LABELS[r.tag]} ×${r.count}`)
                                .join(", ")
                            : "—"}
                        </li>
                        <li>
                          Strengths:{" "}
                          {perf.topStrengths.length
                            ? perf.topStrengths.map((r) => `${POSITIVE_LABELS[r.tag]} ×${r.count}`).join(", ")
                            : "—"}
                        </li>
                        <li>
                          Avg actual cost {money(perf.avgActualCostUsd)} · median generation{" "}
                          {dur(perf.medianGenerationMs)} · median total {dur(perf.medianTotalMs)}
                        </li>
                        <li>
                          Positive per $10: {perf.positivePer10Usd ?? "—"} · cost per positive{" "}
                          {money(perf.avgCostPerPositiveUsd)}
                        </li>
                        <li className="text-faint">{RELIABILITY_NOTE[perf.reliability]}</li>
                      </ul>
                    ) : (
                      <p className="text-faint">No reviewed generations of this model in this project yet.</p>
                    )}
                    {(() => {
                      const r = reliabilityByModel.get(`${m.provider}/${m.modelId}`);
                      return r ? (
                        <p className="mt-1 text-[11px]" data-testid="model-reliability">
                          Provider reliability (operational, not creative quality): {r.succeeded}/{r.terminal}{" "}
                          succeeded
                          {r.providerFailed ? ` · ${r.providerFailed} provider failure` : ""}
                          {r.invalidRequest ? ` · ${r.invalidRequest} invalid request` : ""}
                          {r.ambiguousSubmission ? ` · ${r.ambiguousSubmission} ambiguous submission` : ""}
                          {r.otherFailed ? ` · ${r.otherFailed} other` : ""}. Tiny sample, not a trend.
                        </p>
                      ) : null;
                    })()}
                    <p className="mt-1 text-[10.5px] text-faint">Health: {health.note}</p>
                  </div>
                </div>
              </div>
            </Panel>
          );
        })}

        <Panel title="By shot type (reviewed generations)">
          {buckets.length === 0 ? (
            <p className="text-[11.5px] text-faint">Review candidates to build this table.</p>
          ) : (
            <table className="w-full text-[11.5px]" data-testid="bucket-table">
              <thead>
                <tr className="text-left text-[10.5px] uppercase tracking-wide text-muted">
                  <th className="py-1">Shot type</th>
                  <th>Model</th>
                  <th>Liked / reviewed</th>
                  <th>Rejected</th>
                  <th>Wins</th>
                  <th>Sample</th>
                </tr>
              </thead>
              <tbody>
                {buckets.map((b) => (
                  <tr key={`${b.bucket}/${b.provider}/${b.model}`} className="border-t border-line">
                    <td className="py-1">{b.bucket}</td>
                    <td>{b.model}</td>
                    <td className="tabular-nums">
                      {b.approved + b.shortlisted}/{b.reviewed}
                    </td>
                    <td className="tabular-nums">{b.rejected}</td>
                    <td className="tabular-nums">{b.preferredWins}</td>
                    <td className="text-faint">{b.reliability.replace("_", " ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title="By provider">
          {providers.length === 0 ? (
            <p className="text-[11.5px] text-faint">No reviewed generations yet.</p>
          ) : (
            <ul className="text-[11.5px]">
              {providers.map((p) => (
                <li key={p.provider}>
                  {p.provider}: {p.approved + p.shortlisted}/{p.reviewed} liked · {p.rejected} rejected ·{" "}
                  {money(p.spendUsd)} spent
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}

function Capabilities({
  m,
  cat,
}: {
  m: ReturnType<ReturnType<typeof getRegistry>["models"]>[number];
  cat: CatalogModel | null;
}) {
  const v = m.capabilities.video!;
  const durText = v.allowedDurationsMs?.length
    ? v.allowedDurationsMs.map((x) => `${x / 1000}s`).join(" / ")
    : `${v.minDurationMs / 1000}–${v.maxDurationMs / 1000} s${v.durationStepMs ? ` (${v.durationStepMs / 1000} s steps)` : ""}`;
  const refs = m.capabilities.references;
  return (
    <div className="text-[11.5px]">
      <div className="mb-1 text-[10.5px] uppercase tracking-wide text-muted">Capabilities</div>
      <ul className="space-y-0.5">
        <li>
          Duration: {durText}
          {cat && !cat.duration.verified ? <span className="text-warn"> · bounds unverified</span> : null}
        </li>
        <li>Ratios: {v.aspectRatios.join(", ")}</li>
        {cat ? <li>Tiers: {cat.tiers.map((t) => t.id).join(", ")}</li> : null}
        <li>
          Start frame{" "}
          <Badge tone={cat ? supTone(cat.inputs.startFrame) : refs.startFrame ? "pass" : "neutral"}>
            {cat ? SUP[cat.inputs.startFrame] : refs.startFrame ? "yes" : "no"}
          </Badge>{" "}
          End frame{" "}
          <Badge tone={cat ? supTone(cat.inputs.endFrame) : refs.endFrame ? "pass" : "neutral"}>
            {cat ? SUP[cat.inputs.endFrame] : refs.endFrame ? "yes" : "no"}
          </Badge>
        </li>
        <li>
          Reference images:{" "}
          {refs.referenceImages
            ? `up to ${refs.maxReferences}`
            : cat
              ? SUP[cat.inputs.referenceImages]
              : "no"}
          {cat?.inputs.keyframesExcludeReferences === "supported" ? " · exclusive with first/last frame" : ""}
        </li>
        <li>
          Reference video: {cat ? SUP[cat.inputs.referenceVideo] : refs.referenceVideo ? "yes" : "no"} ·
          audio: {cat ? SUP[cat.inputs.referenceAudio] : refs.referenceAudio ? "yes" : "no"}
        </li>
        <li>
          Negative prompt: {cat ? SUP[cat.inputs.negativePrompt] : refs.negativePrompt ? "yes" : "no"} ·
          provider audio:{" "}
          {cat ? SUP[cat.audio.nativeGeneration] : m.capabilities.audio.nativeDialogueAudio ? "yes" : "no"}
        </li>
        {cat ? (
          <li className="text-faint">
            Verified {cat.verification.verifiedAt} · {cat.verification.sdkVersion} · API{" "}
            {cat.verification.providerApiVersion}
            {cat.verification.unstated.length > 0
              ? ` · not stated: ${cat.verification.unstated.join("; ")}`
              : ""}
          </li>
        ) : null}
      </ul>
    </div>
  );
}

function Pricing({
  m,
  cat,
}: {
  m: ReturnType<ReturnType<typeof getRegistry>["models"]>[number];
  cat: CatalogModel | null;
}) {
  if (!cat) {
    return (
      <div className="text-[11.5px]">
        <div className="mb-1 text-[10.5px] uppercase tracking-wide text-muted">Pricing</div>
        {m.kind === "mock" ? "Free (mock provider)." : "No catalog pricing."}
      </div>
    );
  }
  const first = defaultTier(cat);
  return (
    <div className="text-[11.5px]">
      <div className="mb-1 text-[10.5px] uppercase tracking-wide text-muted">
        Pricing · {cat.pricing.version} · verified {cat.pricing.verifiedAt}
      </div>
      <ul className="space-y-0.5" data-testid="pricing-list">
        {Object.entries(cat.pricing.rule.perSecond).map(([tier, r]) => (
          <li key={tier}>
            {tier === "default" && cat.tiers.length === 1 ? "per second" : tier}: {r.silent} cr/s
            {r.audio != null ? ` · ${r.audio} cr/s with audio` : ""} ≈ $
            {(r.silent * cat.pricing.usdPerCredit).toFixed(2)}/s
          </li>
        ))}
        {cat.pricing.rule.perReferenceImage > 0 ? (
          <li>+{cat.pricing.rule.perReferenceImage} cr per reference image / keyframe</li>
        ) : null}
        {cat.pricing.rule.minimumCredits != null ? (
          <li>minimum {cat.pricing.rule.minimumCredits} cr per generation</li>
        ) : null}
        <li className="text-faint">
          ${cat.pricing.usdPerCredit}/credit · default tier {first.id}. Historical spend is never re-priced.
        </li>
      </ul>
    </div>
  );
}
