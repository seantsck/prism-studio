"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  LIGHT_ROLES,
  LIGHT_TYPES,
  LIGHTING_REVIEW_LABEL,
  MAX_LIGHT_INTENSITY,
  MAX_SHOT_LIGHTS,
  MAX_SPOT_CONE_DEG,
  MIN_SPOT_CONE_DEG,
  emptyShotLightingDraft,
  lightingFingerprint,
  lightingReview,
  newShotLight,
  parseShotLightingDraft,
  type BaseEnvironment,
  type CurrentLightingState,
  type ShotLight,
  type ShotLightType,
  type ShotLightingDraft,
} from "@/domain/previs/lighting";
import type { ShotLightingRigRecord } from "@/data/previs-repository";
import type { SpatialSceneAdapter } from "@/lib/previs/scene-adapter";
import {
  clearShotLighting,
  loadShotLighting,
  saveShotLighting,
  type ShotLightingData,
} from "@/server/previs-actions";

/**
 * Shot Lighting: a Shot-owned overlay on the Set. Edits are previewed live and become the Shot's lighting only when saved.
 * Saving never touches the Set, `Shot.lighting` or another Shot.
 */

export interface LightingState {
  shotId: string;
  /** this Shot's rig has been loaded and applied to the overlay */
  loaded: boolean;
  /** the live overlay differs from what is saved */
  dirty: boolean;
  current: CurrentLightingState;
}

export interface ShotLightingPanelProps {
  adapter: () => SpatialSceneAdapter;
  ready: boolean;
  projectSlug: string;
  locationId: string;
  shotId: string;
  /** the stored rig when this is the page's own Shot; null = fetch it */
  initial: ShotLightingData | null;
  savedSceneFingerprint: string | null;
  sceneDocumentId: string | null;
  sceneDirty: boolean;
  /** the base environment the Shot's renders would now use (null while the set has unsaved changes) */
  baseEnvironment: BaseEnvironment | null;
  ensureSceneSaved: () => Promise<{ revision: number; fingerprint: string } | null>;
  hasVisibleSplat: boolean;
  onState: (s: LightingState) => void;
}

type Status = { tone: "idle" | "ok" | "error" | "busy"; text: string };
const short = (fp: string | null) => (fp ? fp.slice(0, 10) : "—");

const draftOf = (r: ShotLightingRigRecord): ShotLightingDraft => ({
  schema: r.rig.schema,
  base: r.rig.base,
  lights: r.rig.lights,
});

export function ShotLightingPanel(props: ShotLightingPanelProps) {
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState<ShotLightingRigRecord | null>(null);
  const [intent, setIntent] = useState<ShotLightingData["currentIntent"] | null>(null);
  const [draft, setDraft] = useState<ShotLightingDraft | null>(null);
  const [status, setStatus] = useState<Status>({ tone: "idle", text: "" });
  const [pick, setPick] = useState<ShotLightType>("point");
  const nextId = useRef(1);
  const propsRef = useRef(props);
  useEffect(() => {
    propsRef.current = props;
  });

  // a rig authored for another set (another Location, or before this Location had a saved set) is never applied
  const elsewhere =
    !!saved &&
    (saved.locationId !== props.locationId ||
      (!!props.sceneDocumentId && saved.sceneDocumentId !== props.sceneDocumentId));

  // ── load this Shot's rig into the overlay; leaving the Shot removes it and restores the engine's base lights ──
  useEffect(() => {
    if (!props.ready) return;
    let cancelled = false;
    const apply = (d: ShotLightingData) => {
      if (cancelled) return;
      const onThisSet = d.rig && d.rig.locationId === props.locationId;
      setSaved(d.rig);
      setIntent(d.currentIntent);
      const next = d.rig && onThisSet ? draftOf(d.rig) : null;
      setDraft(next);
      props.adapter().lighting.setRig(next);
      setLoaded(true);
    };
    if (props.initial) apply(props.initial);
    else {
      const fd = new FormData();
      fd.set("projectSlug", props.projectSlug);
      fd.set("shotId", props.shotId);
      void loadShotLighting(fd).then((r) => {
        if (cancelled) return;
        if (r.ok) apply({ rig: r.rig, currentIntent: r.currentIntent });
        else setStatus({ tone: "error", text: r.error });
      });
    }
    return () => {
      cancelled = true;
      try {
        props.adapter().lighting.setRig(null);
      } catch {
        /* the editor is already gone */
      }
    };
    // the Shot is the identity of this panel (the parent keys it)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.ready, props.shotId]);

  const savedFingerprint = saved?.lightingFingerprint ?? null;
  const parsedDraft = useMemo(() => {
    if (!draft) return null;
    try {
      return parseShotLightingDraft(draft);
    } catch {
      return null;
    }
  }, [draft]);
  const invalid = !!draft && !parsedDraft;
  const liveFingerprint = parsedDraft ? lightingFingerprint(parsedDraft) : null;
  const labelsChanged =
    !!parsedDraft &&
    !!saved &&
    JSON.stringify(parsedDraft.lights.map((l) => [l.id, l.role, l.label])) !==
      JSON.stringify(saved.rig.lights.map((l) => [l.id, l.role, l.label]));
  const dirty = loaded && !elsewhere && (invalid || liveFingerprint !== savedFingerprint || labelsChanged);

  const { onState } = props;
  useEffect(() => {
    onState({
      shotId: props.shotId,
      loaded,
      dirty,
      current: {
        lightingFingerprint: elsewhere ? null : savedFingerprint,
        baseEnvironment: props.baseEnvironment,
      },
    });
  }, [props.shotId, loaded, dirty, elsewhere, savedFingerprint, props.baseEnvironment, onState]);

  const edit = useCallback(
    (next: ShotLightingDraft | null) => {
      setDraft(next);
      let live: ShotLightingDraft | null = null;
      try {
        live = next ? parseShotLightingDraft(next) : null;
      } catch {
        return; // an unfinished field is previewed once it is valid again
      }
      props.adapter().lighting.setRig(live);
    },
    [props],
  );

  const patchLight = (id: string, change: Partial<Record<string, unknown>>) => {
    if (!draft) return;
    edit({
      ...draft,
      lights: draft.lights.map((l) => (l.id === id ? ({ ...l, ...change } as ShotLight) : l)),
    });
  };

  const addLight = () => {
    const base = draft ?? emptyShotLightingDraft();
    if (base.lights.length >= MAX_SHOT_LIGHTS) return;
    let id = `light-${nextId.current++}`;
    while (base.lights.some((l) => l.id === id)) id = `light-${nextId.current++}`;
    edit({ ...base, lights: [...base.lights, newShotLight(pick, id)] });
  };

  const save = async () => {
    if (!parsedDraft && !draft) return;
    if (!parsedDraft) return setStatus({ tone: "error", text: "A light has a value that is out of range." });
    const scene = await props.ensureSceneSaved();
    if (!scene) return;
    setStatus({ tone: "busy", text: "Saving Shot lighting…" });
    const fd = new FormData();
    fd.set("projectSlug", props.projectSlug);
    fd.set("shotId", props.shotId);
    fd.set("locationId", props.locationId);
    fd.set("expectedRevision", saved ? String(saved.revision) : "");
    fd.set("rigJson", JSON.stringify(parsedDraft));
    const r = await saveShotLighting(fd);
    if (!r.ok)
      return setStatus({
        tone: "error",
        text: r.conflict ? "This Shot's lighting changed elsewhere. Reload the page to continue." : r.error,
      });
    setSaved(r.rig);
    setIntent(r.rig.rig.authoredIntent);
    setDraft(draftOf(r.rig));
    props.adapter().lighting.setRig(draftOf(r.rig));
    setStatus({ tone: "ok", text: `Shot lighting saved — revision ${r.rig.revision}` });
  };

  const discard = () => {
    edit(saved && !elsewhere ? draftOf(saved) : null);
    setStatus({ tone: "idle", text: "" });
  };

  const clear = async () => {
    if (!saved) return edit(null);
    setStatus({ tone: "busy", text: "Clearing Shot lighting…" });
    const fd = new FormData();
    fd.set("projectSlug", props.projectSlug);
    fd.set("shotId", props.shotId);
    fd.set("expectedRevision", String(saved.revision));
    const r = await clearShotLighting(fd);
    if (!r.ok) return setStatus({ tone: "error", text: r.error });
    setSaved(null);
    edit(null);
    setStatus({
      tone: "ok",
      text: "Shot lighting cleared. Existing renders keep the lighting they recorded.",
    });
  };

  const review =
    saved && intent
      ? lightingReview({
          rig: saved.rig,
          rigSceneFingerprint: saved.sceneFingerprint,
          currentIntent: intent,
          currentSceneFingerprint: props.savedSceneFingerprint,
        })
      : [];

  const baseMode = draft?.base.mode ?? "engine_default";

  return (
    <section
      className="mt-4"
      data-testid="shot-lighting"
      data-loaded={loaded ? "true" : "false"}
      data-dirty={dirty ? "true" : "false"}
      data-revision={saved?.revision ?? ""}
      data-saved-fingerprint={savedFingerprint ?? ""}
      data-live-fingerprint={liveFingerprint ?? ""}
    >
      <h2 className="mb-1 text-xs uppercase tracking-wide text-muted">Shot lighting</h2>
      <p className="mb-1 text-xs text-muted">
        Lights this Shot only. It never changes the 3D set or the Shot&apos;s written lighting. Shadows are
        not simulated in Shot Lighting v1.
      </p>
      {elsewhere ? (
        <div className="mb-1 text-xs text-warn" data-testid="lighting-elsewhere">
          This Shot&apos;s lighting rig was authored for another 3D set. It is not applied here. Clear it to
          light the Shot here.
        </div>
      ) : null}
      {review.map((code) => (
        <div
          key={code}
          className="mb-1 text-xs text-warn"
          data-testid={`lighting-review-${code.replaceAll("_", "-")}`}
        >
          {LIGHTING_REVIEW_LABEL[code]}
        </div>
      ))}
      {props.hasVisibleSplat ? (
        <div className="mb-1 text-xs text-muted" data-testid="lighting-splat-note">
          Shot lighting affects mesh and Character geometry. This Gaussian-splat environment carries its own
          baked appearance and does not respond to these lights.
        </div>
      ) : null}

      {!elsewhere ? (
        <>
          <label className="mb-1.5 block text-xs text-muted">
            Engine base lights
            <select
              className="mt-1 w-full"
              value={baseMode}
              disabled={!loaded}
              data-testid="lighting-base-mode"
              onChange={(e) =>
                edit({
                  ...(draft ?? emptyShotLightingDraft()),
                  base: { mode: e.target.value as "engine_default" | "replace" },
                })
              }
            >
              <option value="engine_default">Keep the engine&apos;s default lighting</option>
              <option value="replace">Replace it (only this Shot&apos;s lights)</option>
            </select>
          </label>

          <div className="mb-1.5 flex gap-1.5">
            <select
              className="min-w-0 flex-1"
              value={pick}
              aria-label="Light type"
              data-testid="lighting-add-type"
              onChange={(e) => setPick(e.target.value as ShotLightType)}
            >
              {LIGHT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <button
              className="btn"
              disabled={!loaded || (draft?.lights.length ?? 0) >= MAX_SHOT_LIGHTS}
              data-testid="lighting-add"
              onClick={addLight}
            >
              Add light
            </button>
          </div>

          <ul className="space-y-1.5">
            {(draft?.lights ?? []).map((l) => (
              <LightEditor
                key={l.id}
                light={l}
                onChange={(c) => patchLight(l.id, c)}
                onRemove={() =>
                  draft && edit({ ...draft, lights: draft.lights.filter((x) => x.id !== l.id) })
                }
              />
            ))}
          </ul>

          <div className="mt-1.5 flex gap-1.5">
            <button
              className="btn btn-primary flex-1"
              disabled={!loaded || !draft || invalid || (!dirty && review.length === 0 && !!saved)}
              data-testid="lighting-save"
              onClick={() => void save()}
            >
              {!dirty && review.length > 0 ? "Re-save against the current Shot" : "Save lighting"}
            </button>
            <button className="btn" disabled={!dirty} data-testid="lighting-discard" onClick={discard}>
              Discard
            </button>
          </div>
        </>
      ) : null}
      <button
        className="btn mt-1.5 w-full"
        disabled={!loaded || (!saved && !draft)}
        data-testid="lighting-clear"
        onClick={() => void clear()}
      >
        Clear Shot lighting
      </button>
      {saved ? (
        <div className="mt-1 text-xs text-muted" data-testid="lighting-saved-info">
          Saved: revision {saved.revision} · {short(savedFingerprint)}
        </div>
      ) : null}
      {status.text ? (
        <div
          role="status"
          data-testid="lighting-status"
          className={`mt-1 text-xs ${status.tone === "error" ? "text-fail" : status.tone === "ok" ? "text-pass" : "text-muted"}`}
        >
          {status.text}
        </div>
      ) : null}
    </section>
  );
}

function NumberField(props: {
  label: string;
  testId: string;
  value: number;
  min?: number;
  max?: number;
  step?: string;
  onChange: (n: number) => void;
}) {
  return (
    <label className="block text-xs text-muted">
      {props.label}
      <input
        type="number"
        className="mt-0.5 w-full"
        data-testid={props.testId}
        min={props.min}
        max={props.max}
        step={props.step ?? "0.1"}
        value={props.value}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (e.target.value !== "" && Number.isFinite(n)) props.onChange(n);
        }}
      />
    </label>
  );
}

function Vec3Fields(props: {
  label: string;
  testId: string;
  value: { x: number; y: number; z: number };
  onChange: (v: { x: number; y: number; z: number }) => void;
}) {
  return (
    <div>
      <div className="text-xs text-muted">{props.label}</div>
      <div className="grid grid-cols-3 gap-1">
        {(["x", "y", "z"] as const).map((axis) => (
          <NumberField
            key={axis}
            label={axis.toUpperCase()}
            testId={`${props.testId}-${axis}`}
            value={props.value[axis]}
            onChange={(n) => props.onChange({ ...props.value, [axis]: n })}
          />
        ))}
      </div>
    </div>
  );
}

function LightEditor(props: {
  light: ShotLight;
  onChange: (c: Partial<Record<string, unknown>>) => void;
  onRemove: () => void;
}) {
  const l = props.light;
  const t = (name: string) => `light-${name}`;
  return (
    <li className="space-y-1 rounded border border-line p-1.5" data-testid="light" data-light-id={l.id}>
      <div className="flex items-center gap-1.5 text-xs">
        <span className="font-medium" data-testid={t("type")}>
          {l.type}
        </span>
        <label className="ml-auto flex items-center gap-1 text-muted">
          <input
            type="checkbox"
            checked={l.enabled}
            data-testid={t("enabled")}
            onChange={(e) => props.onChange({ enabled: e.target.checked })}
          />
          On
        </label>
        <button className="btn" data-testid={t("remove")} onClick={props.onRemove}>
          Remove
        </button>
      </div>
      <label className="block text-xs text-muted">
        Label
        <input
          className="mt-0.5 w-full"
          value={l.label}
          maxLength={80}
          data-testid={t("label")}
          onChange={(e) => props.onChange({ label: e.target.value })}
        />
      </label>
      <label className="block text-xs text-muted">
        Role
        <select
          className="mt-0.5 w-full"
          value={l.role}
          data-testid={t("role")}
          onChange={(e) => props.onChange({ role: e.target.value })}
        >
          {LIGHT_ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </label>
      <div className="grid grid-cols-2 gap-1">
        <label className="block text-xs text-muted">
          Color
          <input
            type="color"
            className="mt-0.5 h-7 w-full"
            value={l.color}
            data-testid={t("color")}
            onChange={(e) => props.onChange({ color: e.target.value })}
          />
        </label>
        <NumberField
          label="Intensity"
          testId={t("intensity")}
          value={l.intensity}
          min={0}
          max={MAX_LIGHT_INTENSITY}
          onChange={(n) => props.onChange({ intensity: n })}
        />
      </div>
      {l.type !== "ambient" ? (
        <Vec3Fields
          label="Position"
          testId={t("pos")}
          value={l.position}
          onChange={(v) => props.onChange({ position: v })}
        />
      ) : null}
      {l.type === "directional" || l.type === "spot" ? (
        <Vec3Fields
          label="Aim at"
          testId={t("target")}
          value={l.target}
          onChange={(v) => props.onChange({ target: v })}
        />
      ) : null}
      {l.type === "point" || l.type === "spot" ? (
        <NumberField
          label="Range (0 = unlimited)"
          testId={t("range")}
          value={l.range}
          min={0}
          onChange={(n) => props.onChange({ range: n })}
        />
      ) : null}
      {l.type === "spot" ? (
        <div className="grid grid-cols-2 gap-1">
          <NumberField
            label="Cone half-angle (°)"
            testId={t("cone")}
            value={l.coneAngleDeg}
            min={MIN_SPOT_CONE_DEG}
            max={MAX_SPOT_CONE_DEG}
            step="1"
            onChange={(n) => props.onChange({ coneAngleDeg: n })}
          />
          <NumberField
            label="Edge softness (0–1)"
            testId={t("penumbra")}
            value={l.penumbra}
            min={0}
            max={1}
            onChange={(n) => props.onChange({ penumbra: n })}
          />
        </div>
      ) : null}
    </li>
  );
}
