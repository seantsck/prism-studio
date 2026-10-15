import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import {
  AnalysisLauncher,
  AnalysisPoller,
  type AnalyzerPreview,
} from "@/components/continuity/analysis-launcher";
import { SeekButton } from "@/components/continuity/seek-button";
import { StageChips } from "@/components/generation/attempt-media-panel";
import { OutputPreview } from "@/components/generation/parts";
import { Badge, Button, PageHeader } from "@/components/ui";
import { previewAnalysis, type OutputMediaSet } from "@/continuity/analysis/prepare";
import type { RunProjection } from "@/continuity/service";
import {
  ANALYSIS_STATUS_LABELS,
  isAnalysisActive,
  type AnalysisJobStatus,
} from "@/domain/continuity/analysis/job-state";
import {
  CATEGORY_LABELS,
  CONTINUITY_RESULTS,
  RESULT_LABELS,
  type ContinuityResult,
} from "@/domain/continuity/model";
import {
  QA_STATUS_LABELS,
  SEVERITY_LABELS,
  describeSummary,
  type EffectiveFinding,
  type QaStatus,
} from "@/domain/continuity/status";
import type { AnalysisCost } from "@/data/media-qa-repository";
import { assetUrl } from "@/lib/utils";
import { providerHealth } from "@/domain/continuity/analysis/health";
import { currentFailedAnalysis } from "@/domain/continuity/analysis/latest";
import { modelDisplay, providerDisplayName } from "@/continuity/analysis/models";
import { loadAttemptMedia } from "@/server/attempt-media";
import { getGenerationRepo } from "@/server/generation";
import {
  cancelContinuityAnalysis,
  finalizeContinuityReview,
  overrideFinding,
  startContinuityReview,
} from "@/server/media-actions";
import {
  getAnalysisConfig,
  getAnalyzerStatuses,
  getMediaQaRepo,
  getPreviewProviders,
} from "@/server/media-qa";
import { requireProject } from "@/server/repo";

export const dynamic = "force-dynamic";

type Tone = "neutral" | "pass" | "warn" | "fail" | "info" | "accent";
const RESULT_TONE: Record<ContinuityResult, Tone> = {
  pass: "pass",
  warn: "warn",
  fail: "fail",
  n_a: "neutral",
  unchecked: "neutral",
};
const QA_TONE: Record<QaStatus, Tone> = {
  not_started: "neutral",
  in_review: "info",
  passed: "pass",
  passed_with_warnings: "warn",
  failed: "fail",
};
const SEVERITY_TONE: Record<EffectiveFinding["severity"], Tone> = {
  critical: "fail",
  major: "warn",
  minor: "neutral",
};
const RESULT_ORDER: ContinuityResult[] = ["fail", "warn", "pass", "unchecked", "n_a"];
const SEVERITIES = ["critical", "major", "minor"] as const;
const SOURCE_LABEL: Record<string, string> = {
  reference_image: "REFERENCE IMAGE",
  output_frame: "OUTPUT FRAME",
  contact_sheet: "CONTACT SHEET",
  video: "VIDEO",
  metadata: "DETERMINISTIC METADATA",
};

interface EvidenceItem {
  input: string;
  assetId: string | null;
  atMs: number | null;
  observation: string;
  source: string;
}
interface AnalysisEvidence {
  items?: EvidenceItem[];
  contradictions?: string[];
  limitations?: string[];
  analyzer?: string;
  model?: string;
}

/** Module-level so the render stays free of direct clock/random calls (analysis spend window, form nonce). */
const hoursAgoIso = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
const newNonce = () => crypto.randomUUID();

const usd = (n: number | null | undefined) =>
  n == null ? "unknown" : n === 0 ? "$0" : `$${n.toFixed(n < 0.01 ? 5 : 4)}`;

/**
 * Continuity review workspace for one attempt. QA ADVISES; a person decides. Three SEPARATE things are shown:
 * deterministic QA, semantic (analyzer) analysis, and human review. Nothing here approves or rejects the shot.
 */
export default async function ContinuityPage({
  params,
  searchParams,
}: {
  params: Promise<{ project: string; attemptId: string }>;
  searchParams: Promise<{ run?: string }>;
}) {
  const { project: slug, attemptId } = await params;
  const { run: runParam } = await searchParams;
  const data = await requireProject(slug);
  const repo = await getGenerationRepo();
  const view = await repo.getAttemptView(attemptId);
  if (!view || view.attempt.projectId !== data.project.id) notFound();
  const media = await loadAttemptMedia(data, view);
  const qa = await getMediaQaRepo();
  const jobs = await qa.listAttemptAnalysisJobs(attemptId);
  const shot = data.shots.find((s) => s.id === view.attempt.shotId);
  const runs = media.allRuns;
  const selected: RunProjection | null = runs.find((r) => r.view.run.id === runParam) ?? runs[0] ?? null;
  const run = selected?.view.run ?? null;
  const subject = run ? (data.assets.find((a) => a.id === run.subjectAssetId) ?? null) : null;
  const original = run?.originalAssetId
    ? (data.assets.find((a) => a.id === run.originalAssetId) ?? null)
    : null;
  const references = ((run?.referenceSet as { items?: Array<Record<string, unknown>> } | undefined)?.items ??
    []) as Array<{
    role: string;
    label: string;
    assetId: string | null;
    checksum: string | null;
    text: string | null;
  }>;
  const assetById = new Map(data.assets.map((a) => [a.id, a] as const));
  const hidden = (
    <>
      <input type="hidden" name="projectSlug" value={slug} />
      <input type="hidden" name="attemptId" value={attemptId} />
    </>
  );

  // ── costs per run (analysis accounting is separate from generation) ──
  const costsByRun = new Map<string, AnalysisCost[]>();
  for (const r of runs) costsByRun.set(r.view.run.id, await qa.listAnalysisCosts(r.view.run.id));
  const jobByRun = new Map(jobs.map((j) => [j.runId, j] as const));
  const activeJobs = jobs.filter((j) => isAnalysisActive(j.status));

  // ── what an automated analysis would do, per analyzer (no side effects) ──
  const config = getAnalysisConfig();
  const statuses = getAnalyzerStatuses();
  const previews: AnalyzerPreview[] = [];
  let launchBlockedReason: string | null = null;
  if (view.attempt.status !== "succeeded") launchBlockedReason = "Needs a completed generation.";
  else if (!media.inputs?.subject) launchBlockedReason = "This attempt has no output to analyse.";
  else if (activeJobs.length > 0) launchBlockedReason = "An analysis is already running for this attempt.";
  if (media.inputs?.subject) {
    const output: OutputMediaSet = {
      frames: media.frames.map((f) => ({ atMs: f.atMs, asset: f.asset })),
      contactSheet: media.contactSheet,
    };
    const since = hoursAgoIso(24);
    const spent = await qa.analysisSpentSince(null, since);
    for (const st of statuses) {
      const provider = getPreviewProviders().get(st.id);
      if (!provider) continue;
      const { preview } = previewAnalysis({
        inputs: media.inputs,
        assets: data.assets,
        output,
        subject: media.inputs.subject,
        provider,
        policy: config.paid,
        spentLast24hUsd: spent,
        now: new Date(),
      });
      const sent = preview.plan.manifest.entries.filter((e) => e.sent);
      previews.push({
        id: st.id,
        label: st.label,
        providerName: st.providerName,
        modelLabel: st.modelLabel,
        health: providerHealth({
          providerId: st.id,
          configState: st.state,
          jobs: jobs.map((j) => ({
            analyzer: j.analyzer,
            status: j.status,
            lastErrorCategory: j.lastErrorCategory,
            finishedAt: j.completedAt ?? j.failedAt ?? j.cancelledAt,
          })),
        }),
        model: st.model,
        kind: st.kind,
        state: st.state,
        spend: st.spend,
        usable: st.usable || st.kind === "mock",
        missingConfig: st.missingConfig,
        mode: preview.mode,
        framesPending: preview.framesPending,
        counts: preview.summary,
        unsupported: preview.plan.items
          .filter((i) => i.status === "unsupported" || i.status === "no_media")
          .map((i) => ({ key: i.criterionKey, reason: i.reason })),
        sent: sent.map((e) => ({ inputId: e.inputId, role: e.role, kind: e.kind, label: e.role })),
        omitted: preview.plan.manifest.entries
          .filter((e) => !e.sent && e.omissionReason === "input_budget")
          .map((e) => ({ inputId: e.inputId, role: e.role, reason: e.omissionReason ?? "" })),
        estimate: {
          expectedUsd: Number.isFinite(preview.estimate.expectedUsd) ? preview.estimate.expectedUsd : null,
          maxUsd: Number.isFinite(preview.estimate.maxUsd) ? preview.estimate.maxUsd : null,
          basis: preview.estimate.basis,
          pricingVersion: preview.estimate.pricingVersion,
        },
        blockers: preview.blockers.map((b) => b.message),
        requiresAcknowledgement: preview.requiresAcknowledgement,
      });
    }
  }

  // ── findings grouped by severity, then result ──
  const rows = selected ? selected.findings.map((eff, i) => ({ eff, f: selected.view.findings[i]! })) : [];
  const closed = Boolean(run?.finalizedAt);
  const planItem = (key: string) => run?.analysisPlan?.items.find((i) => i.criterionKey === key) ?? null;
  const refsFor = (key: string) => {
    const batchId = planItem(key)?.batchId;
    const batch = run?.analysisPlan?.batches.find((b) => b.id === batchId);
    if (!batch || !run?.externalManifest) return [];
    return batch.referenceInputIds.flatMap((id) => {
      const e = run.externalManifest!.entries.find((x) => x.inputId === id);
      return e ? [e] : [];
    });
  };

  const semantic = (() => {
    const latestJob = selected ? jobByRun.get(selected.view.run.id) : undefined;
    if (!selected) return { label: "not run", tone: "neutral" as Tone };
    if (selected.view.run.analyzerKind === "deterministic" || selected.view.run.analyzerKind === "manual")
      return { label: "not run", tone: "neutral" as Tone };
    if (latestJob) {
      const t: Tone =
        latestJob.status === "failed" ? "fail" : latestJob.status === "succeeded" ? "pass" : "info";
      return {
        label: `${selected.view.run.analyzer} · ${ANALYSIS_STATUS_LABELS[latestJob.status as AnalysisJobStatus].toLowerCase()}`,
        tone: t,
      };
    }
    return {
      label: `${selected.view.run.analyzer} · ${selected.view.run.analysisStatus}`,
      tone: "info" as Tone,
    };
  })();
  const overrideCount = rows.filter((r) => r.f.overrides.length > 0).length;
  const signature = jobs.map((j) => `${j.id}:${j.status}:${j.batchesDone}`).join("|");

  return (
    <div>
      <PageHeader
        title={`Continuity review — ${shot?.shotCode ?? ""} attempt ${view.attempt.attemptNumber}`}
        subtitle="QA advises; a person decides. Nothing here approves or rejects the shot."
        actions={
          <StageChips
            attempt={view.attempt}
            generated={{
              label: view.attempt.status,
              tone: view.attempt.status === "succeeded" ? "pass" : "neutral",
            }}
            qaStatus={selected?.status ?? "not_started"}
            qaStale={selected?.freshness?.stale ?? false}
          />
        }
      />
      <div className="space-y-4 p-6" data-testid="continuity-page">
        <div className="flex flex-wrap items-center gap-3 text-[12px]">
          <Link className="text-accent hover:underline" href={`/projects/${slug}/generations/${attemptId}`}>
            ← Attempt
          </Link>
          {shot ? (
            <span className="text-muted">
              {shot.shotCode} · {shot.title}
            </span>
          ) : null}
          <ActionForm action={startContinuityReview} successMessage="New review created" quiet>
            {hidden}
            <Button size="sm" type="submit" data-testid="new-review">
              {run ? "Start a new review (re-run)" : "Start continuity review"}
            </Button>
          </ActionForm>
          <AnalysisPoller
            projectSlug={slug}
            attemptId={attemptId}
            signature={signature}
            active={activeJobs.length > 0}
          />
        </div>

        {/* three separate statuses: never one overloaded check */}
        <div className="grid gap-3 md:grid-cols-3" data-testid="qa-status-strip">
          <div className="border border-line bg-panel p-2.5">
            <div className="text-[10.5px] uppercase tracking-wide text-muted">Deterministic QA</div>
            <div className="mt-0.5 text-[12px]" data-testid="status-deterministic">
              {selected ? "complete (metadata checks)" : "not run"}
            </div>
          </div>
          <div className="border border-line bg-panel p-2.5">
            <div className="text-[10.5px] uppercase tracking-wide text-muted">Semantic analysis</div>
            <div className="mt-0.5 flex items-center gap-2 text-[12px]" data-testid="status-semantic">
              <Badge tone={semantic.tone}>{semantic.label}</Badge>
              {activeJobs.map((j) => (
                <span key={j.id} className="text-faint">
                  {j.batchesDone}/{j.batchesTotal} requests
                </span>
              ))}
            </div>
          </div>
          <div className="border border-line bg-panel p-2.5">
            <div className="text-[10.5px] uppercase tracking-wide text-muted">Human review</div>
            <div className="mt-0.5 text-[12px]" data-testid="status-human">
              {closed
                ? "reviewed"
                : overrideCount > 0
                  ? `in progress · ${overrideCount} decision(s)`
                  : "not reviewed"}
            </div>
          </div>
        </div>

        {previews.length > 0 ? (
          <AnalysisLauncher
            projectSlug={slug}
            attemptId={attemptId}
            analyzers={previews}
            defaultId={previews.find((p) => p.kind === "mock")?.id ?? previews[0]!.id}
            nonce={newNonce()}
            canRun={launchBlockedReason === null}
            runDisabledReason={launchBlockedReason}
          />
        ) : null}

        {activeJobs.length > 0 ? (
          <div className="border border-info/40 bg-info/5 p-2.5 text-[12px]" data-testid="analysis-progress">
            {activeJobs.map((j) => (
              <div key={j.id} className="flex flex-wrap items-center gap-3">
                <Badge tone="info">{ANALYSIS_STATUS_LABELS[j.status]}</Badge>
                <span>
                  {j.analyzer} · {j.model} · {j.batchesDone}/{j.batchesTotal} batches · {j.transportCalls}{" "}
                  provider request(s)
                </span>
                {j.status === "queued" && j.attemptCount > 0 && j.lastErrorCategory ? (
                  <span className="text-warn" data-testid="retry-scheduled">
                    Provider busy ({(j.lastErrorCategory ?? "overloaded").replace(/_/g, " ")}): nothing was
                    processed. Next attempt scheduled automatically at{" "}
                    {new Date(j.nextRunAt).toISOString().slice(11, 19)} UTC.
                  </span>
                ) : null}
                <ActionForm action={cancelContinuityAnalysis} quiet successMessage="Cancellation requested">
                  {hidden}
                  <input type="hidden" name="jobId" value={j.id} />
                  <Button size="sm" variant="danger" type="submit" data-testid="cancel-analysis">
                    Cancel analysis
                  </Button>
                </ActionForm>
              </div>
            ))}
          </div>
        ) : null}
        {/* only the LATEST job can be "the last analysis"; older failures live in history and provider health */}
        {[currentFailedAnalysis(jobs)]
          .filter((j): j is NonNullable<typeof j> => j !== null)
          .map((j) => (
            <div
              key={j.id}
              className="border border-fail/40 bg-fail/5 p-2.5 text-[12px]"
              role="status"
              data-testid="analysis-failed"
            >
              Last analysis failed ({j.lastErrorCategory?.replace(/_/g, " ")}): {j.lastErrorMessage}
              {j.lastErrorCategory === "outcome_unknown"
                ? " Prism does not re-send automatically because the request may already have been processed."
                : ""}
              {j.lastErrorCategory === "provider_overloaded_retry_exhausted"
                ? " Every request was confirmed rejected by the provider, so nothing was analysed. It is safe to start a new analysis later."
                : ""}
              {j.lastErrorCategory === "local_policy_block"
                ? " Prism's own limit stopped the request before it was sent."
                : ""}
            </div>
          ))}

        {!selected || !run ? (
          <div className="border border-dashed border-line2 p-6 text-muted" data-testid="no-review">
            No continuity review has been run for this attempt.
          </div>
        ) : (
          <>
            {selected.freshness?.stale ? (
              <div
                className="border border-warn/40 bg-warn/5 p-2.5 text-[12px]"
                role="status"
                data-testid="stale-banner"
              >
                <div className="font-semibold text-warn">This review is stale</div>
                <ul className="list-disc pl-4 text-muted">
                  {selected.freshness.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
                <p className="mt-1 text-faint">
                  It is kept exactly as it was. Start a new review to judge the current output and production
                  truth.
                </p>
              </div>
            ) : null}

            <section className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
              <div className="space-y-2 border border-line bg-panel p-3">
                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted">
                  Output examined
                  {original && subject && original.id !== subject.id ? " (delivery master)" : ""}
                </h3>
                {subject ? (
                  <>
                    <OutputPreview asset={subject} className="max-h-72 w-full border border-line bg-black" />
                    <div className="font-mono text-[11px] text-muted">
                      {subject.name} · {subject.width}×{subject.height}
                      {subject.durationMs ? ` · ${(subject.durationMs / 1000).toFixed(2)}s` : ""}
                      {original && original.id !== subject.id ? " · derived from provider original" : ""}
                    </div>
                  </>
                ) : (
                  <div className="text-muted">The examined asset is no longer in the library.</div>
                )}
                {media.contactSheet ? (
                  <div data-testid="contact-sheet">
                    <div className="mb-1 text-[10.5px] uppercase tracking-wide text-muted">Contact sheet</div>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={assetUrl(media.contactSheet)!}
                      alt="Contact sheet"
                      className="w-full border border-line"
                    />
                  </div>
                ) : null}
                {media.frames.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {media.frames.map((f) => (
                      <div key={f.asset.id} className="w-24">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={assetUrl(f.asset)!}
                          alt={`Frame at ${f.atMs} ms`}
                          className="w-full border border-line"
                        />
                        <div className="text-center font-mono text-[10px] text-faint">
                          {(f.atMs / 1000).toFixed(2)}s
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>

              <div className="space-y-3">
                <div className="border border-line bg-panel p-3" data-testid="qa-status">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted">
                      Run {run.runNumber}
                    </h3>
                    <Badge tone={QA_TONE[selected.status]}>{QA_STATUS_LABELS[selected.status]}</Badge>
                    {selected.analyzerKind === "mock" ? <Badge tone="info">MOCK ANALYSIS</Badge> : null}
                    {selected.analyzerKind === "model" ? (
                      <Badge tone="accent">{run.model ?? "model"}</Badge>
                    ) : null}
                    {run.analysisStatus !== "complete" ? (
                      <Badge tone="warn">analysis {run.analysisStatus}</Badge>
                    ) : null}
                  </div>
                  <ul className="space-y-0.5 text-[12px] text-muted" data-testid="qa-lines">
                    {describeSummary(selected.summary, selected.analyzerKind).map((l) => (
                      <li key={l}>{l}</li>
                    ))}
                  </ul>
                  <div className="mt-2 grid grid-cols-3 gap-2 text-[11.5px]" data-testid="severity-tally">
                    {SEVERITIES.map((s) => {
                      const of = rows.filter((r) => r.eff.severity === s && r.eff.result !== "n_a");
                      const passed = of.filter((r) => r.eff.result === "pass").length;
                      const failed = of.filter((r) => r.eff.result === "fail").length;
                      const warn = of.filter((r) => r.eff.result === "warn").length;
                      return (
                        <div key={s} className="border border-line bg-bg p-1.5">
                          <div className="text-[10px] uppercase text-muted">{SEVERITY_LABELS[s]}</div>
                          <div>
                            {passed} passed
                            {failed ? ` · ${failed} failed` : ""}
                            {warn ? ` · ${warn} warning` : ""}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px] text-faint">
                    <dt>Analyzer</dt>
                    <dd>
                      {providerDisplayName(run.analyzer)} {run.analyzerVersion} ({run.analyzerKind})
                      {run.model ? ` · ${modelDisplay(run.analyzer, run.model)}` : ""}
                    </dd>
                    <dt>Prompt / rubric</dt>
                    <dd>
                      {run.promptVersion ?? "—"} · {run.rubricVersion ?? run.rulesVersion}
                    </dd>
                    <dt>Checked</dt>
                    <dd>{new Date(run.createdAt).toLocaleString()}</dd>
                    <dt>Cost</dt>
                    <dd data-testid="run-cost">
                      {(() => {
                        const cs = costsByRun.get(run.id) ?? [];
                        const fin = cs.find((c) => c.kind !== "estimated");
                        const est = cs.find((c) => c.kind === "estimated");
                        if (!est && !fin) return "no analysis cost recorded";
                        return `estimated ${usd(est?.amountUsd)} · actual ${fin ? (fin.kind === "actual" ? usd(fin.amountUsd) : "unknown") : "—"}`;
                      })()}
                    </dd>
                    <dt>Package</dt>
                    <dd className="font-mono">{run.packageFingerprint.slice(0, 12)}</dd>
                    {run.finalizedAt ? (
                      <>
                        <dt>Closed</dt>
                        <dd>
                          {new Date(run.finalizedAt).toLocaleString()}
                          {run.finalizeNote ? ` — ${run.finalizeNote}` : ""}
                        </dd>
                      </>
                    ) : null}
                  </dl>
                  {!closed && run.analysisStatus !== "queued" && run.analysisStatus !== "running" ? (
                    <ActionForm
                      action={finalizeContinuityReview}
                      className="mt-2 space-y-1.5"
                      successMessage="Review closed"
                    >
                      {hidden}
                      <input type="hidden" name="runId" value={run.id} />
                      <input
                        name="note"
                        placeholder="Note (e.g. warnings accepted: lighting slightly warm)"
                      />
                      <Button size="sm" variant="primary" type="submit" data-testid="finalize-review">
                        Mark continuity reviewed
                      </Button>
                    </ActionForm>
                  ) : null}
                  {selected.summary.criticalFailures > 0 ? (
                    <p className="mt-2 text-[11.5px] text-fail" data-testid="critical-note">
                      A critical failure is recorded: this review cannot end as &ldquo;passed&rdquo;. The
                      output is not rejected; you decide what to do next.
                    </p>
                  ) : null}
                </div>

                {run.externalManifest ? (
                  <div className="border border-line bg-panel p-3" data-testid="external-manifest">
                    <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
                      What the external analyzer received
                    </h3>
                    {(() => {
                      const sent = run.externalManifest!.entries.filter((e) => e.sent);
                      const omitted = run.externalManifest!.entries.filter(
                        (e) => !e.sent && e.omissionReason === "input_budget",
                      );
                      return (
                        <>
                          <p className="text-[12px]">
                            {run.externalManifest!.analyzer === "mock-continuity"
                              ? "Nothing left Prism (mock analyzer)."
                              : `${sent.filter((e) => e.kind !== "reference").length} output image(s), ${sent.filter((e) => e.kind === "reference").length} reference image(s) and ${run.externalManifest!.criteriaSent} criteria text(s) sent to ${providerDisplayName(run.externalManifest!.analyzer)} · ${modelDisplay(run.externalManifest!.analyzer, run.externalManifest!.model)}.`}
                          </p>
                          {omitted.length > 0 ? (
                            <p className="text-[11.5px] text-warn">
                              Not sent due to the input budget: {omitted.map((e) => e.inputId).join(", ")}
                            </p>
                          ) : null}
                          <ul className="mt-1 max-h-28 space-y-0.5 overflow-auto font-mono text-[10.5px] text-faint">
                            {sent.map((e) => (
                              <li key={e.inputId}>
                                {e.inputId} · {e.checksum?.slice(0, 10) ?? "no checksum"}
                                {e.derivative?.width
                                  ? ` · sent at ${e.derivative.width}×${e.derivative.height}`
                                  : ""}
                              </li>
                            ))}
                          </ul>
                        </>
                      );
                    })()}
                  </div>
                ) : null}

                <div className="border border-line bg-panel p-3" data-testid="reference-set">
                  <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
                    Reference set ({references.length}) · frozen
                  </h3>
                  <ul className="space-y-1 text-[12px]">
                    {references.map((r, i) => (
                      <li key={i} className="flex items-start gap-2">
                        <span className="w-24 shrink-0 font-mono text-[10.5px] text-faint">{r.role}</span>
                        <span className="min-w-0">
                          <span>{r.label}</span>
                          {r.text ? (
                            <span className="block whitespace-pre-wrap text-[11px] text-muted">{r.text}</span>
                          ) : null}
                          {r.checksum ? (
                            <span className="block font-mono text-[10px] text-faint">
                              {r.checksum.slice(0, 12)}
                            </span>
                          ) : null}
                        </span>
                        {r.assetId && assetById.get(r.assetId)?.type === "image" ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={`/api/assets/${r.assetId}`}
                            alt=""
                            className="ml-auto h-10 w-auto border border-line"
                          />
                        ) : null}
                      </li>
                    ))}
                    {references.length === 0 ? <li className="text-muted">No references recorded.</li> : null}
                  </ul>
                </div>
              </div>
            </section>

            <section className="space-y-3" data-testid="criteria">
              {SEVERITIES.map((sev) => {
                const group = rows
                  .filter((r) => r.eff.severity === sev)
                  .sort(
                    (a, b) =>
                      RESULT_ORDER.indexOf(a.eff.result) - RESULT_ORDER.indexOf(b.eff.result) ||
                      a.f.finding.position - b.f.finding.position,
                  );
                if (group.length === 0) return null;
                return (
                  <div key={sev} className="border border-line bg-panel" data-testid={`group-${sev}`}>
                    <h3 className="flex items-center gap-2 border-b border-line px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
                      <Badge tone={SEVERITY_TONE[sev]}>{SEVERITY_LABELS[sev]}</Badge>
                      <span>
                        {group.length} criteri{group.length === 1 ? "on" : "a"}
                      </span>
                    </h3>
                    <div className="space-y-2 p-3">
                      {group.map(({ eff, f }) => {
                        const fd = f.finding;
                        const ev = fd.evidence as AnalysisEvidence;
                        const items = ev.items ?? [];
                        const refs = refsFor(fd.criterionKey);
                        return (
                          <div
                            key={eff.id}
                            className="grid gap-2 border border-line bg-bg p-2 text-[12px] md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto]"
                            data-testid="criterion"
                            data-key={fd.criterionKey}
                            data-result={eff.result}
                            data-severity={eff.severity}
                          >
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span className="font-medium">{fd.title}</span>
                                <span className="text-[10.5px] text-faint">
                                  {CATEGORY_LABELS[fd.category as keyof typeof CATEGORY_LABELS] ??
                                    fd.category}
                                </span>
                              </div>
                              <div className="text-muted">Expected: {fd.expected || "—"}</div>
                              <div className="text-[11px] text-faint">Source: {fd.sourceRef || "—"}</div>
                              {fd.actual ? <div className="text-muted">Observed: {fd.actual}</div> : null}
                              {ev.contradictions?.length ? (
                                <ul
                                  className="list-disc pl-4 text-[11.5px] text-fail"
                                  data-testid="contradictions"
                                >
                                  {ev.contradictions.map((c) => (
                                    <li key={c}>{c}</li>
                                  ))}
                                </ul>
                              ) : null}
                              {ev.limitations?.length ? (
                                <div className="text-[11px] text-faint" data-testid="limitations">
                                  Limitations: {ev.limitations.join("; ")}
                                </div>
                              ) : null}
                              {fd.notes && !ev.limitations?.length ? (
                                <div className="text-[11px] text-faint">{fd.notes}</div>
                              ) : null}

                              {items.length > 0 || refs.length > 0 ? (
                                <div className="mt-1.5 grid gap-2 sm:grid-cols-2" data-testid="evidence">
                                  <div>
                                    <div className="mb-0.5 text-[10px] uppercase tracking-wide text-muted">
                                      Expected references
                                    </div>
                                    <div className="flex flex-wrap gap-1">
                                      {refs.map((r) => (
                                        <div
                                          key={r.inputId}
                                          className="w-16"
                                          title={`${r.role} · ${r.inputId}`}
                                        >
                                          {/* eslint-disable-next-line @next/next/no-img-element */}
                                          <img
                                            src={`/api/assets/${r.assetId}`}
                                            alt={r.role}
                                            className="w-full border border-line"
                                          />
                                          <div className="truncate text-center font-mono text-[9px] text-faint">
                                            {r.role}
                                          </div>
                                        </div>
                                      ))}
                                      {refs.length === 0 ? (
                                        <span className="text-[11px] text-faint">none sent</span>
                                      ) : null}
                                    </div>
                                  </div>
                                  <div>
                                    <div className="mb-0.5 text-[10px] uppercase tracking-wide text-muted">
                                      Output evidence
                                    </div>
                                    <div className="flex flex-wrap gap-1">
                                      {items.map((it, k) => (
                                        <div key={k} className="w-20" title={it.observation}>
                                          {it.assetId && assetById.get(it.assetId)?.type !== "video" ? (
                                            // eslint-disable-next-line @next/next/no-img-element
                                            <img
                                              src={`/api/assets/${it.assetId}`}
                                              alt={it.input}
                                              className="w-full border border-line"
                                            />
                                          ) : (
                                            <div className="flex h-10 items-center justify-center border border-line text-[9px] text-faint">
                                              {it.source === "video" ? "video" : "n/a"}
                                            </div>
                                          )}
                                          <div className="text-center font-mono text-[9px] text-faint">
                                            {it.atMs != null ? `${(it.atMs / 1000).toFixed(2)}s` : it.input}
                                          </div>
                                          <div
                                            className="text-center text-[9px] text-accent"
                                            data-testid="evidence-source"
                                          >
                                            {SOURCE_LABEL[it.source] ?? it.source}
                                          </div>
                                        </div>
                                      ))}
                                    </div>
                                    {items.map((it, k) => (
                                      <p key={k} className="text-[11px] text-muted">
                                        <span className="font-mono text-faint">{it.input}</span>{" "}
                                        {it.atMs != null && subject?.type === "video" ? (
                                          <SeekButton atMs={it.atMs} />
                                        ) : null}{" "}
                                        — {it.observation}
                                      </p>
                                    ))}
                                  </div>
                                </div>
                              ) : null}
                            </div>
                            <div className="space-y-1">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span title="System result" data-testid="system-result">
                                  <Badge tone={RESULT_TONE[eff.systemResult]}>
                                    {RESULT_LABELS[eff.systemResult]}
                                  </Badge>
                                </span>
                                <span className="text-[10.5px] text-faint">
                                  {fd.resultSource === "deterministic"
                                    ? "deterministic check"
                                    : fd.resultSource === "analyzer"
                                      ? `${selected.analyzerKind === "mock" ? "MOCK ANALYSIS" : `${run.analyzer} analysis`}${
                                          fd.confidence != null
                                            ? ` · analysis confidence ${(fd.confidence * 100).toFixed(0)}% (advisory)`
                                            : ""
                                        }`
                                      : "nobody has judged this yet"}
                                </span>
                              </div>
                              {eff.override ? (
                                <div className="text-[11.5px]" data-testid="override-note">
                                  <Badge tone={RESULT_TONE[eff.override.result]}>
                                    Human: {RESULT_LABELS[eff.override.result]}
                                  </Badge>{" "}
                                  <span className="text-muted">
                                    {eff.override.notes || "no note"} ·{" "}
                                    {new Date(eff.override.createdAt).toLocaleString()}
                                  </span>
                                  {f.overrides.length > 1 ? (
                                    <span className="block text-[10.5px] text-faint">
                                      {f.overrides.length - 1} earlier decision(s) kept in history
                                    </span>
                                  ) : null}
                                </div>
                              ) : null}
                            </div>
                            {!closed ? (
                              <ActionForm
                                action={overrideFinding}
                                className="flex flex-col gap-1"
                                successMessage="Recorded"
                                quiet
                              >
                                {hidden}
                                <input type="hidden" name="runId" value={run.id} />
                                <input type="hidden" name="findingId" value={fd.id} />
                                <select
                                  name="result"
                                  defaultValue={eff.result}
                                  aria-label={`Result for ${fd.title}`}
                                >
                                  {CONTINUITY_RESULTS.map((r) => (
                                    <option key={r} value={r}>
                                      {RESULT_LABELS[r]}
                                    </option>
                                  ))}
                                </select>
                                <input name="notes" placeholder="Note" aria-label={`Note for ${fd.title}`} />
                                <Button size="sm" type="submit" data-testid="override-submit">
                                  Record decision
                                </Button>
                              </ActionForm>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </section>

            {runs.length > 0 ? (
              <section className="border border-line bg-panel p-3" data-testid="run-history">
                <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
                  Review history · analyzer comparison (each run is a frozen snapshot)
                </h3>
                <table className="w-full text-left text-[12px]">
                  <thead className="text-[10.5px] uppercase tracking-wide text-muted">
                    <tr>
                      <th className="py-1 font-medium">Run</th>
                      <th className="font-medium">Analyzer · model</th>
                      <th className="font-medium">Date</th>
                      <th className="font-medium">Cost</th>
                      <th className="font-medium">Critical fails</th>
                      <th className="font-medium">Warnings</th>
                      <th className="font-medium">Evaluated</th>
                      <th className="font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((r) => {
                      const cs = costsByRun.get(r.view.run.id) ?? [];
                      const fin = cs.find((c) => c.kind !== "estimated");
                      return (
                        <tr key={r.view.run.id} className="border-t border-line" data-testid="history-row">
                          <td className="py-1">
                            <Link
                              className="text-accent hover:underline"
                              href={`/projects/${slug}/generations/${attemptId}/continuity?run=${r.view.run.id}`}
                            >
                              Run {r.view.run.runNumber}
                            </Link>
                          </td>
                          <td>
                            {r.view.run.analyzer}
                            {r.view.run.model
                              ? ` · ${modelDisplay(r.view.run.analyzer, r.view.run.model)}`
                              : ""}{" "}
                            v{r.view.run.analyzerVersion}
                          </td>
                          <td className="text-faint">{new Date(r.view.run.createdAt).toLocaleString()}</td>
                          <td className="font-mono">
                            {fin ? (fin.kind === "actual" ? usd(fin.amountUsd) : "unknown") : "—"}
                          </td>
                          <td className="font-mono">{r.summary.criticalFailures}</td>
                          <td className="font-mono">{r.summary.warnings}</td>
                          <td className="font-mono">{r.summary.evaluated}</td>
                          <td>
                            <Badge tone={QA_TONE[r.status]}>{QA_STATUS_LABELS[r.status]}</Badge>
                            {r.freshness?.stale ? (
                              <Badge tone="warn" className="ml-1">
                                stale
                              </Badge>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </section>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
