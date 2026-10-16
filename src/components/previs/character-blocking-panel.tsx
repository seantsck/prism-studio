"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  blockingFingerprint,
  newBlockingEntry,
  renderedBlockingFingerprint,
  summarizeBlocking,
  type BlockingFigureData,
  type ShotBlockingEntry,
} from "@/domain/previs/blocking";
import { POSE_PRESETS } from "@/domain/previs/pose";
import { DEG, quatFromEuler, quatToEuler } from "@/domain/previs/quat";
import { HUMANOID_RIG, POSE_JOINT_IDS, jointDef, type PoseJointId } from "@/domain/previs/rig";
import type { BlockingFigureView } from "@/lib/previs/blocking-overlay";
import type { SpatialSceneAdapter } from "@/lib/previs/scene-adapter";
import { loadShotBlocking, reanchorShotBlocking, saveShotBlocking } from "@/server/previs-actions";

/**
 * Shot character blocking: add a neutral rigged proxy for a Project Character, place it (root position, body
 * facing, height) and pose it (FK joint rotations). Blocking belongs to this SHOT. The proxy shows position,
 * facing, height and pose: never the Character's face, hair, wardrobe or likeness.
 */

export interface BlockingState {
  /** the saved, rendered-layer fingerprint (visible figures); null when none */
  savedFingerprint: string | null;
  /** the live overlay differs from what is saved */
  dirty: boolean;
  /** what a render made right now would show */
  liveFingerprint: () => string | null;
  /** saves the changed figures (saving the set first when needed); resolves to the saved layer fingerprint */
  ensureSaved: () => Promise<{ fingerprint: string | null } | null>;
}

interface Saved {
  blockingId: string;
  revision: number;
  fingerprint: string;
  sceneRevision: number;
  sceneFingerprint: string;
  entry: ShotBlockingEntry;
}

type Status = { tone: "idle" | "ok" | "error" | "busy"; text: string };
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const short = (fp: string | null) => (fp ? fp.slice(0, 10) : "—");

export interface CharacterBlockingPanelProps {
  adapter: () => SpatialSceneAdapter;
  ready: boolean;
  projectSlug: string;
  locationId: string;
  shotId: string;
  characters: Array<{ id: string; name: string }>;
  /** the stored blocking when this is the page's own Shot; null = fetch it */
  initial: BlockingFigureData[] | null;
  savedSceneFingerprint: string | null;
  sceneDirty: boolean;
  ensureSceneSaved: () => Promise<{ revision: number; fingerprint: string } | null>;
  onState: (s: BlockingState) => void;
}

export function CharacterBlockingPanel(props: CharacterBlockingPanelProps) {
  const [saved, setSaved] = useState<Map<string, Saved>>(new Map());
  const [loaded, setLoaded] = useState(false);
  const [figures, setFigures] = useState<BlockingFigureView[]>([]);
  const [poseMode, setPoseMode] = useState(false);
  const [joint, setJoint] = useState<PoseJointId | null>(null);
  const [skeleton, setSkeleton] = useState(true);
  const [pick, setPick] = useState("");
  const [status, setStatus] = useState<Status>({ tone: "idle", text: "" });
  // refs are synced in effects (never read or written during render)
  const savedRef = useRef(saved);
  const propsRef = useRef(props);
  useEffect(() => {
    savedRef.current = saved;
    propsRef.current = props;
  });
  const names = useMemo(() => new Map(props.characters.map((c) => [c.id, c.name])), [props.characters]);

  const overlay = () => props.adapter().blocking;

  // ── load this Shot's stored blocking into the runtime overlay ──
  useEffect(() => {
    if (!props.ready) return;
    let cancelled = false;
    const apply = (list: BlockingFigureData[]) => {
      if (cancelled) return;
      overlay().setFigures(list.map((f) => ({ entry: f.entry, label: f.name })));
      setSaved(
        new Map(
          list.map((f) => [
            f.characterId,
            {
              blockingId: f.blockingId,
              revision: f.revision,
              fingerprint: f.fingerprint,
              sceneRevision: f.sceneRevision,
              sceneFingerprint: f.sceneFingerprint,
              entry: f.entry,
            },
          ]),
        ),
      );
      setLoaded(true);
    };
    if (props.initial) apply(props.initial);
    else {
      const fd = new FormData();
      fd.set("projectSlug", props.projectSlug);
      fd.set("shotId", props.shotId);
      void loadShotBlocking(fd).then((r) => {
        if (cancelled) return;
        if (r.ok) apply(r.figures);
        else setStatus({ tone: "error", text: r.error });
      });
    }
    return () => {
      cancelled = true;
      try {
        // leaving the Shot (or the page) removes its proxies from the runtime scene; the Set itself is untouched
        overlay().setFigures([]);
      } catch {
        /* the editor is already gone */
      }
    };
    // the Shot is the identity of this panel (the parent keys it)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.ready, props.shotId]);

  // ── follow the overlay (selection, pose mode, edits) ──
  useEffect(() => {
    if (!props.ready) return;
    const a = props.adapter();
    const sync = () => {
      const b = a.blocking;
      setFigures(b.list());
      setPoseMode(b.poseMode());
      setJoint(b.selectedJointId());
      setSkeleton(b.skeletonShown());
    };
    sync();
    return a.subscribe(sync);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.ready, loaded]);

  // ── dirty + saved layer identity ──
  const anchor = { locationId: props.locationId };
  const liveEntries = useMemo(
    () => (loaded && props.ready ? overlay().readEntries() : []),
    // figures changes on every overlay notification
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [figures, loaded, props.ready],
  );
  const savedEntries = useMemo(() => [...saved.values()].map((s) => s.entry), [saved]);
  const savedFingerprint = renderedBlockingFingerprint(savedEntries, anchor);
  const dirty = useMemo(() => {
    if (!loaded) return false;
    if (liveEntries.length !== saved.size) return true;
    return liveEntries.some((e) => saved.get(e.characterId)?.fingerprint !== blockingFingerprint(e, anchor));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveEntries, saved, loaded]);

  const doSave = useCallback(async (): Promise<{ fingerprint: string | null } | null> => {
    const props = propsRef.current;
    const current = savedRef.current;
    const live = props.adapter().blocking.readEntries();
    const anchorNow = { locationId: props.locationId };
    const changed = live.filter(
      (e) => current.get(e.characterId)?.fingerprint !== blockingFingerprint(e, anchorNow),
    );
    const removed = [...current.keys()].filter((id) => !live.some((e) => e.characterId === id));
    if (changed.length === 0 && removed.length === 0)
      return { fingerprint: renderedBlockingFingerprint(live, anchorNow) };
    const scene = await props.ensureSceneSaved();
    if (!scene) {
      setStatus({ tone: "error", text: "Save the 3D set before saving character blocking." });
      return null;
    }
    setStatus({ tone: "busy", text: "Saving character blocking…" });
    const fd = new FormData();
    fd.set("projectSlug", props.projectSlug);
    fd.set("shotId", props.shotId);
    fd.set("locationId", props.locationId);
    fd.set(
      "blockingJson",
      JSON.stringify({
        save: changed.map((e) => ({
          entry: e,
          expectedRevision: current.get(e.characterId)?.revision ?? null,
        })),
        remove: removed.map((id) => ({ characterId: id, expectedRevision: current.get(id)!.revision })),
      }),
    );
    const r = await saveShotBlocking(fd);
    if (!r.ok) {
      setStatus({
        tone: "error",
        text: r.conflict ? "This shot's blocking changed elsewhere. Reload the page to continue." : r.error,
      });
      return null;
    }
    const next = new Map(current);
    for (const id of removed) next.delete(id);
    for (const f of r.figures) {
      const entry = live.find((e) => e.characterId === f.characterId) ?? current.get(f.characterId)?.entry;
      if (!entry) continue;
      next.set(f.characterId, {
        blockingId: f.blockingId,
        revision: f.revision,
        fingerprint: f.fingerprint,
        sceneRevision: f.sceneRevision,
        sceneFingerprint: f.sceneFingerprint,
        entry,
      });
    }
    savedRef.current = next;
    setSaved(next);
    setStatus({
      tone: "ok",
      text: `Character blocking saved (${live.length} character${live.length === 1 ? "" : "s"}).`,
    });
    return {
      fingerprint: renderedBlockingFingerprint(
        [...next.values()].map((s) => s.entry),
        anchorNow,
      ),
    };
  }, []);

  // publish state to the editor (master frame / previs need it)
  const liveFingerprint = useMemo(
    () => renderedBlockingFingerprint(liveEntries, { locationId: props.locationId }),
    [liveEntries, props.locationId],
  );
  useEffect(() => {
    props.onState({
      savedFingerprint,
      dirty,
      liveFingerprint: () =>
        renderedBlockingFingerprint(propsRef.current.adapter().blocking.readEntries(), {
          locationId: propsRef.current.locationId,
        }),
      ensureSaved: doSave,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedFingerprint, dirty, loaded]);

  const stale = (id: string) => {
    const s = saved.get(id);
    return !!s && !!props.savedSceneFingerprint && s.sceneFingerprint !== props.savedSceneFingerprint;
  };
  const anyStale = [...saved.keys()].some(stale);

  const reanchor = async () => {
    if (props.sceneDirty) return setStatus({ tone: "error", text: "Save the 3D set first, then re-anchor." });
    setStatus({ tone: "busy", text: "Re-anchoring to the current set…" });
    const fd = new FormData();
    fd.set("projectSlug", props.projectSlug);
    fd.set("shotId", props.shotId);
    fd.set("locationId", props.locationId);
    const r = await reanchorShotBlocking(fd);
    if (!r.ok) return setStatus({ tone: "error", text: r.error });
    setSaved((m) => {
      const next = new Map(m);
      for (const f of r.figures) {
        const cur = next.get(f.characterId);
        if (cur)
          next.set(f.characterId, {
            ...cur,
            revision: f.revision,
            sceneRevision: f.sceneRevision,
            sceneFingerprint: f.sceneFingerprint,
          });
      }
      return next;
    });
    setStatus({
      tone: "ok",
      text: "Blocking re-anchored to the current set. Positions and poses are unchanged.",
    });
  };

  const available = props.characters.filter((c) => !figures.some((f) => f.characterId === c.id));
  const chosen = pick && available.some((c) => c.id === pick) ? pick : (available[0]?.id ?? "");
  const sel = figures.find((f) => f.selected) ?? null;
  const entryOfSel = sel ? liveEntries.find((e) => e.characterId === sel.characterId) : null;

  const addProxy = () => {
    const c = props.characters.find((x) => x.id === chosen);
    if (!c) return;
    // a neutral default 1.70 m proxy at the origin: a blocking default, NOT a known fact about the Character
    overlay().add(newBlockingEntry(c.id), c.name);
  };

  return (
    <section
      className="mt-4"
      data-testid="character-blocking"
      data-figure-count={figures.length}
      data-pose-mode={poseMode ? "true" : "false"}
      data-dirty={dirty ? "true" : "false"}
      data-loaded={loaded ? "true" : "false"}
      data-saved-fingerprint={savedFingerprint ?? ""}
      data-live-fingerprint={loaded && props.ready ? (liveFingerprint ?? "") : ""}
    >
      <h2 className="mb-1 text-xs uppercase tracking-wide text-muted">Character blocking</h2>
      <p className="mb-2 text-xs text-muted">
        Where each character stands and how their body is posed in <strong>this shot</strong>. The proxy is a
        neutral mannequin: it shows position, facing, height and pose, not who they are.
      </p>
      {dirty ? (
        <span
          className="mb-1 inline-block rounded border border-warn px-1.5 text-xs text-warn"
          data-testid="blocking-dirty"
        >
          unsaved blocking
        </span>
      ) : null}
      {anyStale ? (
        <div className="mb-1 rounded border border-warn p-1.5 text-xs text-warn" data-testid="blocking-stale">
          STALE BLOCKING — the set changed after this was authored.
          <button
            className="btn mt-1 w-full"
            onClick={() => void reanchor()}
            disabled={props.sceneDirty}
            data-testid="reanchor-blocking"
          >
            Re-anchor to current set
          </button>
        </div>
      ) : null}

      <div className="flex gap-1.5">
        <select
          className="min-w-0 flex-1"
          value={chosen}
          onChange={(e) => setPick(e.target.value)}
          disabled={available.length === 0}
          aria-label="Character"
          data-testid="blocking-character"
        >
          {available.length === 0 ? <option value="">(all characters placed)</option> : null}
          {available.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <button
          className="btn"
          disabled={!props.ready || !loaded || !chosen}
          onClick={addProxy}
          data-testid="add-character-proxy"
        >
          Add Character Proxy
        </button>
      </div>

      <ul className="mt-2 space-y-0.5" data-testid="blocking-figures">
        {figures.length === 0 ? (
          <li className="text-xs text-muted">No characters blocked in this shot.</li>
        ) : null}
        {figures.map((f) => (
          <li key={f.characterId}>
            <button
              data-testid="blocking-figure"
              data-character-id={f.characterId}
              data-object-id={f.objectId}
              data-selected={f.selected ? "true" : "false"}
              className={`w-full truncate rounded px-2 py-1 text-left ${f.selected ? "bg-accent/20" : "hover:bg-panel"}`}
              onClick={() => overlay().select(f.characterId)}
            >
              {names.get(f.characterId) ?? f.label}
              <span className="ml-1 text-xs text-muted">Character Proxy</span>
              {stale(f.characterId) ? <span className="ml-1 text-xs text-warn">stale</span> : null}
              {!f.visible ? <span className="ml-1 text-xs text-muted">hidden</span> : null}
            </button>
          </li>
        ))}
      </ul>

      {sel && entryOfSel ? (
        <div className="mt-2 rounded border border-line p-2" data-testid="blocking-inspector">
          <div className="mb-1 font-medium" data-testid="blocking-name">
            {names.get(sel.characterId) ?? sel.label} · Character Proxy
          </div>
          <div className="text-xs text-muted">Root (where and which way)</div>
          <div
            className="mb-1.5 grid grid-cols-3 gap-1"
            key={`pos:${sel.root.position.x},${sel.root.position.y},${sel.root.position.z}`}
          >
            {(["x", "y", "z"] as const).map((axis) => (
              <input
                key={axis}
                type="number"
                step="0.1"
                aria-label={`Position ${axis.toUpperCase()}`}
                data-testid={`blocking-pos-${axis}`}
                defaultValue={r3(sel.root.position[axis])}
                onBlur={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n) && Math.abs(n - sel.root.position[axis]) > 1e-6)
                    overlay().setRoot(sel.characterId, { position: { [axis]: n } });
                }}
                onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
              />
            ))}
          </div>
          <div className="grid grid-cols-2 gap-1" key={`yh:${sel.root.yawDeg},${sel.root.heightM}`}>
            <label className="text-xs text-muted">
              Body yaw (°)
              <input
                type="number"
                step="5"
                className="mt-0.5 w-full"
                data-testid="blocking-yaw"
                defaultValue={r3(sel.root.yawDeg)}
                onBlur={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n) && Math.abs(n - sel.root.yawDeg) > 0.05)
                    overlay().setRoot(sel.characterId, { yawDeg: n });
                }}
                onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
              />
            </label>
            <label className="text-xs text-muted">
              Height (m)
              <input
                type="number"
                step="0.05"
                min={0.5}
                max={2.6}
                className="mt-0.5 w-full"
                data-testid="blocking-height"
                defaultValue={r3(sel.root.heightM)}
                onBlur={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n) && n >= 0.5 && n <= 2.6 && Math.abs(n - sel.root.heightM) > 1e-4)
                    overlay().setRoot(sel.characterId, { heightM: n });
                }}
                onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
              />
            </label>
          </div>
          <p className="mt-0.5 text-[11px] text-muted">
            Height is a proxy default (1.70 m), not a recorded fact about the character. Use Move/Rotate in
            the viewport to drag the whole figure.
          </p>
          <label className="mt-1.5 flex items-center gap-1.5 text-xs">
            <input
              type="checkbox"
              checked={sel.visible}
              onChange={(e) => overlay().setVisible(sel.characterId, e.target.checked)}
              data-testid="blocking-visible"
            />
            Show proxy in master frames and previs
          </label>

          <div className="mt-2 text-xs text-muted">Pose (the body, relative to the root)</div>
          <div className="mb-1.5 flex gap-1.5">
            <button
              className={`btn flex-1 ${poseMode ? "btn-primary" : ""}`}
              onClick={() => (poseMode ? overlay().exitPoseMode() : overlay().enterPoseMode(sel.characterId))}
              data-testid="pose-mode-toggle"
              aria-pressed={poseMode}
            >
              {poseMode ? "Done posing" : "Pose Mode"}
            </button>
            <button
              className="btn"
              onClick={() => overlay().resetPose(sel.characterId)}
              data-testid="pose-reset"
            >
              Reset
            </button>
          </div>
          <div className="mb-1.5 grid grid-cols-2 gap-1" data-testid="pose-presets">
            {POSE_PRESETS.map((p) => (
              <button
                key={p.id}
                className="btn"
                data-testid={`preset-${p.id}`}
                onClick={() => overlay().applyPreset(sel.characterId, p.id)}
              >
                {p.label}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-1" key={`head:${sel.head.yawDeg},${sel.head.pitchDeg}`}>
            <label className="text-xs text-muted">
              Head yaw (°)
              <input
                type="number"
                step="5"
                className="mt-0.5 w-full"
                data-testid="head-yaw"
                defaultValue={sel.head.yawDeg}
                onBlur={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n) && Math.abs(n - sel.head.yawDeg) > 0.05)
                    overlay().setHeadDirection(sel.characterId, n, sel.head.pitchDeg);
                }}
                onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
              />
            </label>
            <label className="text-xs text-muted">
              Head pitch (°)
              <input
                type="number"
                step="5"
                className="mt-0.5 w-full"
                data-testid="head-pitch"
                defaultValue={sel.head.pitchDeg}
                onBlur={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n) && Math.abs(n - sel.head.pitchDeg) > 0.05)
                    overlay().setHeadDirection(sel.characterId, sel.head.yawDeg, n);
                }}
                onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
              />
            </label>
          </div>

          {poseMode ? (
            <div className="mt-2" data-testid="joint-panel">
              <label className="mb-1 flex items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  checked={skeleton}
                  onChange={(e) => overlay().setSkeletonVisible(e.target.checked)}
                  data-testid="show-skeleton"
                />
                Show skeleton and joints
              </label>
              <div className="mb-1 text-xs" data-testid="selected-joint">
                {joint ? (
                  <>
                    Joint: <strong data-testid="selected-joint-name">{jointDef(joint).label}</strong>
                  </>
                ) : (
                  <span className="text-muted">Click a joint in the viewport or choose one below.</span>
                )}
              </div>
              {joint ? (
                <JointFields
                  key={`${joint}:${JSON.stringify(sel.pose.joints[joint] ?? 0)}`}
                  joint={joint}
                  figure={sel}
                  onChange={(q) => overlay().setJointQuat(sel.characterId, joint, q)}
                />
              ) : null}
              <ul className="mt-1 grid grid-cols-2 gap-0.5" data-testid="joint-list">
                {POSE_JOINT_IDS.map((id) => (
                  <li key={id}>
                    <button
                      className={`w-full truncate rounded px-1.5 py-0.5 text-left text-xs ${joint === id ? "bg-accent/20" : "hover:bg-panel"}`}
                      data-testid={`joint-${id}`}
                      data-selected={joint === id ? "true" : "false"}
                      onClick={() => overlay().selectJoint(sel.characterId, id)}
                    >
                      {HUMANOID_RIG.find((j) => j.id === id)?.label}
                    </button>
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-[11px] text-muted">
                Joint limits are editor safety constraints (elbows and knees fold one way, the head cannot
                spin around); they are not anatomical accuracy.
              </p>
            </div>
          ) : null}

          <p className="mt-2 text-xs" data-testid="blocking-summary">
            {summarizeBlocking(entryOfSel, names.get(sel.characterId) ?? sel.label)}
          </p>
          <button
            className="btn mt-1.5 w-full"
            onClick={() => overlay().remove(sel.characterId)}
            data-testid="blocking-remove"
          >
            Remove from this shot
          </button>
        </div>
      ) : null}

      <button
        className="btn btn-primary mt-2 w-full"
        disabled={!props.ready || !loaded || !dirty || status.tone === "busy"}
        onClick={() => void doSave()}
        data-testid="save-blocking"
      >
        Save character blocking
      </button>
      <div
        role="status"
        aria-live="polite"
        data-testid="blocking-status"
        data-tone={status.tone}
        className={`mt-1 text-xs ${status.tone === "error" ? "text-fail" : status.tone === "ok" ? "text-pass" : "text-muted"}`}
      >
        {status.text}
      </div>
      <div className="mt-0.5 text-[11px] text-muted">
        saved layer <span data-testid="blocking-saved-fp">{short(savedFingerprint)}</span>
      </div>
    </section>
  );
}

function JointFields(props: {
  joint: PoseJointId;
  figure: BlockingFigureView;
  onChange: (q: { x: number; y: number; z: number; w: number }) => void;
}) {
  const q = props.figure.pose.joints[props.joint] ?? { x: 0, y: 0, z: 0, w: 1 };
  const e = quatToEuler(q);
  const deg = { x: e.x / DEG, y: e.y / DEG, z: e.z / DEG };
  const lim = jointDef(props.joint).limits;
  return (
    <div className="grid grid-cols-3 gap-1" data-testid="joint-fields">
      {(["x", "y", "z"] as const).map((axis) => {
        const [lo, hi] = lim[axis];
        return (
          <label key={axis} className="text-[11px] text-muted">
            {axis.toUpperCase()}°
            <input
              type="number"
              step="5"
              min={lo}
              max={hi}
              disabled={lo === hi}
              className="mt-0.5 w-full"
              data-testid={`joint-rot-${axis}`}
              defaultValue={r3(deg[axis])}
              onBlur={(ev) => {
                const n = Number(ev.target.value);
                if (!Number.isFinite(n) || Math.abs(n - deg[axis]) < 0.05) return;
                const next = { ...deg, [axis]: n };
                // the stored rotation is the quaternion; Euler is just how it is typed here
                props.onChange(quatFromEuler(next.x * DEG, next.y * DEG, next.z * DEG));
              }}
              onKeyDown={(ev) => ev.key === "Enter" && (ev.target as HTMLInputElement).blur()}
            />
          </label>
        );
      })}
    </div>
  );
}
