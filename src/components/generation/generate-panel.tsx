"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, Check, X } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { Badge, Button } from "@/components/ui";
import { startGeneration } from "@/server/generation-actions";

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
}: {
  projectSlug: string;
  shotId: string;
  options: ModelOption[];
  defaultKey: string | null;
  activeJob: boolean;
}) {
  const initial = options.find((o) => o.key === defaultKey) ?? options.find((o) => o.available) ?? options[0];
  const [selected, setSelected] = useState(initial?.key ?? "");
  const [acked, setAcked] = useState<Record<string, boolean>>({});
  const option = options.find((o) => o.key === selected);

  const ackedIds = useMemo(
    () => (option ? option.ignored.filter((f) => acked[`${option.key}:${f.id}`]).map((f) => f.id) : []),
    [option, acked],
  );
  if (!option) {
    return (
      <div className="border border-dashed border-line2 p-3 text-muted">
        No generation models are configured.
      </div>
    );
  }
  const allAcked = option.ignored.every((f) => ackedIds.includes(f.id));
  const canSubmit = option.available && option.blockers.length === 0 && allAcked && !activeJob;
  const verdict = option.blockers.length > 0 ? "FAIL" : option.ignored.length > 0 ? "WARN" : "PASS";
  const verdictTone = verdict === "PASS" ? "pass" : verdict === "WARN" ? "warn" : "fail";

  return (
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
          {option.duration ? (
            <div className="mt-1 text-[12px]" data-testid="duration-compat">
              Production {secs(option.duration.productionMs)}
              <span className="block text-[11px] text-muted">
                Model supports {option.duration.supported} {option.duration.ok ? "✓" : "✕"}
              </span>
            </div>
          ) : (
            <div className="mt-1 text-[12px] text-muted">n/a</div>
          )}
        </div>
        <div className="border border-line bg-bg p-2.5">
          <div className="text-[10.5px] uppercase tracking-wide text-muted">Estimated cost</div>
          <div className="mt-1 text-[12px]" data-testid="estimated-cost">
            {option.estimate ? money(option.estimate.amount, option.estimate.currency) : "—"}
            {option.estimate ? (
              <span className="block text-[11px] text-muted">{option.estimate.basis}</span>
            ) : null}
          </div>
        </div>
      </div>

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

      {option.blockers.length > 0 ? (
        <div className="border border-fail/40 bg-fail/5 p-2.5" role="alert" data-testid="generate-blockers">
          <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-fail">
            <AlertTriangle className="h-3 w-3" /> Cannot generate yet
          </div>
          <ul className="list-disc space-y-0.5 pl-4 text-[12px]">
            {option.blockers.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {option.ignored.length > 0 ? (
        <fieldset className="border border-warn/40 bg-warn/5 p-2.5" data-testid="ignored-features">
          <legend className="px-1 text-[11px] font-semibold uppercase tracking-wide text-warn">
            Production intent this model will NOT use
          </legend>
          <div className="space-y-1.5">
            {option.ignored.map((f) => (
              <label key={f.id} className="flex items-start gap-2 text-[12px]">
                <input
                  type="checkbox"
                  name="ack"
                  value={f.id}
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

      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" disabled={!canSubmit} data-testid="generate-button">
          Generate
        </Button>
        {activeJob ? (
          <span className="text-[11px] text-muted">A generation is already running for this shot.</span>
        ) : null}
      </div>
    </ActionForm>
  );
}
