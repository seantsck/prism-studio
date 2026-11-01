"use client";

import { useState } from "react";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui";
import {
  MAX_TRANSITIONS_PER_BATCH,
  SEMANTIC_MODE_LABELS,
  SEMANTIC_MODES,
  type SemanticMode,
} from "@/domain/continuity/automation";
import { saveQaPolicy } from "@/server/media-actions";

export interface QaPolicyFormAnalyzer {
  id: string;
  label: string;
  kind: "mock" | "model";
  usable: boolean;
  blockers: string[];
  /** 3A.3: Temporal Video QA availability for this analyzer on this server (safe facts only). */
  temporal: { available: boolean; label: string };
  /** 3A.4F: what Sequence Continuity this analyzer is calibrated for on this server (safe facts only). */
  sequence: { available: boolean; label: string };
}

/**
 * Owner settings for semantic Shot QA automation. Automatic is a STANDING authorisation: choosing it reveals exactly
 * what it allows and requires an explicit confirmation (re-checked on the server). Nothing is inferred from a key.
 */
export function QaPolicyForm({
  projectSlug,
  initial,
  analyzers,
  sequenceReady,
}: {
  projectSlug: string;
  initial: {
    semanticMode: SemanticMode;
    analyzer: string | null;
    externalMediaAllowed: boolean;
    maxCostPerRunUsd: number | null;
    maxCostPerDayUsd: number | null;
    directVideoAllowed: boolean;
    sequenceSemanticMode: SemanticMode;
    maxTransitionsPerBatch: number;
    revision: number;
  };
  analyzers: QaPolicyFormAnalyzer[];
  /** false before migration 0047: the Sequence controls are off and say why */
  sequenceReady: boolean;
}) {
  const [mode, setMode] = useState<SemanticMode>(initial.semanticMode);
  const [analyzer, setAnalyzer] = useState(initial.analyzer ?? analyzers[0]?.id ?? "");
  const [run, setRun] = useState(initial.maxCostPerRunUsd?.toString() ?? "");
  const [day, setDay] = useState(initial.maxCostPerDayUsd?.toString() ?? "");
  const [directVideo, setDirectVideo] = useState(initial.directVideoAllowed);
  const [sequenceMode, setSequenceMode] = useState<SemanticMode>(initial.sequenceSemanticMode);
  const [batch, setBatch] = useState(String(initial.maxTransitionsPerBatch));
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

      <fieldset className="space-y-1 border border-line p-2.5" data-testid="qa-temporal">
        <legend className="px-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
          Temporal Video QA
        </legend>
        <p className="text-[11px] text-faint" data-testid="qa-temporal-state">
          {chosen ? `${chosen.label}: ${chosen.temporal.label}` : "Choose an analyzer."} · Lip sync not
          calibrated (stays unchecked).
        </p>
        <label className="flex items-start gap-1.5 text-[12px]">
          <input
            type="checkbox"
            name="directVideoAllowed"
            value="1"
            checked={directVideo}
            onChange={(e) => setDirectVideo(e.target.checked)}
            data-testid="qa-direct-video"
          />
          <span>
            Allow Prism to send Shot video to the chosen semantic analyzer: (1) the full selected delivery
            video, for temporal Shot QA (camera movement, action beats, screen direction, eyelines, geography,
            forbidden actions); (2) short audio-free cut-edge clips of the output pinned in the Episode Edit,
            for Sequence Continuity. Off by default. A manual analysis still asks you to acknowledge each
            transfer.
          </span>
        </label>
      </fieldset>

      <fieldset className="space-y-2 border border-line p-2.5" data-testid="qa-sequence">
        <legend className="px-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
          Sequence Continuity automation
        </legend>
        <p className="text-[11px] text-faint" data-testid="qa-sequence-state">
          {!sequenceReady
            ? "Needs database migration 0047, which is not applied to this database yet. Manual reviews still work."
            : chosen
              ? `${chosen.label}: ${chosen.sequence.label}`
              : "Choose an analyzer."}
        </p>
        <div className="flex flex-wrap gap-3 text-[12px]">
          {SEMANTIC_MODES.map((m) => (
            <label key={m} className="flex items-center gap-1.5">
              <input
                type="radio"
                name="sequenceSemanticMode"
                value={m}
                checked={sequenceMode === m}
                onChange={() => setSequenceMode(m)}
                disabled={!sequenceReady && m !== "off"}
                data-testid={`qa-sequence-mode-${m}`}
              />
              {SEMANTIC_MODE_LABELS[m]}
            </label>
          ))}
        </div>
        <p className="text-[11px] text-faint">
          {sequenceMode === "off"
            ? "No cut is analysed automatically. Manual Sequence Continuity reviews stay available."
            : sequenceMode === "suggest"
              ? "The Continuity Supervisor shows which settled cuts are due and their worst-case cost. Nothing is sent or spent until you review a batch."
              : "Each time you open the Continuity Supervisor, Prism queues the settled cuts that are due, within the limits below. This setting is separate from Shot QA automation above."}
        </p>
        <label className="block text-[12px]">
          Max transitions per batch
          <input
            name="maxTransitionsPerBatch"
            type="number"
            min={1}
            max={MAX_TRANSITIONS_PER_BATCH}
            step={1}
            value={batch}
            onChange={(e) => setBatch(e.target.value)}
            readOnly={!sequenceReady}
            className="ml-2 w-16"
            data-testid="qa-sequence-batch"
          />
        </label>
        {sequenceMode === "automatic" ? (
          <div
            className="space-y-1 border border-warn/40 bg-warn/5 p-2.5 text-[12px]"
            data-testid="qa-sequence-automatic-confirm"
          >
            <div className="font-semibold">Sequence Continuity standing authorisation</div>
            <p className="text-muted">
              Using <strong>{chosen?.label ?? (analyzer || "no analyzer chosen")}</strong>, Prism may send,
              without asking per cut:
            </p>
            <ul className="list-disc pl-4 text-muted">
              <li>the last ~2 seconds of the left output pinned in the Episode Edit;</li>
              <li>the first ~2 seconds of the right output pinned in the Episode Edit;</li>
              <li>with audio stripped, plus the two exact edge stills;</li>
              <li>applicable bounded reference images;</li>
              <li>a pinned output that may differ from the Shot&apos;s current delivery master;</li>
              <li>as inline data or a temporary provider file, as the exact media requires;</li>
              <li>
                up to <strong>{batch || "?"}</strong> cuts per batch, <strong>${run || "?"}</strong> per run
                and <strong>${day || "?"}</strong> per 24 hours for this Project, shared with Shot QA.
              </li>
            </ul>
            <p className="text-muted">
              It is advisory QA only. It never approves, rejects, regenerates or edits a Shot. Eyeline stays
              unavailable: it did not pass calibration.
            </p>
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                name="confirmSequenceAutomatic"
                value="1"
                data-testid="qa-confirm-sequence-automatic"
              />
              I authorise automatic Sequence Continuity on these terms.
            </label>
          </div>
        ) : null}
      </fieldset>

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
            {directVideo ? (
              <li data-testid="qa-automatic-full-video">
                The <strong>full selected delivery video</strong> may also be sent for temporal Shot QA,
                without asking each time (a temporary provider copy may be created and is deleted afterwards).
              </li>
            ) : (
              <li>No full video is sent: temporal criteria stay unchecked.</li>
            )}
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
