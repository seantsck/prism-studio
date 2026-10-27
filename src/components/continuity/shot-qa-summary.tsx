import Link from "next/link";
import { Badge } from "@/components/ui";
import { SEVERITY_LABELS } from "@/domain/continuity/status";
import {
  SHOT_QA_AUTHORITY_NOTE,
  type ShotQaAssessment,
  type ShotQaIssue,
  type ShotQaState,
} from "@/domain/continuity/shot-qa";

type Tone = "neutral" | "pass" | "warn" | "fail" | "info" | "accent";

export const SHOT_QA_TONE: Record<ShotQaState, Tone> = {
  no_qa: "neutral",
  qa_stale: "warn",
  critical_mismatch: "fail",
  analysis_running: "info",
  needs_attention: "warn",
  incomplete: "neutral",
  no_blocking_mismatch: "pass",
};

const KIND_LABEL: Record<ShotQaIssue["kind"], string> = {
  fail: "Mismatch",
  warn: "Warning",
  unchecked: "Unchecked",
};
const KIND_TONE: Record<ShotQaIssue["kind"], Tone> = { fail: "fail", warn: "warn", unchecked: "neutral" };

/** Reference image vs output evidence, for one issue (existing private Asset routes; no new media). */
export interface IssueMedia {
  references: Array<{ assetId: string; label: string }>;
  outputs: Array<{ assetId: string; label: string }>;
}

function Counts({ a }: { a: ShotQaAssessment }) {
  const c = a.counts;
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11.5px] text-muted" data-testid="shot-qa-counts">
      <span data-testid="shot-qa-critical">Critical mismatches: {c.criticalFailures}</span>
      <span data-testid="shot-qa-major">Major mismatches: {c.majorFailures}</span>
      <span>Minor mismatches: {c.minorFailures}</span>
      <span>Warnings: {c.warnings}</span>
      <span data-testid="shot-qa-unchecked">
        Unchecked: {c.unchecked}
        {c.importantUnchecked ? ` (${c.importantUnchecked} important)` : ""}
      </span>
      <span>Evaluated: {c.evaluated}</span>
      {c.overridden ? <span>Human decisions: {c.overridden}</span> : null}
    </div>
  );
}

function Suggestions({ a }: { a: ShotQaAssessment }) {
  if (a.suggestedRejectionReasons.length === 0) return null;
  return (
    <div data-testid="shot-qa-suggestions">
      <div className="text-[10.5px] uppercase tracking-wide text-muted">
        Suggested rejection reasons (only if you decide to reject)
      </div>
      <ul className="mt-0.5 space-y-0.5 text-[12px]">
        {a.suggestedRejectionReasons.map((s) => (
          <li
            key={s.findingId}
            className="select-all border-l-2 border-line2 pl-2"
            data-testid="shot-qa-suggestion"
            data-key={s.criterionKey}
          >
            {s.text}
            {s.fromOverride ? (
              <span className="ml-1 text-[10.5px] text-faint">(reviewer decision)</span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The prominent answer at the top of the continuity workspace: did Prism find a mismatch, how sure is that, what to
 * look at first. Advice only; the detailed criterion workspace stays underneath.
 */
export function ShotQaSummary({
  assessment: a,
  media,
  maxIssues = 6,
}: {
  assessment: ShotQaAssessment;
  media?: Record<string, IssueMedia>;
  maxIssues?: number;
}) {
  const shown = a.issues.filter((i) => i.kind !== "unchecked" || i.priority === 5).slice(0, maxIssues);
  const rest = a.issues.length - shown.length;
  return (
    <section
      className="space-y-2 border border-line bg-panel p-3"
      data-testid="shot-qa-summary"
      data-state={a.state}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted">Shot QA</h2>
        <span data-testid="shot-qa-state">
          <Badge tone={SHOT_QA_TONE[a.state]}>{a.label}</Badge>
        </span>
        {a.run ? (
          <span className="text-[11px] text-faint">
            Run {a.run.runNumber}
            {a.run.analyzerKind === "mock" ? " · MOCK ANALYSIS" : ""}
          </span>
        ) : null}
        {a.overridesChangedResult ? (
          <Badge tone="info" className="ml-auto">
            Human decisions changed the result
          </Badge>
        ) : null}
      </div>
      <p className="text-[13px]" data-testid="shot-qa-headline">
        {a.headline}
      </p>
      {a.freshness?.stale ? (
        <ul className="list-disc pl-4 text-[11.5px] text-warn" data-testid="shot-qa-stale-reasons">
          {a.freshness.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      ) : null}
      {a.run ? <Counts a={a} /> : null}

      {shown.length > 0 ? (
        <ol className="space-y-1.5" data-testid="shot-qa-issues">
          {shown.map((i) => {
            const m = media?.[i.findingId];
            return (
              <li
                key={i.findingId}
                className="border border-line bg-bg p-2 text-[12px]"
                data-testid="shot-qa-issue"
                data-key={i.criterionKey}
                data-kind={i.kind}
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone={KIND_TONE[i.kind]}>{KIND_LABEL[i.kind]}</Badge>
                  <Badge
                    tone={i.severity === "critical" ? "fail" : i.severity === "major" ? "warn" : "neutral"}
                  >
                    {SEVERITY_LABELS[i.severity]}
                  </Badge>
                  <span className="font-medium">{i.title}</span>
                  {i.override && i.override.result !== i.systemResult ? (
                    <span className="text-[10.5px] text-info" data-testid="shot-qa-issue-override">
                      reviewer: {i.override.result} (system: {i.systemResult})
                    </span>
                  ) : null}
                  {i.confidence != null && i.resultSource === "analyzer" ? (
                    <span className="text-[10.5px] text-faint">
                      confidence {(i.confidence * 100).toFixed(0)}% (advisory)
                    </span>
                  ) : null}
                </div>
                <div className="text-muted">Expected: {i.expected || "—"}</div>
                <div className="text-[11px] text-faint">Source: {i.sourceRef || "—"}</div>
                {i.kind === "unchecked" ? (
                  <div className="text-[11px] text-faint">Not checked: {i.uncheckedReason ?? "—"}</div>
                ) : i.observed ? (
                  <div className="text-muted">Observed: {i.observed}</div>
                ) : null}
                {i.contradictions.length ? (
                  <div className="text-[11.5px] text-fail">{i.contradictions.join(" · ")}</div>
                ) : null}
                {i.limitations.length ? (
                  <div className="text-[11px] text-faint">Limitations: {i.limitations.join("; ")}</div>
                ) : null}
                {m && (m.references.length > 0 || m.outputs.length > 0) ? (
                  <div className="mt-1 flex flex-wrap items-start gap-3" data-testid="shot-qa-evidence">
                    {[
                      ["Expected", m.references],
                      ["Output", m.outputs],
                    ].map(([label, xs]) =>
                      (xs as IssueMedia["references"]).length > 0 ? (
                        <div key={label as string}>
                          <div className="text-[10px] uppercase tracking-wide text-muted">
                            {label as string}
                          </div>
                          <div className="flex gap-1">
                            {(xs as IssueMedia["references"]).map((x) => (
                              <figure key={x.assetId} className="w-28">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                  src={`/api/assets/${x.assetId}`}
                                  alt={x.label}
                                  className="w-full border border-line"
                                />
                                <figcaption className="truncate text-center text-[9.5px] text-faint">
                                  {x.label}
                                </figcaption>
                              </figure>
                            ))}
                          </div>
                        </div>
                      ) : null,
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : null}
      {rest > 0 ? (
        <p className="text-[11px] text-faint">
          {rest} more item(s) (including less important unchecked criteria) in the criteria below.
        </p>
      ) : null}

      <Suggestions a={a} />
      <p className="text-[11px] text-faint" data-testid="shot-qa-authority">
        {SHOT_QA_AUTHORITY_NOTE}
      </p>
    </section>
  );
}

/** Compact version for the Attempt card: the answer, the counts, the top issues and a link to the evidence. */
export function ShotQaCardSummary({
  assessment: a,
  reviewHref,
}: {
  assessment: ShotQaAssessment;
  reviewHref: string;
}) {
  const top = a.issues.filter((i) => i.kind !== "unchecked").slice(0, 3);
  return (
    <div className="space-y-1 text-[12px]" data-testid="card-shot-qa" data-state={a.state}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10.5px] uppercase tracking-wide text-muted">Shot QA</span>
        <span data-testid="card-shot-qa-state">
          <Badge tone={SHOT_QA_TONE[a.state]}>{a.label}</Badge>
        </span>
        {a.run ? (
          <span className="text-[11px] text-faint">
            {a.counts.criticalFailures} critical · {a.counts.majorFailures} major · {a.counts.warnings}{" "}
            warning · {a.counts.unchecked} unchecked
          </span>
        ) : null}
        <Link className="text-accent hover:underline" href={reviewHref} data-testid="card-review-qa">
          Review QA →
        </Link>
      </div>
      <p className="text-[11.5px] text-muted">{a.headline}</p>
      {top.length > 0 ? (
        <ul className="list-disc pl-4 text-[11.5px]">
          {top.map((i) => (
            <li key={i.findingId}>
              {i.title} — {KIND_LABEL[i.kind].toLowerCase()} ({SEVERITY_LABELS[i.severity].toLowerCase()})
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
