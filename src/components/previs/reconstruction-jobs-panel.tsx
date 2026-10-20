"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { inputModeOf, type InputMode, type JobCostEstimate } from "@/domain/reconstruction/job";
import type { SceneObjectView, SpatialSceneAdapter } from "@/lib/previs/scene-adapter";
import type { ProviderSummary } from "@/lib/reconstruction/registry";
import {
  cancelReconstructionJob,
  generateReconstruction,
  reconstructionJobs,
  retryReconstructionJob,
  type JobView,
  type ReconstructionPanelState,
} from "@/server/reconstruction-job-actions";
import type { ReferenceImageOption, SplatEnvironmentInfo } from "./splat-environment-panel";

/**
 * Reference images → reconstruction job → spatial environment (Phase 2F M2D.2). The panel never sends a status: it
 * sends requests and polls the server, which advances jobs from their providers. A finished reconstruction changes
 * NOTHING in the Set until the user presses "Use as Spatial Environment".
 *
 * Everything provider-specific comes from the provider's CAPABILITIES (execution, cost class, input modes, declared
 * options, documented estimates): the panel never branches on a provider id. Only a free, local, ready provider is
 * pre-selected; a paid provider is used only after the user picks it AND acknowledges its cost.
 */

const ACTIVE = new Set(["draft", "queued", "submitting", "running", "ingesting"]);
const STATUS_LABEL: Record<JobView["status"], string> = {
  draft: "draft",
  queued: "queued",
  submitting: "submitting",
  running: "running",
  ingesting: "importing result",
  succeeded: "ready",
  failed: "failed",
  cancelled: "cancelled",
};
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const usd = (r: { min: number; max: number } | null) =>
  !r ? null : r.min === r.max ? `$${r.min.toFixed(2)}` : `$${r.min.toFixed(2)}–$${r.max.toFixed(2)}`;
const units = (r: JobCostEstimate["providerUnits"]) =>
  !r ? null : `${r.min === r.max ? r.min : `${r.min}–${r.max}`} ${r.unit}`;

/** Cost class first, in plain words: what choosing this provider means for money and where it runs. */
export function providerKindLabel(
  s: Pick<ProviderSummary, "execution" | "cost" | "testOnly"> & Partial<Pick<ProviderSummary, "runner">>,
): string {
  if (s.testOnly || s.execution === "mock") return "Development only · no cost";
  const where =
    s.runner === "remote_agent"
      ? "paired workstation"
      : s.execution === "local"
        ? "runs on this machine"
        : "hosted service";
  const cost = s.cost === "free" ? "Free" : s.cost === "paid" ? "Paid provider · optional" : "Cost unknown";
  return `${cost} · ${where}`;
}

export type ProviderAvailability =
  "ready" | "not_installed" | "not_configured" | "disabled" | "unavailable" | "capability_unavailable";

export function providerAvailability(
  s: Pick<ProviderSummary, "capability" | "configured" | "enabled">,
): ProviderAvailability {
  if (s.capability === "not_installed") return "not_installed";
  if (!s.configured) return "not_configured";
  if (!s.enabled) return "disabled";
  if (s.capability === "unavailable") return "unavailable";
  if (s.capability !== "available") return "capability_unavailable";
  return "ready";
}
const AVAILABILITY_LABEL: Record<ProviderAvailability, string> = {
  ready: "ready",
  not_installed: "not installed yet",
  not_configured: "not configured",
  disabled: "configured · switched off",
  unavailable: "unavailable right now",
  capability_unavailable: "capability unavailable",
};
const WORKER_LABEL: Record<NonNullable<ProviderSummary["local"]>["worker"], string> = {
  online: "Online",
  offline: "Offline",
  not_enabled: "Not enabled on this server",
};

export function estimateText(e: JobCostEstimate | null | undefined, testOnly: boolean): string {
  if (!e) return "Cost unknown for this input.";
  if (e.costClass === "free")
    return testOnly ? "No provider cost (test provider)." : "Free · no per-generation cost.";
  if (e.costClass === "unknown" || !e.usd)
    return "Cost unknown: it cannot be checked against the spend limit, so paid submission stays blocked.";
  const u = units(e.providerUnits);
  const source = e.pricingSource
    ? ` Source: ${e.pricingSource}${e.pricingCheckedAt ? `, checked ${e.pricingCheckedAt}` : ""}.`
    : "";
  return `Documented price: about ${usd(e.usd)} per reconstruction${u ? ` (${u})` : ""}. Provider charges apply.${source}`;
}

export function ReconstructionJobsPanel(props: {
  projectSlug: string;
  locationId: string;
  ready: boolean;
  adapter: () => SpatialSceneAdapter;
  objects: SceneObjectView[];
  referenceImages: ReferenceImageOption[];
  onResult: (info: SplatEnvironmentInfo) => void;
  onStatus: (tone: "ok" | "error" | "busy", text: string) => void;
}) {
  const [state, setState] = useState<ReconstructionPanelState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [provider, setProvider] = useState<string>("");
  const [model, setModel] = useState<string>("");
  /** values of the chosen provider's DECLARED options (unset = the declared default) */
  const [optionValues, setOptionValues] = useState<Record<string, unknown>>({});
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [replaceFor, setReplaceFor] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchState = useCallback(async () => {
    const fd = new FormData();
    fd.set("projectSlug", props.projectSlug);
    fd.set("locationId", props.locationId);
    return reconstructionJobs(fd);
  }, [props.projectSlug, props.locationId]);
  const apply = useCallback((r: Awaited<ReturnType<typeof reconstructionJobs>>) => {
    if (!r.ok) return setLoadError(r.error);
    setLoadError(null);
    setState(r.state);
    // never "first available": only the server's free-local default, otherwise the user chooses
    setProvider((p) => p || r.state.defaultProvider || "");
  }, []);
  const load = useCallback(async () => apply(await fetchState()), [apply, fetchState]);

  // first load, then a modest poll while any job is active (the server rate-limits each provider call too)
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void fetchState().then((r) => {
      if (!cancelled) apply(r);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchState, apply, tick]);
  const active = state?.jobs.some((j) => ACTIVE.has(j.status)) ?? false;
  useEffect(() => {
    if (!active || !state) return;
    const every = Math.max(1000, Math.min(10_000, state.pollIntervalMs));
    timer.current = setTimeout(() => setTick((t) => t + 1), every);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [active, state]);

  const summary = state?.providers.find((p) => p.provider === provider) ?? null;
  const modelId = model || summary?.defaultModel || "";
  const modelInfo = summary?.models.find((m) => m.id === modelId) ?? null;
  const billable = summary ? summary.cost !== "free" : false;
  const availability = summary ? providerAvailability(summary) : null;
  // the panel offers Location reference IMAGES (video inputs are not offered yet)
  const mode: InputMode | null = chosen.length
    ? inputModeOf(chosen.map(() => ({ kind: "image" as const })))
    : null;
  const estimate = summary && mode ? (summary.estimates[modelId]?.[mode] ?? null) : null;
  const options = Object.fromEntries(
    (summary?.options ?? []).map((o) => [o.key, optionValues[o.key] ?? o.default]),
  );
  const images = props.referenceImages;
  const nameOf = (id: string) => images.find((i) => i.id === id)?.name ?? id;
  const existingSplat = props.objects.find((o) => o.kind === "splat") ?? null;

  const gate: string[] = [];
  if (state && !state.enabled) gate.push("Reconstruction jobs are switched off on this server.");
  if (!summary) gate.push("Choose a reconstruction provider.");
  else {
    if (summary.reason) gate.push(summary.reason);
    if (billable && !state?.paid.enabled)
      gate.push("Paid generation is switched off on this server (PRISM_STUDIO_ALLOW_PAID_GENERATION).");
    if (billable && !ack) gate.push("Confirm that provider charges may apply.");
    if (chosen.length > summary.maxInputs)
      gate.push(`This provider accepts at most ${summary.maxInputs} images.`);
    if (summary.minInputs && chosen.length > 0 && chosen.length < summary.minInputs)
      gate.push(`This provider needs at least ${summary.minInputs} images.`);
    if (mode && !summary.inputModes.includes(mode))
      gate.push(
        mode === "single_image"
          ? "This provider needs more than one image."
          : "This provider does not accept several images.",
      );
  }
  if (chosen.length === 0) gate.push("Choose at least one reference image.");
  const canGenerate = props.ready && !busy && gate.length === 0;

  const move = (i: number, d: -1 | 1) =>
    setChosen((c) => {
      const j = i + d;
      if (j < 0 || j >= c.length) return c;
      const next = [...c];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });

  const generate = async () => {
    if (!summary) return;
    setBusy(true);
    props.onStatus("busy", "Submitting reconstruction…");
    try {
      const fd = new FormData();
      fd.set("projectSlug", props.projectSlug);
      fd.set("locationId", props.locationId);
      fd.set("provider", summary.provider);
      fd.set("model", modelId);
      fd.set("sourceAssetIds", JSON.stringify(chosen));
      fd.set("providerOptions", JSON.stringify(options));
      if (ack) fd.set("acknowledgeCost", "1");
      const r = await generateReconstruction(fd);
      if (!r.ok) return props.onStatus("error", r.error);
      setSelected(r.job.id);
      // a submitted request is done: clear it so a second click cannot silently repeat a (possibly paid) job
      setChosen([]);
      setAck(false);
      props.onStatus("ok", `Reconstruction job ${STATUS_LABEL[r.job.status]}`);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const act = async (kind: "cancel" | "retry", job: JobView) => {
    setBusy(true);
    try {
      const fd = new FormData();
      fd.set("projectSlug", props.projectSlug);
      fd.set("jobId", job.id);
      if (ack) fd.set("acknowledgeCost", "1");
      const r = kind === "cancel" ? await cancelReconstructionJob(fd) : await retryReconstructionJob(fd);
      if (!r.ok) return props.onStatus("error", r.error);
      if (kind === "retry") setSelected(r.job.id);
      props.onStatus(
        "ok",
        kind === "cancel" ? "Reconstruction cancelled" : `Retry started (attempt ${r.job.attempt})`,
      );
      await load();
    } finally {
      setBusy(false);
    }
  };

  /** The ONLY path from a finished reconstruction into the Set: an explicit user action. */
  const use = async (job: JobView, replace: boolean) => {
    const res = job.result;
    if (!res) return;
    if (existingSplat && !replace) return setReplaceFor(job.id);
    setReplaceFor(null);
    const info: SplatEnvironmentInfo = {
      assetId: res.assetId,
      reconstructionId: res.reconstructionId,
      name: res.name,
      format: res.format,
      byteSize: res.byteSize,
      gaussianCount: res.gaussianCount,
      checksum: res.checksum,
      method: "generated",
      sources: res.sources,
      createdAt: res.createdAt,
    };
    props.onResult(info);
    props.onStatus("busy", "Loading the reconstruction…");
    try {
      if (existingSplat) props.adapter().removeObject(existingSplat.id);
      const id = await props.adapter().addSplat({
        assetId: info.assetId,
        name: info.name,
        checksum: info.checksum,
        reconstructionId: info.reconstructionId,
        calibration: res.calibration,
      });
      // a provider-ESTIMATED scale is applied as the starting placement and labelled as an estimate
      if (res.calibration.scaleMethod === "provider_estimated" && res.calibration.metresPerSourceUnit) {
        const m = res.calibration.metresPerSourceUnit;
        props.adapter().updateTransform(id, {
          scale: { x: m, y: m, z: m },
          position: { x: 0, y: -res.calibration.groundOffsetMetres, z: 0 },
        });
      }
      props.onStatus("ok", "Spatial environment added — unsaved until you save the 3D set");
    } catch (e) {
      props.onStatus("error", e instanceof Error ? e.message : "The reconstruction could not be added.");
    }
  };

  const detail = useMemo(() => state?.jobs.find((j) => j.id === selected) ?? null, [state, selected]);

  return (
    <section
      className="mb-3 rounded border border-line p-2 text-xs"
      data-testid="reconstruction-jobs"
      data-loaded={state ? "true" : "false"}
    >
      <h2 className="mb-1 uppercase tracking-wide text-muted">Create reconstruction</h2>
      {loadError ? (
        <p role="alert" className="text-fail">
          {loadError}
        </p>
      ) : null}
      <p className="mb-1.5 text-muted">
        Turn reference images of THIS location into a spatial environment. Works best with photos of the same
        place, overlapping views, stable lighting and sharp focus.
      </p>

      <label className="block text-muted">
        Provider
        <select
          className="mt-1 w-full"
          value={provider}
          onChange={(e) => {
            setProvider(e.target.value);
            setModel("");
            setOptionValues({});
            setAck(false);
          }}
          data-testid="recon-provider"
        >
          <option value="" disabled>
            Choose a provider…
          </option>
          {(state?.providers ?? []).map((p) => {
            const a = providerAvailability(p);
            return (
              <option key={p.provider} value={p.provider}>
                {p.label} — {providerKindLabel(p)}
                {a === "ready" ? "" : ` (${AVAILABILITY_LABEL[a]})`}
              </option>
            );
          })}
        </select>
      </label>
      {summary && availability ? (
        <div
          className="mt-1"
          data-testid="recon-provider-status"
          data-state={availability}
          data-execution={summary.execution}
          data-cost={summary.cost}
        >
          {summary.label} · {providerKindLabel(summary)} · {AVAILABILITY_LABEL[availability]}
        </div>
      ) : null}
      {summary?.local ? (
        // local execution: the same-host worker and its toolchain, as the worker last reported them
        <div
          className="mt-1 rounded border border-line p-1.5"
          data-testid="recon-local-runtime"
          data-worker={summary.local.worker}
          data-toolchain={summary.local.toolchain}
          data-busy={summary.local.busy ? "true" : "false"}
        >
          <div data-testid="recon-local-worker">Worker: {WORKER_LABEL[summary.local.worker]}</div>
          <div data-testid="recon-local-toolchain">Toolchain: {summary.local.toolchainLabel}</div>
          {summary.local.busy ? (
            <div className="text-muted">
              The local worker is running a reconstruction; new jobs wait their turn (one at a time).
            </div>
          ) : null}
        </div>
      ) : null}
      {summary?.remote ? (
        // a paired workstation of THIS project runs the job (counts only: no device key or address)
        <div
          className="mt-1 rounded border border-line p-1.5"
          data-testid="recon-remote-runtime"
          data-state={summary.remote.state}
          data-ready={summary.remote.ready}
          data-busy={summary.remote.busy}
        >
          <div data-testid="recon-remote-summary">
            {summary.remote.state === "ready"
              ? `Ready · ${summary.remote.ready} workstation${summary.remote.ready === 1 ? "" : "s"} online`
              : summary.remote.state === "no_agents"
                ? "No paired workstation"
                : summary.remote.state === "offline"
                  ? "Paired workstation offline"
                  : summary.remote.state === "toolchain"
                    ? "Toolchain unavailable"
                    : summary.remote.state === "outdated"
                      ? "No ready paired workstation (update the Local Agent)"
                      : "Not available on this server"}
          </div>
          {summary.remote.busy > 0 ? (
            <div className="text-muted">
              A paired workstation is running a reconstruction; new jobs wait their turn.
            </div>
          ) : null}
          <div className="text-muted">
            The job runs on your paired workstation; you can close this page.{" "}
            <a
              className="underline"
              href={`/projects/${props.projectSlug}/agents`}
              data-testid="recon-remote-agents-link"
            >
              Local agents
            </a>
          </div>
        </div>
      ) : null}

      {summary && summary.models.length > 1 ? (
        <label className="mt-1.5 block text-muted">
          Model
          <select
            className="mt-1 w-full"
            value={modelId}
            onChange={(e) => setModel(e.target.value)}
            data-testid="recon-model"
          >
            {summary.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <div className="mt-2">
        <div className="text-muted">Source images (first = primary)</div>
        <ol className="mt-1 space-y-0.5" data-testid="recon-sources">
          {chosen.map((id, i) => (
            <li
              key={id}
              className="flex items-center gap-1"
              data-testid="recon-source"
              data-asset-id={id}
              data-primary={i === 0 ? "true" : "false"}
            >
              <span className="w-4 text-muted">{i + 1}</span>
              <span className="flex-1 truncate">
                {nameOf(id)}
                {i === 0 ? " (primary)" : ""}
              </span>
              <button
                className="btn px-1"
                title="Up"
                data-testid="recon-source-up"
                onClick={() => move(i, -1)}
                disabled={i === 0}
              >
                ↑
              </button>
              <button
                className="btn px-1"
                title="Down"
                data-testid="recon-source-down"
                onClick={() => move(i, 1)}
                disabled={i === chosen.length - 1}
              >
                ↓
              </button>
              <button
                className="btn px-1"
                title="Make primary"
                data-testid="recon-source-primary"
                onClick={() => setChosen((c) => [id, ...c.filter((x) => x !== id)])}
                disabled={i === 0}
              >
                ★
              </button>
              <button
                className="btn px-1"
                title="Remove"
                data-testid="recon-source-remove"
                onClick={() => setChosen((c) => c.filter((x) => x !== id))}
              >
                ×
              </button>
            </li>
          ))}
        </ol>
        {images.filter((i) => !chosen.includes(i.id)).length > 0 ? (
          <ul className="mt-1 space-y-0.5">
            {images
              .filter((i) => !chosen.includes(i.id))
              .map((i) => (
                <li key={i.id}>
                  <button
                    className="btn w-full truncate text-left"
                    data-testid="recon-add-source"
                    onClick={() => setChosen((c) => [...c, i.id])}
                  >
                    + {i.name}
                  </button>
                </li>
              ))}
          </ul>
        ) : images.length === 0 ? (
          <p className="mt-1 text-muted">Add Location reference images in the asset library first.</p>
        ) : null}
      </div>

      {(summary?.options ?? []).map((o) =>
        o.kind === "boolean" ? (
          <label key={o.key} className="mt-1.5 flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={options[o.key] === true}
              onChange={(e) => setOptionValues((v) => ({ ...v, [o.key]: e.target.checked }))}
              data-testid={`recon-option-${o.key}`}
            />
            {o.label}
          </label>
        ) : (
          <label key={o.key} className="mt-1.5 block text-muted">
            {o.label}
            <select
              className="mt-1 w-full"
              value={String(options[o.key])}
              onChange={(e) => setOptionValues((v) => ({ ...v, [o.key]: e.target.value }))}
              data-testid={`recon-option-${o.key}`}
            >
              {o.choices.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
        ),
      )}

      {summary ? (
        <div
          className="mt-2 rounded border border-line p-1.5"
          data-testid="recon-cost"
          data-cost={summary.cost}
        >
          {summary.label} · {chosen.length} image{chosen.length === 1 ? "" : "s"}
          {modelInfo ? ` · ${modelInfo.label}` : ""}
          <br />
          {mode
            ? estimateText(estimate, summary.testOnly)
            : summary.cost === "free"
              ? estimateText(summary.estimates[modelId]?.[summary.inputModes[0]!] ?? null, summary.testOnly)
              : "Choose images to see the documented price."}
          {billable ? (
            <label className="mt-1 flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={ack}
                onChange={(e) => setAck(e.target.checked)}
                data-testid="recon-ack-cost"
              />
              I understand provider charges may apply.
            </label>
          ) : null}
        </div>
      ) : null}

      {gate.length > 0 ? (
        <ul className="mt-1 list-disc pl-4 text-warn" data-testid="recon-gate">
          {gate.map((g) => (
            <li key={g}>{g}</li>
          ))}
        </ul>
      ) : null}
      <button
        className="btn btn-primary mt-1.5 w-full"
        disabled={!canGenerate}
        onClick={() => void generate()}
        data-testid="recon-generate"
      >
        {busy ? "Working…" : "Generate Reconstruction"}
      </button>

      <h3 className="mt-3 uppercase tracking-wide text-muted">Jobs</h3>
      <ul className="mt-1 space-y-1" data-testid="recon-jobs">
        {(state?.jobs ?? []).length === 0 ? (
          <li className="text-muted">No reconstruction jobs yet.</li>
        ) : null}
        {(state?.jobs ?? []).map((j) => (
          <li key={j.id}>
            <button
              className={`w-full rounded border px-1.5 py-1 text-left ${j.id === selected ? "border-accent" : "border-line"}`}
              data-testid="recon-job"
              data-job-id={j.id}
              data-status={j.status}
              data-attempt={j.attempt}
              data-previous-job-id={j.previousJobId ?? ""}
              data-stage={j.stage ?? ""}
              onClick={() => setSelected(j.id)}
            >
              <span className="font-medium">{STATUS_LABEL[j.status]}</span> · {j.providerLabel} ·{" "}
              {j.sources.length} image
              {j.sources.length === 1 ? "" : "s"} · {time(j.createdAt)}
              {j.attempt > 1 ? ` · attempt ${j.attempt}` : ""}
              {j.progress !== null && ACTIVE.has(j.status) ? (
                <span
                  className="mt-0.5 block h-1 rounded bg-line"
                  data-testid="recon-progress"
                  data-progress={j.progress}
                >
                  <span
                    className="block h-1 rounded bg-accent"
                    style={{ width: `${Math.round(j.progress * 100)}%` }}
                  />
                </span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>

      {detail ? (
        <div
          className="mt-2 rounded border border-line p-1.5"
          data-testid="recon-job-detail"
          data-status={detail.status}
        >
          <div className="mb-1 font-medium">
            {detail.providerLabel} · {detail.model ?? "default model"} · attempt {detail.attempt}
          </div>
          <div className="mb-1 flex flex-wrap gap-1">
            {detail.sources.map((s) => (
              // the authenticated Prism Asset route: never a provider or public URL
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={s.assetId}
                src={`/api/assets/${s.assetId}`}
                alt={s.name}
                title={`${s.ordinal + 1}. ${s.name}`}
                className="h-10 w-10 rounded object-cover"
                data-testid="recon-thumb"
              />
            ))}
          </div>
          <div data-testid="recon-job-status">
            Status: {STATUS_LABEL[detail.status]}
            {detail.description ? ` · ${detail.description}` : ""}
          </div>
          {detail.runner === "remote_agent" ? (
            <div className="text-muted" data-testid="recon-job-agent">
              Remote Local Agent{detail.agentLabel ? ` · ${detail.agentLabel}` : ""}
              {detail.stage ? ` · stage ${detail.stage.replace(/_/g, " ")}` : ""}
            </div>
          ) : null}
          <div className="text-muted" data-testid="recon-job-cost">
            {detail.costEstimate
              ? `Estimate at submission: ${estimateText(detail.costEstimate, detail.costEstimate.costClass === "free")}`
              : "No cost estimate was recorded for this job."}
            {detail.actualCost
              ? ` Provider-reported charge: ${
                  detail.actualCost.usd !== null
                    ? `$${detail.actualCost.usd.toFixed(2)}`
                    : `${detail.actualCost.providerUnits?.amount} ${detail.actualCost.providerUnits?.unit}`
                }.`
              : ""}
          </div>
          {!detail.providerKnown ? (
            <p className="text-muted" data-testid="recon-provider-unknown">
              This server no longer has the provider “{detail.provider}”. The job is kept as history.
            </p>
          ) : null}
          {detail.errorMessage ? (
            <p className={detail.status === "failed" ? "text-fail" : "text-muted"} data-testid="recon-error">
              {detail.errorMessage}
            </p>
          ) : null}
          {detail.result ? (
            <div className="mt-1" data-testid="recon-result">
              Result: {detail.result.format.toUpperCase()} ·{" "}
              {detail.result.gaussianCount?.toLocaleString() ?? "?"} Gaussians · scale{" "}
              {detail.result.calibration.scaleMethod === "provider_estimated"
                ? `provider-estimated (1 unit ≈ ${detail.result.calibration.metresPerSourceUnit} m)`
                : "unknown"}
            </div>
          ) : null}
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {ACTIVE.has(detail.status) && detail.status !== "submitting" && detail.status !== "ingesting" ? (
              <button
                className="btn"
                disabled={busy}
                onClick={() => void act("cancel", detail)}
                data-testid="recon-cancel"
              >
                Cancel reconstruction
              </button>
            ) : null}
            {detail.status === "failed" || detail.status === "cancelled" ? (
              <button
                className="btn"
                disabled={busy}
                onClick={() => void act("retry", detail)}
                data-testid="recon-retry"
              >
                Retry (new attempt)
              </button>
            ) : null}
            {detail.status === "succeeded" && detail.result ? (
              <button
                className="btn btn-primary"
                disabled={!props.ready || busy}
                onClick={() => void use(detail, false)}
                data-testid="recon-use"
              >
                Use as Spatial Environment
              </button>
            ) : null}
          </div>
          {replaceFor === detail.id ? (
            <div className="mt-1.5 rounded border border-warn p-1.5 text-warn" data-testid="recon-replace">
              This set already has a spatial environment ({existingSplat?.name}). Its reconstruction stays in
              history.
              <button
                className="btn mt-1 w-full"
                onClick={() => void use(detail, true)}
                data-testid="recon-replace-confirm"
              >
                Replace current spatial environment
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
