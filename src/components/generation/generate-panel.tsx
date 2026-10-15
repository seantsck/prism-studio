"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, Check, X } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { FrameOverlay } from "@/components/framing/frame-overlay";
import { Badge, Button } from "@/components/ui";
import { saveProtectedComposition } from "@/server/media-actions";
import { startGeneration } from "@/server/generation-actions";
import { variantKey, type AdaptationOptions, type PlanSummary } from "./adaptation-summary";

/** Serializable per-model evaluation computed on the server (see GenerateWorkspace). No credentials. */
export interface ModelOption {
  key: string;
  provider: string;
  providerName: string;
  modelId: string;
  label: string;
  description: string;
  kind: "mock" | "real";
  /** Selectable at all (enabled + configured + not retired). */
  available: boolean;
  unavailableReason: string | null;
  modality: string | null;
  compatible: boolean;
  errors: string[];
  ignored: Array<{ id: string; label: string; impact: string }>;
  inputs: Array<{ kind: string; label: string; used: boolean }>;
  duration: { productionMs: number; supported: string; ok: boolean } | null;
  estimate: { amount: number | null; currency: string; basis: string } | null;
  /** Gate blockers that are NOT about acknowledgement (preflight, freshness, model, compatibility). */
  blockers: string[];
  /** Present when production framing/duration need an explicit choice for this model. */
  adaptation: AdaptationOptions | null;
  basePlan: PlanSummary | null;
}

const money = (n: number | null, c: string) =>
  n == null ? "Unknown" : `${c === "USD" ? "$" : ""}${n.toFixed(n < 1 ? 3 : 2)}${c === "USD" ? "" : ` ${c}`}`;
const secs = (ms: number) => `${Number((ms / 1000).toFixed(2))}s`;

export function GeneratePanel({
  projectSlug,
  shotId,
  options,
  defaultKey,
  activeJob,
  storyboardUrl,
  protectedNotes,
}: {
  projectSlug: string;
  shotId: string;
  options: ModelOption[];
  defaultKey: string | null;
  activeJob: boolean;
  storyboardUrl: string | null;
  protectedNotes: string[];
}) {
  const initial = options.find((o) => o.key === defaultKey) ?? options.find((o) => o.available) ?? options[0];
  const [selected, setSelected] = useState(initial?.key ?? "");
  const [acked, setAcked] = useState<Record<string, boolean>>({});
  // Adaptation choices are never defaulted: the user picks them, per model.
  const [choice, setChoice] = useState<Record<string, { framing: string; duration: string }>>({});
  const option = options.find((o) => o.key === selected);
  const pick = option ? (choice[option.key] ?? { framing: "", duration: "" }) : { framing: "", duration: "" };

  /** The evaluation for the chosen adaptation (falls back to the un-adapted one). */
  const view = useMemo(() => {
    if (!option) return null;
    const v = option.adaptation?.variants[variantKey(pick.framing, pick.duration)];
    return {
      compatible: v?.compatible ?? option.compatible,
      errors: v?.errors ?? option.errors,
      ignored: v?.ignored ?? option.ignored,
      blockers: v?.blockers ?? option.blockers,
      estimate: v?.estimate ?? option.estimate,
      duration: v?.duration ?? option.duration,
      plan: v?.plan ?? option.basePlan,
    };
  }, [option, pick.framing, pick.duration]);

  const ackedIds = useMemo(
    () => (option && view ? view.ignored.filter((f) => acked[`${option.key}:${f.id}`]).map((f) => f.id) : []),
    [option, view, acked],
  );
  if (!option || !view) {
    return (
      <div className="border border-dashed border-line2 p-3 text-muted">
        No generation models are configured.
      </div>
    );
  }
  const allAcked = view.ignored.every((f) => ackedIds.includes(f.id));
  const canSubmit = option.available && view.blockers.length === 0 && allAcked && !activeJob;
  const verdict = view.blockers.length > 0 ? "FAIL" : view.ignored.length > 0 ? "WARN" : "PASS";
  const verdictTone = verdict === "PASS" ? "pass" : verdict === "WARN" ? "warn" : "fail";
  const plan = view.plan;
  const adapted = plan?.status === "adapted";
  const needsChoice = option.adaptation?.needsFraming || option.adaptation?.needsDuration;
  const setPick = (patch: Partial<{ framing: string; duration: string }>) =>
    setChoice((s) => ({ ...s, [option.key]: { ...pick, ...patch } }));

  return (
    <div className="space-y-3">
      <ActionForm
        action={startGeneration}
        className="space-y-3"
        successMessage="Queued"
        data-testid="generate-form"
      >
        <input type="hidden" name="projectSlug" value={projectSlug} />
        <input type="hidden" name="shotId" value={shotId} />
        <input type="hidden" name="provider" value={option.provider} />
        <input type="hidden" name="model" value={option.modelId} />
        <input type="hidden" name="framing" value={pick.framing} />
        <input type="hidden" name="durationStrategy" value={pick.duration} />

        <label className="block">
          <span className="mb-1 block text-[11px] text-muted">Model</span>
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            aria-label="Generation model"
            data-testid="model-select"
          >
            {options.map((o) => (
              <option key={o.key} value={o.key} disabled={!o.available}>
                {o.providerName} · {o.label}
                {o.kind === "mock" ? " (mock, free)" : ""}
                {!o.available ? ` — ${o.unavailableReason ?? "unavailable"}` : ""}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-[11px] text-faint">{option.description}</span>
        </label>

        <div className="grid gap-3 md:grid-cols-3" data-testid="compat-summary">
          <div className="border border-line bg-bg p-2.5">
            <div className="text-[10.5px] uppercase tracking-wide text-muted">Compatibility</div>
            <div className="mt-1 flex items-center gap-2">
              <Badge tone={verdictTone}>{verdict}</Badge>
              {option.modality ? (
                <span className="font-mono text-[11px] text-muted">{option.modality}</span>
              ) : null}
            </div>
          </div>
          <div className="border border-line bg-bg p-2.5">
            <div className="text-[10.5px] uppercase tracking-wide text-muted">Duration</div>
            {view.duration ? (
              <div className="mt-1 text-[12px]" data-testid="duration-compat">
                Production {secs(view.duration.productionMs)}
                <span className="block text-[11px] text-muted">
                  Model supports {view.duration.supported} {view.duration.ok ? "✓" : "✕"}
                </span>
                {plan && plan.duration.status === "adapted" && plan.duration.providerMs != null ? (
                  <span className="block text-[11px] text-accent" data-testid="duration-adapted">
                    Provider generates {secs(plan.duration.providerMs)}, delivery trimmed to{" "}
                    {secs(plan.duration.trimToMs ?? plan.duration.productionMs ?? 0)}
                  </span>
                ) : null}
              </div>
            ) : (
              <div className="mt-1 text-[12px] text-muted">n/a</div>
            )}
          </div>
          <div className="border border-line bg-bg p-2.5">
            <div className="text-[10.5px] uppercase tracking-wide text-muted">Estimated cost</div>
            <div className="mt-1 text-[12px]" data-testid="estimated-cost">
              {view.estimate ? money(view.estimate.amount, view.estimate.currency) : "—"}
              {view.estimate ? (
                <span className="block text-[11px] text-muted">{view.estimate.basis}</span>
              ) : null}
            </div>
          </div>
        </div>

        {needsChoice && option.adaptation ? (
          <fieldset
            className="space-y-2 border border-accent/40 bg-accent/5 p-2.5"
            data-testid="adaptation-panel"
          >
            <legend className="px-1 text-[11px] font-semibold uppercase tracking-wide text-accent">
              Production → provider adaptation
            </legend>
            <p className="text-[11.5px] text-muted">
              This model cannot generate the production frame/duration as designed. Production intent is not
              changed: choose how the <em>provider canvas</em> will be adapted, then acknowledge the
              consequences. Prism recommends, but never chooses for you.
            </p>
            <div className="grid gap-3 md:grid-cols-2">
              {option.adaptation.needsFraming ? (
                <label className="block">
                  <span className="mb-1 block text-[11px] text-muted">
                    Framing — production {plan?.framing.productionLabel ?? "frame"}
                  </span>
                  <select
                    value={pick.framing}
                    onChange={(e) => setPick({ framing: e.target.value })}
                    aria-label="Framing strategy"
                    data-testid="framing-select"
                  >
                    <option value="">Choose how to adapt the frame…</option>
                    {option.adaptation.framing
                      .filter((f) => f.strategy !== "blocked")
                      .map((f) => (
                        <option key={f.strategy} value={f.strategy} disabled={!f.usable}>
                          {f.label}
                          {f.recommended ? " (recommended)" : ""}
                          {f.usable ? "" : ` — ${f.reason}`}
                        </option>
                      ))}
                  </select>
                </label>
              ) : null}
              {option.adaptation.needsDuration ? (
                <label className="block">
                  <span className="mb-1 block text-[11px] text-muted">
                    Duration — production {view.duration ? secs(view.duration.productionMs) : ""}
                  </span>
                  <select
                    value={pick.duration}
                    onChange={(e) => setPick({ duration: e.target.value })}
                    aria-label="Duration strategy"
                    data-testid="duration-select"
                  >
                    <option value="">Choose how to adapt the duration…</option>
                    {option.adaptation.duration.map((d) => (
                      <option key={d.strategy} value={d.strategy} disabled={!d.usable}>
                        {d.label}
                        {d.recommended ? " (recommended)" : ""}
                      </option>
                    ))}
                  </select>
                  {option.adaptation.duration.length === 0 ? (
                    <span className="mt-1 block text-[11px] text-fail">
                      This model cannot generate a clip long enough to trim to the production duration.
                    </span>
                  ) : null}
                </label>
              ) : null}
            </div>
            {option.adaptation.needsFraming && option.adaptation.framing.every((f) => !f.usable) ? (
              <p className="text-[11.5px] text-fail" data-testid="no-strategy">
                No acceptable framing strategy exists for this model:{" "}
                {option.adaptation.framing.map((f) => f.reason).join(" ")}
              </p>
            ) : null}

            {plan && plan.framing.status === "adapted" && plan.framing.providerRatio ? (
              <div
                className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
                data-testid="adaptation-detail"
              >
                <FrameOverlay
                  providerRatio={
                    plan.framing.pad ? (plan.framing.productionRatio ?? 1) : plan.framing.providerRatio
                  }
                  retained={plan.framing.retained}
                  safeArea={plan.framing.safeArea}
                  pad={plan.framing.pad}
                  productionRatio={plan.framing.productionRatio}
                  productionLabel={plan.framing.productionLabel}
                  providerLabel={plan.framing.providerLabel}
                  canvas={plan.framing.canvas}
                  imageUrl={storyboardUrl}
                />
                <dl className="grid h-fit grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[12px]">
                  <dt className="text-muted">Production frame</dt>
                  <dd data-testid="production-frame">{plan.framing.productionLabel}</dd>
                  <dt className="text-muted">Provider canvas</dt>
                  <dd data-testid="provider-canvas">
                    {plan.framing.providerLabel}
                    {plan.framing.canvas ? ` ${plan.framing.canvas.width}×${plan.framing.canvas.height}` : ""}
                  </dd>
                  <dt className="text-muted">Delivery frame</dt>
                  <dd>{plan.framing.productionLabel} (conformed after generation)</dd>
                  <dt className="text-muted">Strategy</dt>
                  <dd>{plan.framing.strategy.replace(/_/g, " ")}</dd>
                  {plan.framing.discardedFraction > 0 ? (
                    <>
                      <dt className="text-muted">Discarded</dt>
                      <dd data-testid="discarded">
                        ~{(plan.framing.discardedFraction * 100).toFixed(1)}%{" "}
                        {plan.framing.axis === "vertical" ? "vertically" : "horizontally"}
                      </dd>
                    </>
                  ) : null}
                  {plan.promptProduction.length > 0 ? (
                    <>
                      <dt className="text-muted">Production instruction</dt>
                      <dd>{plan.promptProduction.join(" ")}</dd>
                    </>
                  ) : null}
                  {plan.promptProvider.length > 0 ? (
                    <>
                      <dt className="text-muted">Provider adaptation</dt>
                      <dd data-testid="provider-adaptation">{plan.promptProvider.join("; ")}</dd>
                    </>
                  ) : null}
                </dl>
              </div>
            ) : null}
            {plan?.warnings.map((w, i) => (
              <p key={i} className="text-[11.5px] text-warn">
                {w}
              </p>
            ))}
          </fieldset>
        ) : null}

        <div className="border border-line bg-bg p-2.5">
          <div className="mb-1 text-[10.5px] uppercase tracking-wide text-muted">Inputs</div>
          <ul className="grid gap-x-4 gap-y-0.5 text-[12px] md:grid-cols-2">
            {option.inputs.map((i, n) => (
              <li key={n} className="flex items-center gap-1.5">
                {i.used ? <Check className="h-3 w-3 text-pass" /> : <X className="h-3 w-3 text-warn" />}
                <span className={i.used ? "" : "text-warn"}>{i.label}</span>
                {!i.used ? <span className="text-[10.5px] text-faint">not used by this model</span> : null}
              </li>
            ))}
            {option.inputs.length === 0 ? <li className="text-muted">No reference inputs.</li> : null}
          </ul>
        </div>

        {view.blockers.length > 0 ? (
          <div className="border border-fail/40 bg-fail/5 p-2.5" role="alert" data-testid="generate-blockers">
            <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-fail">
              <AlertTriangle className="h-3 w-3" /> Cannot generate yet
            </div>
            <ul className="list-disc space-y-0.5 pl-4 text-[12px]">
              {view.blockers.map((b, i) => (
                <li key={i}>{b}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {view.ignored.length > 0 ? (
          <fieldset className="border border-warn/40 bg-warn/5 p-2.5" data-testid="ignored-features">
            <legend className="px-1 text-[11px] font-semibold uppercase tracking-wide text-warn">
              Production intent this generation will NOT honour as designed
            </legend>
            <div className="space-y-1.5">
              {view.ignored.map((f) => (
                <label key={f.id} className="flex items-start gap-2 text-[12px]">
                  <input
                    type="checkbox"
                    name="ack"
                    value={f.id}
                    data-ack={f.id}
                    checked={Boolean(acked[`${option.key}:${f.id}`])}
                    onChange={(e) => setAcked((s) => ({ ...s, [`${option.key}:${f.id}`]: e.target.checked }))}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="font-medium">{f.label}</span>
                    <span className="block text-muted">{f.impact}</span>
                  </span>
                </label>
              ))}
            </div>
            <p className="mt-1.5 text-[10.5px] text-faint">
              Acknowledge each item to generate with this model.
            </p>
          </fieldset>
        ) : null}

        {option.kind === "real" ? (
          <div className="border border-line bg-bg p-2.5 text-[12px]" data-testid="spend-summary">
            <div className="mb-1 text-[10.5px] uppercase tracking-wide text-muted">This will spend money</div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
              <dt className="text-muted">Provider</dt>
              <dd>{option.providerName}</dd>
              <dt className="text-muted">Model</dt>
              <dd>{option.label}</dd>
              <dt className="text-muted">Production duration</dt>
              <dd>{view.duration ? secs(view.duration.productionMs) : "—"}</dd>
              <dt className="text-muted">Provider duration</dt>
              <dd>
                {plan?.duration.providerMs != null
                  ? secs(plan.duration.providerMs)
                  : view.duration
                    ? `${view.duration.supported} ${view.duration.ok ? "✓" : "✕ (not rounded)"}`
                    : "—"}
              </dd>
              <dt className="text-muted">Production frame</dt>
              <dd>{plan?.framing.productionLabel ?? "—"}</dd>
              <dt className="text-muted">Provider canvas</dt>
              <dd>{adapted ? plan?.framing.providerLabel : (plan?.framing.productionLabel ?? "—")}</dd>
              <dt className="text-muted">Estimated cost</dt>
              <dd>{view.estimate ? money(view.estimate.amount, view.estimate.currency) : "—"}</dd>
              <dt className="text-muted">Inputs used</dt>
              <dd>
                {option.inputs
                  .filter((i) => i.used)
                  .map((i) => i.label)
                  .join(", ") || "none"}
              </dd>
              <dt className="text-muted">Not honoured</dt>
              <dd>{view.ignored.map((f) => f.label).join(", ") || "nothing"}</dd>
            </dl>
          </div>
        ) : null}

        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" disabled={!canSubmit} data-testid="generate-button">
            {option.kind === "real" && view.estimate
              ? `Generate — estimated ${money(view.estimate.amount, view.estimate.currency)}`
              : "Generate"}
          </Button>
          {activeJob ? (
            <span className="text-[11px] text-muted">A generation is already running for this shot.</span>
          ) : null}
        </div>
      </ActionForm>

      <ActionForm
        action={saveProtectedComposition}
        className="space-y-1.5 border border-line bg-bg p-2.5"
        successMessage="Protected composition saved"
        data-testid="protected-composition-form"
      >
        <input type="hidden" name="projectSlug" value={projectSlug} />
        <input type="hidden" name="shotId" value={shotId} />
        <label className="block">
          <span className="mb-1 block text-[10.5px] uppercase tracking-wide text-muted">
            Protected composition (one per line) — what must survive a crop
          </span>
          <textarea
            name="notes"
            rows={2}
            defaultValue={protectedNotes.join("\n")}
            placeholder={"e.g. Yumeko's eyes inside the crop\nkeep the doorway fully visible"}
            data-testid="protected-notes"
          />
        </label>
        <Button size="sm" type="submit" data-testid="save-protected">
          Save protected composition
        </Button>
      </ActionForm>
    </div>
  );
}
