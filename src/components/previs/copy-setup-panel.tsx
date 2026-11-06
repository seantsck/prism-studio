"use client";

import { useState } from "react";
import { SETUP_COMPONENTS, SETUP_COMPONENT_LABEL, type SetupComponent } from "@/domain/previs/setup-copy";
import { copyShotSetup, previewShotSetupCopy, type SetupCopyPreview } from "@/server/setup-copy-actions";

/**
 * Phase 4D "Copy setup from…": copies another Shot's camera, lighting and/or blocking INTO this Shot as this Shot's
 * own values. It is never a link: nothing here keeps following the source. The person always sees what will be copied
 * and what it replaces before confirming, and the copy is refused if either Shot changed after that review.
 */
export interface CopySetupSource {
  id: string;
  label: string;
}

const short = (fp: string) => fp.slice(0, 8);

export function CopySetupPanel(props: {
  projectSlug: string;
  shotId: string;
  shotCode: string;
  sources: CopySetupSource[];
}) {
  const [sourceId, setSourceId] = useState("");
  const [chosen, setChosen] = useState<SetupComponent[]>([]);
  const [preview, setPreview] = useState<SetupCopyPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const base = (source: string) => {
    const f = new FormData();
    f.set("projectSlug", props.projectSlug);
    f.set("shotId", props.shotId);
    f.set("sourceShotId", source);
    return f;
  };

  async function review(source: string, components: SetupComponent[] | null) {
    setError(null);
    setPreview(null);
    if (!source) return;
    setBusy(true);
    try {
      const f = base(source);
      if (components) f.set("components", JSON.stringify(components));
      const r = await previewShotSetupCopy(f);
      if (!r.ok) return setError(r.error);
      setPreview(r);
      setChosen(r.plan?.components ?? []);
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!preview?.plan) return;
    setBusy(true);
    setError(null);
    try {
      const f = base(sourceId);
      f.set("components", JSON.stringify(preview.plan.components));
      f.set("token", preview.plan.token);
      const r = await copyShotSetup(f);
      if (!r.ok) {
        setError(r.error);
        if (r.conflict) void review(sourceId, preview.plan.components);
        return;
      }
      // reload so the editor below remounts on this Shot's NEW rows (never on the source's)
      const url = new URL(window.location.href);
      url.searchParams.set("copiedFrom", sourceId);
      url.searchParams.set("copied", r.copied.join(","));
      window.location.assign(url.toString());
    } finally {
      setBusy(false);
    }
  }

  const plan = preview?.plan ?? null;
  const name = (id: string) => preview?.characters[id] ?? "Character";

  return (
    <section
      className="mx-6 mb-3 rounded-[3px] border border-line bg-panel p-3 text-sm"
      data-testid="copy-setup"
    >
      <div className="flex flex-wrap items-center gap-2">
        <label
          className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted"
          htmlFor="copy-src"
        >
          Copy setup from…
        </label>
        <select
          id="copy-src"
          className="min-w-0 max-w-xs"
          data-testid="copy-setup-source"
          value={sourceId}
          disabled={busy || props.sources.length === 0}
          onChange={(e) => {
            setSourceId(e.target.value);
            void review(e.target.value, null);
          }}
        >
          <option value="">
            {props.sources.length === 0 ? "No other Shot in this Location" : "Choose a Shot"}
          </option>
          {props.sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
      <p className="mt-1 text-[12px] text-muted">
        Copies values into Shot {props.shotCode}. The copy belongs to this Shot: later edits to the other
        Shot, or deleting it, never change this one.
      </p>

      {error ? (
        <p className="mt-2 text-[12px] text-warn" role="alert" data-testid="copy-setup-error">
          {error}
        </p>
      ) : null}

      {preview ? (
        <div className="mt-2 space-y-1.5" data-testid="copy-setup-preview">
          {SETUP_COMPONENTS.map((c) => (
            <label key={c} className="flex items-start gap-2 text-[12px]">
              <input
                type="checkbox"
                data-testid={`copy-setup-${c}`}
                disabled={busy || !preview.available[c]}
                checked={chosen.includes(c)}
                onChange={(e) => {
                  const next = e.target.checked ? [...chosen, c] : chosen.filter((x) => x !== c);
                  setChosen(next);
                  void review(sourceId, next);
                }}
              />
              <span>
                <span className="font-medium">Copy {SETUP_COMPONENT_LABEL[c].toLowerCase()}</span>
                {!preview.available[c] ? (
                  <span className="text-muted"> — Shot {preview.sourceShotCode} has none on this set</span>
                ) : null}
                {c === "camera" && plan?.camera ? (
                  <span className="block text-muted" data-testid="copy-setup-camera-line">
                    {plan.camera.label || "Production camera"} ({short(plan.camera.fingerprint)})
                    {plan.camera.unchanged
                      ? " — already identical"
                      : plan.camera.replaces
                        ? ` — replaces this Shot's camera (${short(plan.camera.replaces.fingerprint)})`
                        : " — this Shot has no camera yet"}
                  </span>
                ) : null}
                {c === "lighting" && plan?.lighting ? (
                  <span className="block text-muted" data-testid="copy-setup-lighting-line">
                    {plan.lighting.lightCount} light{plan.lighting.lightCount === 1 ? "" : "s"}, base{" "}
                    {plan.lighting.baseMode} ({short(plan.lighting.fingerprint)})
                    {plan.lighting.unchanged
                      ? " — already identical"
                      : plan.lighting.replaces
                        ? ` — replaces this Shot's lighting (revision ${plan.lighting.replaces.revision})`
                        : " — this Shot has no lighting yet"}
                    . This Shot keeps its own lighting notes.
                  </span>
                ) : null}
                {c === "blocking" && plan?.blocking ? (
                  <span className="block text-muted" data-testid="copy-setup-blocking-line">
                    {plan.blocking.figures
                      .map((f) => `${name(f.characterId)}${f.replaces ? " (replaces)" : ""}`)
                      .join(", ")}
                    {plan.blocking.removes.length > 0
                      ? `; removes ${plan.blocking.removes.map((r) => name(r.characterId)).join(", ")}`
                      : ""}
                  </span>
                ) : null}
              </span>
            </label>
          ))}
          <p className="text-[12px] text-muted">
            Copying replaces this Shot&apos;s saved setup for the chosen parts and reloads the workspace.
            Unsaved edits in the editor below are discarded.
          </p>
          <button
            className="btn btn-primary"
            data-testid="copy-setup-confirm"
            disabled={busy || !plan || preview.noop}
            onClick={() => void confirm()}
          >
            {preview.noop && plan ? "Already identical" : `Copy into Shot ${props.shotCode}`}
          </button>
        </div>
      ) : null}
    </section>
  );
}
