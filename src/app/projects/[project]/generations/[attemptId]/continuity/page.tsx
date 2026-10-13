import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { StageChips } from "@/components/generation/attempt-media-panel";
import { OutputPreview } from "@/components/generation/parts";
import { Badge, Button, PageHeader } from "@/components/ui";
import type { RunProjection } from "@/continuity/service";
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
import { assetUrl } from "@/lib/utils";
import { loadAttemptMedia } from "@/server/attempt-media";
import { getGenerationRepo } from "@/server/generation";
import { finalizeContinuityReview, overrideFinding, startContinuityReview } from "@/server/media-actions";
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

/**
 * Continuity review workspace for one attempt: the output, its contact sheet, the exact reference set and the
 * criteria with expected values. QA ADVISES — nothing on this page approves or rejects the shot.
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
  const hidden = (
    <>
      <input type="hidden" name="projectSlug" value={slug} />
      <input type="hidden" name="attemptId" value={attemptId} />
    </>
  );

  const byCategory = new Map<
    string,
    Array<{ eff: EffectiveFinding; f: RunProjection["view"]["findings"][number] }>
  >();
  if (selected) {
    selected.findings.forEach((eff, i) => {
      const cat = eff.category;
      byCategory.set(cat, [...(byCategory.get(cat) ?? []), { eff, f: selected.view.findings[i]! }]);
    });
  }
  const closed = Boolean(run?.finalizedAt);

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
        </div>

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
                    {run.analysisStatus !== "complete" ? (
                      <Badge tone="warn">analysis {run.analysisStatus}</Badge>
                    ) : null}
                  </div>
                  <ul className="space-y-0.5 text-[12px] text-muted" data-testid="qa-lines">
                    {describeSummary(selected.summary, selected.analyzerKind).map((l) => (
                      <li key={l}>{l}</li>
                    ))}
                  </ul>
                  <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px] text-faint">
                    <dt>Analyzer</dt>
                    <dd>
                      {run.analyzer} {run.analyzerVersion} ({run.analyzerKind})
                    </dd>
                    <dt>Rules</dt>
                    <dd>{run.rulesVersion}</dd>
                    <dt>Checked</dt>
                    <dd>{new Date(run.createdAt).toLocaleString()}</dd>
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
                        {r.assetId ? (
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

            <section className="border border-line bg-panel" data-testid="criteria">
              <h3 className="border-b border-line px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
                Criteria ({selected.findings.length})
              </h3>
              <div className="divide-y divide-line">
                {[...byCategory.entries()].map(([cat, rows]) => (
                  <div key={cat} className="p-3">
                    <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-accent">
                      {CATEGORY_LABELS[cat as keyof typeof CATEGORY_LABELS] ?? cat}
                    </div>
                    <div className="space-y-2">
                      {rows.map(({ eff, f }) => {
                        const fd = f.finding;
                        return (
                          <div
                            key={eff.id}
                            className="grid gap-2 border border-line bg-bg p-2 text-[12px] md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto]"
                            data-testid="criterion"
                            data-key={fd.criterionKey}
                            data-result={eff.result}
                          >
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span className="font-medium">{fd.title}</span>
                                <Badge tone={SEVERITY_TONE[eff.severity]}>
                                  {SEVERITY_LABELS[eff.severity]}
                                </Badge>
                              </div>
                              <div className="text-muted">Expected: {fd.expected || "—"}</div>
                              <div className="text-[11px] text-faint">Source: {fd.sourceRef || "—"}</div>
                              {fd.actual ? <div className="text-muted">Actual: {fd.actual}</div> : null}
                              {fd.notes ? <div className="text-[11px] text-faint">{fd.notes}</div> : null}
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
                                      ? `${selected.analyzerKind === "mock" ? "MOCK ANALYSIS" : "analyzer"}${
                                          fd.confidence != null
                                            ? ` · ${(fd.confidence * 100).toFixed(0)}%`
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
                ))}
              </div>
            </section>

            {runs.length > 1 ? (
              <section className="border border-line bg-panel p-3" data-testid="run-history">
                <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
                  Review history (each run is a frozen snapshot)
                </h3>
                <ul className="space-y-0.5 text-[12px]">
                  {runs.map((r) => (
                    <li key={r.view.run.id} className="flex flex-wrap items-center gap-2">
                      <Link
                        className="text-accent hover:underline"
                        href={`/projects/${slug}/generations/${attemptId}/continuity?run=${r.view.run.id}`}
                      >
                        Run {r.view.run.runNumber}
                      </Link>
                      <Badge tone={QA_TONE[r.status]}>{QA_STATUS_LABELS[r.status]}</Badge>
                      {r.freshness?.stale ? <Badge tone="warn">stale</Badge> : null}
                      <span className="text-faint">
                        {new Date(r.view.run.createdAt).toLocaleString()} · {r.view.run.analyzer}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
