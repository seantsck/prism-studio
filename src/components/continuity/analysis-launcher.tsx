"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Badge, Button } from "@/components/ui";
import { startContinuityAnalysis } from "@/server/media-actions";

/** Serializable preview of ONE analyzer for this attempt. No credentials; only counts, names and sentences. */
export interface AnalyzerPreview {
  id: string;
  label: string;
  model: string;
  kind: "mock" | "model";
  /** configured | missing_credential | disabled */
  state: string;
  spend: "free" | "enabled" | "disabled";
  usable: boolean;
  missingConfig: string[];
  mode: string;
  framesPending: boolean;
  counts: {
    analysed: number;
    deterministic: number;
    manual: number;
    unsupported: number;
    noMedia: number;
    referencesSent: number;
    referencesOmitted: number;
    outputImagesSent: number;
    requests: number;
  };
  unsupported: Array<{ key: string; reason: string }>;
  sent: Array<{ inputId: string; role: string; kind: string; label: string }>;
  omitted: Array<{ inputId: string; role: string; reason: string }>;
  estimate: { expectedUsd: number | null; maxUsd: number | null; basis: string; pricingVersion: string };
  blockers: string[];
  requiresAcknowledgement: boolean;
}

const usd = (n: number | null) =>
  n == null ? "unknown" : n === 0 ? "$0 (free)" : `$${n.toFixed(n < 0.01 ? 4 : 3)}`;

/**
 * "Run automated analysis": shows EXACTLY what would be analysed, what stays deterministic/manual/unsupported,
 * which media would leave Prism, and the estimated cost, BEFORE anything is queued. A paid analysis needs an
 * explicit acknowledgement; the real ceiling is server configuration (nothing the browser sends can raise it).
 */
export function AnalysisLauncher({
  projectSlug,
  attemptId,
  analyzers,
  defaultId,
  nonce,
  canRun,
  runDisabledReason,
}: {
  /** Submission nonce minted on the server for this page view (idempotency of a double click). */
  nonce: string;
  projectSlug: string;
  attemptId: string;
  analyzers: AnalyzerPreview[];
  defaultId: string | null;
  canRun: boolean;
  runDisabledReason: string | null;
}) {
  const [selected, setSelected] = useState(defaultId ?? analyzers[0]?.id ?? "");
  const [ack, setAck] = useState(false);
  const a = analyzers.find((x) => x.id === selected);
  if (!a) {
    return <div className="border border-dashed border-line2 p-3 text-muted">No analyzer is configured.</div>;
  }
  const blocked = a.blockers.length > 0 || !a.usable;
  const needsAck = a.requiresAcknowledgement;
  const canSubmit = canRun && !blocked && (!needsAck || ack) && a.counts.requests > 0;

  return (
    <ActionForm
      action={startContinuityAnalysis}
      className="space-y-3 border border-line bg-panel p-3"
      successMessage="Analysis queued"
      data-testid="analysis-launcher"
    >
      <input type="hidden" name="projectSlug" value={projectSlug} />
      <input type="hidden" name="attemptId" value={attemptId} />
      <input type="hidden" name="analyzer" value={a.id} />
      <input type="hidden" name="nonce" value={nonce} />
      <input type="hidden" name="ackSpend" value={ack ? "1" : "0"} />

      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted">
          Run automated analysis
        </h3>
        <select
          value={selected}
          onChange={(e) => {
            setSelected(e.target.value);
            setAck(false);
          }}
          aria-label="Analyzer"
          data-testid="analyzer-select"
          className="!w-auto"
        >
          {analyzers.map((x) => (
            <option key={x.id} value={x.id}>
              {x.label} · {x.model}
              {!x.usable && x.kind === "model"
                ? ` — ${x.state === "configured" ? "paid analysis off" : x.state.replace("_", " ")}`
                : ""}
            </option>
          ))}
        </select>
        {a.kind === "model" ? (
          <Badge tone="warn">external model · may cost money</Badge>
        ) : (
          <Badge tone="info">free · local</Badge>
        )}
      </div>

      <div className="grid gap-3 md:grid-cols-4" data-testid="analysis-summary">
        <Stat
          label="Analyzer"
          value={`${a.label}`}
          sub={`model ${a.model} · mode ${a.mode.replace("_", "-")}`}
        />
        <Stat
          label="Criteria to analyse"
          value={String(a.counts.analysed)}
          sub={`${a.counts.requests} request(s)`}
          testId="count-analysed"
        />
        <Stat
          label="Not analysed by AI"
          value={String(a.counts.deterministic + a.counts.manual + a.counts.unsupported + a.counts.noMedia)}
          sub={`${a.counts.deterministic} deterministic · ${a.counts.manual} manual · ${a.counts.unsupported} unsupported · ${a.counts.noMedia} no media`}
          testId="count-not-analysed"
        />
        <Stat
          label="Estimated cost"
          value={usd(a.estimate.expectedUsd)}
          sub={`worst case ${usd(a.estimate.maxUsd)}`}
          testId="estimated-analysis-cost"
        />
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="border border-line bg-bg p-2.5" data-testid="analysis-media">
          <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-muted">
            Media sent to the analyzer
          </div>
          <div className="text-[12px]">
            References used: <b data-testid="refs-used">{a.counts.referencesSent}</b> · output frames/sheet:{" "}
            <b>{a.counts.outputImagesSent}</b>
          </div>
          {a.counts.referencesOmitted > 0 ? (
            <div className="text-[12px] text-warn" data-testid="refs-omitted">
              Not sent due to input budget: {a.counts.referencesOmitted}
            </div>
          ) : null}
          <ul className="mt-1 max-h-32 space-y-0.5 overflow-auto text-[11px] text-muted">
            {a.sent.map((s) => (
              <li key={s.inputId}>
                <span className="font-mono">{s.inputId}</span> · {s.label}
              </li>
            ))}
            {a.omitted.map((o) => (
              <li key={o.inputId} className="text-warn">
                <span className="font-mono">{o.inputId}</span> · not sent ({o.reason.replace(/_/g, " ")})
              </li>
            ))}
          </ul>
          {a.framesPending ? (
            <p className="mt-1 text-[11px] text-faint">
              Review frames are extracted first (first / 25% / 50% / 75% / last).
            </p>
          ) : null}
        </div>
        <div className="border border-line bg-bg p-2.5" data-testid="analysis-unsupported">
          <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-muted">
            Stays unchecked (never inferred as pass)
          </div>
          <ul className="max-h-32 space-y-0.5 overflow-auto text-[11px] text-muted">
            {a.unsupported.map((u) => (
              <li key={u.key}>
                <span className="font-mono">{u.key}</span> — {u.reason}
              </li>
            ))}
            {a.unsupported.length === 0 ? <li>Nothing is unsupported for this analyzer.</li> : null}
          </ul>
        </div>
      </div>

      {a.kind === "model" ? (
        <p className="text-[11px] text-faint" data-testid="privacy-note">
          External analyzer receives: {a.counts.outputImagesSent} output image(s), {a.counts.referencesSent}{" "}
          reference image(s) and the production criteria text (expected values). Private assets are sent as
          bounded copies for this analysis only; nothing is made public. Estimate: {a.estimate.basis}
        </p>
      ) : null}

      {a.blockers.length > 0 ? (
        <ul
          className="list-disc space-y-0.5 pl-4 text-[12px] text-fail"
          role="alert"
          data-testid="analysis-blockers"
        >
          {a.blockers.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      ) : null}
      {!a.usable && a.missingConfig.length > 0 ? (
        <p className="text-[12px] text-muted" data-testid="analyzer-unavailable">
          Not available: set {a.missingConfig.join(", ")} on the server.
        </p>
      ) : null}

      {needsAck ? (
        <label className="flex items-start gap-2 text-[12px]">
          <input
            type="checkbox"
            checked={ack}
            onChange={(e) => setAck(e.target.checked)}
            data-testid="ack-analysis-spend"
          />
          <span>
            I understand this analysis will be sent to an external model and may cost up to{" "}
            <b>{usd(a.estimate.maxUsd)}</b> (estimated {usd(a.estimate.expectedUsd)}). It will not approve or
            reject anything.
          </span>
        </label>
      ) : null}

      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" disabled={!canSubmit} data-testid="run-analysis">
          Run automated analysis
        </Button>
        {!canRun && runDisabledReason ? (
          <span className="text-[11px] text-muted">{runDisabledReason}</span>
        ) : null}
      </div>
    </ActionForm>
  );
}

function Stat({
  label,
  value,
  sub,
  testId,
}: {
  label: string;
  value: string;
  sub?: string;
  testId?: string;
}) {
  return (
    <div className="border border-line bg-bg p-2.5">
      <div className="text-[10.5px] uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-0.5 text-[13px] font-medium" data-testid={testId}>
        {value}
      </div>
      {sub ? <div className="text-[10.5px] text-faint">{sub}</div> : null}
    </div>
  );
}

/** Polls Prism's own job status (never an analyzer) and refreshes the page when it changes. */
export function AnalysisPoller({
  projectSlug,
  attemptId,
  signature,
  active,
}: {
  projectSlug: string;
  attemptId: string;
  signature: string;
  active: boolean;
}) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    const url = `/api/projects/${encodeURIComponent(projectSlug)}/continuity/status?attempt=${encodeURIComponent(attemptId)}`;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok || stopped) return;
        const body = (await res.json()) as { signature?: string };
        if (!stopped && body.signature !== undefined && body.signature !== signature) router.refresh();
      } catch {
        /* retry on the next tick */
      }
    }, 1500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [projectSlug, attemptId, signature, active, router]);
  return active ? (
    <span className="text-[10.5px] text-faint" aria-live="polite" data-testid="analysis-polling">
      Analysing… updating live
    </span>
  ) : null;
}
