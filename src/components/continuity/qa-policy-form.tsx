"use client";

import { useState } from "react";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui";
import { SEMANTIC_MODE_LABELS, SEMANTIC_MODES, type SemanticMode } from "@/domain/continuity/automation";
import { saveQaPolicy } from "@/server/media-actions";

export interface QaPolicyFormAnalyzer {
  id: string;
  label: string;
  kind: "mock" | "model";
  usable: boolean;
  blockers: string[];
}

/**
 * Owner settings for semantic Shot QA automation. Automatic is a STANDING authorisation: choosing it reveals exactly
 * what it allows and requires an explicit confirmation (re-checked on the server). Nothing is inferred from a key.
 */
export function QaPolicyForm({
  projectSlug,
  initial,
  analyzers,
}: {
  projectSlug: string;
  initial: {
    semanticMode: SemanticMode;
    analyzer: string | null;
    externalMediaAllowed: boolean;
    maxCostPerRunUsd: number | null;
    maxCostPerDayUsd: number | null;
    revision: number;
  };
  analyzers: QaPolicyFormAnalyzer[];
}) {
  const [mode, setMode] = useState<SemanticMode>(initial.semanticMode);
  const [analyzer, setAnalyzer] = useState(initial.analyzer ?? analyzers[0]?.id ?? "");
  const [run, setRun] = useState(initial.maxCostPerRunUsd?.toString() ?? "");
  const [day, setDay] = useState(initial.maxCostPerDayUsd?.toString() ?? "");
  const chosen = analyzers.find((a) => a.id === analyzer);
  return (
    <ActionForm action={saveQaPolicy} className="space-y-3" successMessage="Shot QA policy saved">
      <input type="hidden" name="projectSlug" value={projectSlug} />
      <input type="hidden" name="revision" value={initial.revision} />
      <fieldset className="space-y-1">
        <legend className="text-[11px] font-semibold uppercase tracking-wide text-muted">
          Semantic QA automation
        </legend>
        <div className="flex flex-wrap gap-3 text-[12px]">
          {SEMANTIC_MODES.map((m) => (
            <label key={m} className="flex items-center gap-1.5">
              <input
                type="radio"
                name="semanticMode"
                value={m}
                checked={mode === m}
                onChange={() => setMode(m)}
                data-testid={`qa-mode-${m}`}
              />
              {SEMANTIC_MODE_LABELS[m]}
            </label>
          ))}
        </div>
        <p className="text-[11px] text-faint">
          {mode === "off"
            ? "Only free deterministic QA runs automatically. Nothing is sent to an external analyzer."
            : mode === "suggest"
              ? "Prism recommends semantic QA when criteria stay unchecked, but never sends anything or spends without you starting it."
              : "Prism queues semantic QA automatically for each new eligible output, within the ceilings below."}
        </p>
      </fieldset>

      <label className="block text-[12px]">
        Analyzer
        <select
          name="analyzer"
          value={analyzer}
          onChange={(e) => setAnalyzer(e.target.value)}
          className="ml-2"
          data-testid="qa-analyzer"
        >
          {analyzers.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
              {a.kind === "mock" ? " (free, local)" : ""}
              {a.usable ? "" : " — not runnable here"}
            </option>
          ))}
        </select>
      </label>
      {chosen && chosen.blockers.length > 0 ? (
        <p className="text-[11px] text-warn" data-testid="qa-analyzer-blockers">
          Server: {chosen.blockers.join(" ")}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-4 text-[12px]">
        <label>
          Per-run ceiling (USD)
          <input
            name="maxCostPerRunUsd"
            inputMode="decimal"
            value={run}
            onChange={(e) => setRun(e.target.value)}
            className="ml-2 w-24"
            data-testid="qa-max-run"
          />
        </label>
        <label>
          24-hour Project ceiling (USD)
          <input
            name="maxCostPerDayUsd"
            inputMode="decimal"
            value={day}
            onChange={(e) => setDay(e.target.value)}
            className="ml-2 w-24"
            data-testid="qa-max-day"
          />
        </label>
      </div>
      <p className="text-[11px] text-faint">
        Project ceilings can only be stricter than the server&apos;s own analysis spend limits, which always
        apply too.
      </p>

      <label className="flex items-start gap-1.5 text-[12px]">
        <input
          type="checkbox"
          name="externalMediaAllowed"
          value="1"
          defaultChecked={initial.externalMediaAllowed}
          data-testid="qa-media-consent"
        />
        <span>
          Allow sending the frozen reference images and output review frames named in each run&apos;s
          external-media manifest to the selected analyzer.
        </span>
      </label>

      {mode === "automatic" ? (
        <div
          className="space-y-1 border border-warn/40 bg-warn/5 p-2.5 text-[12px]"
          data-testid="qa-automatic-confirm"
        >
          <div className="font-semibold">Standing authorisation</div>
          <ul className="list-disc pl-4 text-muted">
            <li>
              Analyzer: <strong>{chosen?.label ?? (analyzer || "none chosen")}</strong>
            </li>
            <li>
              Media may leave Prism: the frozen references and output frames listed in each run&apos;s
              manifest.
            </li>
            <li>
              Up to <strong>${run || "?"}</strong> per run and <strong>${day || "?"}</strong> per 24 hours for
              this Project, never above the server&apos;s limits.
            </li>
            <li>
              It runs automatically whenever a new eligible output or QA truth appears, without asking each
              time.
            </li>
          </ul>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" name="confirmAutomatic" value="1" data-testid="qa-confirm-automatic" />I
            authorise automatic semantic QA on these terms.
          </label>
        </div>
      ) : null}

      <Button size="sm" variant="primary" type="submit" data-testid="qa-policy-save">
        Save Shot QA policy
      </Button>
    </ActionForm>
  );
}
