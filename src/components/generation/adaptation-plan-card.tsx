import { DURATION_LABELS, FRAMING_LABELS, type GenerationAdaptationPlan } from "@/domain/framing/adaptation";
import { Badge } from "@/components/ui";

const secs = (ms: number | null) => (ms == null ? "—" : `${(ms / 1000).toFixed(2)}s`);

/**
 * The frozen GenerationAdaptationPlan of an attempt: production intent vs. execution compromise, side by
 * side. Older attempts have none: "No adaptation plan recorded" (never invented retroactively).
 */
export function AdaptationPlanCard({
  plan,
  acknowledged,
}: {
  plan: GenerationAdaptationPlan | null;
  acknowledged: string[];
}) {
  if (!plan) {
    return (
      <div className="border border-line bg-panel p-3" data-testid="adaptation-plan">
        <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Adaptation plan</h3>
        <div className="text-[12px] text-muted" data-testid="no-adaptation-plan">
          No adaptation plan recorded. This attempt was created before framing adaptation existed; Prism does
          not reconstruct history.
        </div>
      </div>
    );
  }
  const f = plan.framing;
  const d = plan.duration;
  return (
    <div className="border border-line bg-panel p-3" data-testid="adaptation-plan">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted">Adaptation plan</h3>
        <Badge tone={plan.status === "adapted" ? "accent" : "neutral"}>{plan.status}</Badge>
        <span className="font-mono text-[10.5px] text-faint">{plan.fingerprint.slice(0, 12)}</span>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <div className="mb-0.5 text-[10.5px] uppercase tracking-wide text-accent">Production intent</div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[12px]">
            <dt className="text-muted">Frame</dt>
            <dd data-testid="plan-production-frame">{plan.production.aspectRatio ?? "—"}</dd>
            <dt className="text-muted">Duration</dt>
            <dd>{secs(plan.production.durationMs)}</dd>
            <dt className="text-muted">Frame rate</dt>
            <dd>{plan.production.fps ? `${plan.production.fps} fps` : "—"}</dd>
          </dl>
        </div>
        <div>
          <div className="mb-0.5 text-[10.5px] uppercase tracking-wide text-accent">
            Provider execution — {plan.provider.provider}/{plan.provider.modelId}
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[12px]">
            <dt className="text-muted">Canvas</dt>
            <dd data-testid="plan-provider-canvas">
              {f.providerLabel ?? "—"}
              {f.providerCanvas ? ` ${f.providerCanvas.width}×${f.providerCanvas.height}` : ""}
            </dd>
            <dt className="text-muted">Duration</dt>
            <dd>{secs(d.providerMs)}</dd>
            <dt className="text-muted">Framing</dt>
            <dd>{FRAMING_LABELS[f.strategy]}</dd>
            <dt className="text-muted">Duration strategy</dt>
            <dd>{DURATION_LABELS[d.strategy]}</dd>
            {f.discardedFraction > 0 ? (
              <>
                <dt className="text-muted">Discarded</dt>
                <dd>~{(f.discardedFraction * 100).toFixed(1)}%</dd>
              </>
            ) : null}
          </dl>
        </div>
      </div>
      {plan.promptAdaptation.production.length > 0 || plan.promptAdaptation.provider.length > 0 ? (
        <div className="mt-2 grid gap-3 md:grid-cols-2 text-[12px]">
          <div>
            <div className="mb-0.5 text-[10.5px] uppercase tracking-wide text-muted">
              Production instruction
            </div>
            {plan.promptAdaptation.production.map((l) => (
              <div key={l}>{l}</div>
            ))}
          </div>
          <div>
            <div className="mb-0.5 text-[10.5px] uppercase tracking-wide text-muted">Provider adaptation</div>
            {plan.promptAdaptation.provider.length > 0 ? (
              plan.promptAdaptation.provider.map((l) => <div key={l}>{l}</div>)
            ) : (
              <div className="text-muted">None (the crop is applied after generation).</div>
            )}
          </div>
        </div>
      ) : null}
      {f.protectedNotes.length > 0 ? (
        <div className="mt-2 text-[12px]">
          <div className="mb-0.5 text-[10.5px] uppercase tracking-wide text-muted">Protected composition</div>
          <ul className="list-disc pl-4">
            {f.protectedNotes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {plan.acknowledgements.length > 0 ? (
        <ul className="mt-2 space-y-0.5 text-[12px]" data-testid="plan-acks">
          {plan.acknowledgements.map((a) => (
            <li key={a.id}>
              <span className={acknowledged.includes(a.id) ? "text-pass" : "text-warn"}>
                {acknowledged.includes(a.id) ? "✓ acknowledged" : "✕ not acknowledged"}
              </span>{" "}
              {a.label}
            </li>
          ))}
        </ul>
      ) : null}
      {plan.warnings.map((w) => (
        <p key={w} className="mt-1 text-[11.5px] text-warn">
          {w}
        </p>
      ))}
    </div>
  );
}
