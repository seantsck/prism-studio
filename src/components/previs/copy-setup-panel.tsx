"use client";

import { useState } from "react";
import {
  SETUP_COMPONENTS,
  SETUP_COMPONENT_LABEL,
  type SetupComponent,
  type SetupCopyPlan,
} from "@/domain/previs/setup-copy";
import { copyShotSetup, previewShotSetupCopy } from "@/server/setup-copy-actions";
import {
  copyTemplateSetup,
  deleteSetupTemplate,
  previewTemplateSetupCopy,
  renameSetupTemplate,
  replaceSetupTemplateContent,
  saveSetupTemplate,
  type SetupTemplateSummary,
} from "@/server/setup-template-actions";

/**
 * Phase 4D "Copy setup from…": copies another Shot's — or a named template's — camera, lighting and/or blocking INTO
 * this Shot as this Shot's own values. It is never a link: nothing here keeps following the source. The person always
 * sees what will be copied and what it replaces before confirming, and the copy is refused if anything changed after
 * that review. Templates (4D-I2) are snapshots: saving one copies this Shot's values; editing or deleting one never
 * changes a Shot that copied it.
 */
export interface CopySetupSource {
  id: string;
  label: string;
}
export interface SetupCopyHistoryLine {
  id: string;
  text: string;
}

type Preview = {
  plan: SetupCopyPlan | null;
  available: Record<SetupComponent, boolean>;
  characters: Record<string, string>;
  noop: boolean;
  sourceLabel: string;
};

const short = (fp: string) => fp.slice(0, 8);
const parts = (ps: readonly SetupComponent[]) =>
  ps.map((p) => SETUP_COMPONENT_LABEL[p].toLowerCase()).join(", ");

export function CopySetupPanel(props: {
  projectSlug: string;
  shotId: string;
  shotCode: string;
  sources: CopySetupSource[];
  /** null = templates are unavailable (database before migration 0050) */
  templates: SetupTemplateSummary[] | null;
  /** what THIS Shot has on the current set, i.e. what "Save setup as template" can snapshot */
  ownAvailable: Record<SetupComponent, boolean>;
  history: SetupCopyHistoryLine[];
}) {
  const [sourceKey, setSourceKey] = useState("");
  const [chosen, setChosen] = useState<SetupComponent[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const form = (fields: Record<string, string>) => {
    const f = new FormData();
    f.set("projectSlug", props.projectSlug);
    f.set("shotId", props.shotId);
    for (const [k, v] of Object.entries(fields)) f.set(k, v);
    return f;
  };
  const split = (key: string) => {
    const i = key.indexOf(":");
    return { kind: key.slice(0, i) as "shot" | "template", id: key.slice(i + 1) };
  };

  async function review(key: string, components: SetupComponent[] | null) {
    setError(null);
    setPreview(null);
    if (!key) return;
    setBusy(true);
    try {
      const { kind, id } = split(key);
      const fields: Record<string, string> = kind === "shot" ? { sourceShotId: id } : { templateId: id };
      if (components) fields.components = JSON.stringify(components);
      if (kind === "shot") {
        const r = await previewShotSetupCopy(form(fields));
        if (!r.ok) return setError(r.error);
        setPreview({ ...r, sourceLabel: `Shot ${r.sourceShotCode}` });
        setChosen(r.plan?.components ?? []);
      } else {
        const r = await previewTemplateSetupCopy(form(fields));
        if (!r.ok) return setError(r.error);
        setPreview({ ...r, sourceLabel: `template “${r.template.name}”` });
        setChosen(r.plan?.components ?? []);
      }
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!preview?.plan) return;
    setBusy(true);
    setError(null);
    try {
      const { kind, id } = split(sourceKey);
      const fields = { components: JSON.stringify(preview.plan.components), token: preview.plan.token };
      const r =
        kind === "shot"
          ? await copyShotSetup(form({ ...fields, sourceShotId: id }))
          : await copyTemplateSetup(form({ ...fields, templateId: id }));
      if (!r.ok) {
        setError(r.error);
        if (r.conflict) void review(sourceKey, preview.plan.components);
        return;
      }
      // reload so the editor below remounts on this Shot's NEW rows (never on the source's)
      const url = new URL(window.location.href);
      url.searchParams.delete("copiedFrom");
      url.searchParams.delete("copiedTemplate");
      url.searchParams.set(kind === "shot" ? "copiedFrom" : "copiedTemplate", id);
      url.searchParams.set("copied", r.copied.join(","));
      window.location.assign(url.toString());
    } finally {
      setBusy(false);
    }
  }

  const plan = preview?.plan ?? null;
  const name = (id: string) => preview?.characters[id] ?? "Character";
  const templates = props.templates ?? [];

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
          value={sourceKey}
          disabled={busy || (props.sources.length === 0 && templates.length === 0)}
          onChange={(e) => {
            setSourceKey(e.target.value);
            void review(e.target.value, null);
          }}
        >
          <option value="">
            {props.sources.length === 0 && templates.length === 0
              ? "No other Shot or template on this set"
              : "Choose a Shot or template"}
          </option>
          {props.sources.length > 0 ? (
            <optgroup label="Shots in this Location">
              {props.sources.map((s) => (
                <option key={s.id} value={`shot:${s.id}`}>
                  {s.label}
                </option>
              ))}
            </optgroup>
          ) : null}
          {templates.length > 0 ? (
            <optgroup label="Templates on this set">
              {templates.map((t) => (
                <option key={t.id} value={`template:${t.id}`}>
                  {`Template: ${t.name}`}
                </option>
              ))}
            </optgroup>
          ) : null}
        </select>
      </div>
      <p className="mt-1 text-[12px] text-muted">
        This creates an independent copy in Shot {props.shotCode}. Later edits to the source Shot or template,
        or deleting it, never change this Shot.
      </p>

      {error ? (
        <p className="mt-2 text-[12px] text-warn" role="alert" data-testid="copy-setup-error">
          {error}
        </p>
      ) : null}

      {preview ? (
        <div className="mt-2 space-y-1.5" data-testid="copy-setup-preview">
          <p className="text-[12px]" data-testid="copy-setup-from">
            From {preview.sourceLabel}
          </p>
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
                  void review(sourceKey, next);
                }}
              />
              <span>
                <span className="font-medium">Copy {SETUP_COMPONENT_LABEL[c]}</span>
                {!preview.available[c] ? (
                  <span className="text-muted"> — {preview.sourceLabel} has none on this set</span>
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

      {props.templates ? (
        <TemplateLibrary
          projectSlug={props.projectSlug}
          shotId={props.shotId}
          shotCode={props.shotCode}
          templates={props.templates}
          ownAvailable={props.ownAvailable}
        />
      ) : null}

      {props.history.length > 0 ? (
        <div className="mt-3 border-t border-line pt-2" data-testid="setup-copy-history">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">Copy history</p>
          <ul className="mt-1 space-y-0.5 text-[12px] text-muted">
            {props.history.map((h) => (
              <li key={h.id} data-testid="setup-copy-history-line">
                {h.text}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

/** Save this Shot's setup as a named template, and manage the templates on this set. */
function TemplateLibrary(props: {
  projectSlug: string;
  shotId: string;
  shotCode: string;
  templates: SetupTemplateSummary[];
  ownAvailable: Record<SetupComponent, boolean>;
}) {
  const offered = SETUP_COMPONENTS.filter((c) => props.ownAvailable[c]);
  const [name, setName] = useState("");
  const [include, setInclude] = useState<SetupComponent[]>(offered);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);

  const form = (fields: Record<string, string>) => {
    const f = new FormData();
    f.set("projectSlug", props.projectSlug);
    f.set("shotId", props.shotId);
    for (const [k, v] of Object.entries(fields)) f.set(k, v);
    return f;
  };
  async function run(p: Promise<{ ok: boolean; error?: string }>) {
    setBusy(true);
    setError(null);
    try {
      const r = await p;
      if (!r.ok) return setError(r.error ?? "Something went wrong.");
      window.location.reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 border-t border-line pt-2" data-testid="setup-templates">
      <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">Setup templates</p>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px]">
        <input
          className="min-w-0 max-w-xs"
          placeholder="Template name"
          aria-label="Template name"
          data-testid="template-name"
          value={name}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
        />
        {SETUP_COMPONENTS.map((c) => (
          <label key={c} className="flex items-center gap-1">
            <input
              type="checkbox"
              data-testid={`template-include-${c}`}
              disabled={busy || !props.ownAvailable[c]}
              checked={include.includes(c)}
              onChange={(e) =>
                setInclude(e.target.checked ? [...include, c] : include.filter((x) => x !== c))
              }
            />
            {SETUP_COMPONENT_LABEL[c]}
          </label>
        ))}
        <button
          className="btn"
          data-testid="template-save"
          disabled={busy || name.trim() === "" || include.length === 0}
          onClick={() =>
            void run(saveSetupTemplate(form({ name, description: "", components: JSON.stringify(include) })))
          }
        >
          Save setup as template
        </button>
      </div>
      <p className="mt-1 text-[12px] text-muted">
        A template is a snapshot of Shot {props.shotCode}&apos;s values. Changing this Shot later does not
        change it, and changing or deleting a template never changes a Shot that copied it.
      </p>
      {error ? (
        <p className="mt-1 text-[12px] text-warn" role="alert" data-testid="template-error">
          {error}
        </p>
      ) : null}
      <ul className="mt-1 space-y-1 text-[12px]">
        {props.templates.map((t) => (
          <li
            key={t.id}
            className="flex flex-wrap items-center gap-2"
            data-testid="setup-template"
            data-template-id={t.id}
            data-revision={t.revision}
            data-content-fingerprint={t.contentFingerprint}
          >
            {renaming?.id === t.id ? (
              <>
                <input
                  className="min-w-0 max-w-xs"
                  aria-label="New template name"
                  data-testid="template-rename-input"
                  value={renaming.name}
                  maxLength={120}
                  onChange={(e) => setRenaming({ id: t.id, name: e.target.value })}
                />
                <button
                  className="btn"
                  data-testid="template-rename-save"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      renameSetupTemplate(
                        form({
                          templateId: t.id,
                          expectedRevision: String(t.revision),
                          name: renaming.name,
                          description: t.description,
                        }),
                      ),
                    )
                  }
                >
                  Save name
                </button>
              </>
            ) : (
              <span className="font-medium" data-testid="setup-template-name">
                {t.name}
              </span>
            )}
            <span className="text-muted">
              {parts(t.parts)} · revision {t.revision} · {short(t.contentFingerprint)}
              {t.sourceShotCode ? ` · saved from Shot ${t.sourceShotCode}` : ""}
            </span>
            <button
              className="btn"
              data-testid="template-rename"
              disabled={busy}
              onClick={() => setRenaming({ id: t.id, name: t.name })}
            >
              Rename
            </button>
            <button
              className="btn"
              data-testid="template-replace"
              disabled={busy || offered.length === 0}
              title={`Replace the template's values with Shot ${props.shotCode}'s current ${parts(offered)}`}
              onClick={() =>
                void run(
                  replaceSetupTemplateContent(
                    form({
                      templateId: t.id,
                      expectedRevision: String(t.revision),
                      components: JSON.stringify(offered),
                    }),
                  ),
                )
              }
            >
              Replace with this Shot&apos;s setup
            </button>
            <button
              className="btn"
              data-testid="template-delete"
              disabled={busy}
              onClick={() =>
                void run(
                  deleteSetupTemplate(form({ templateId: t.id, expectedRevision: String(t.revision) })),
                )
              }
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
