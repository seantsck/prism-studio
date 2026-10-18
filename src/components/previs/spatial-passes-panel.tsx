"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SpatialPassBundleRecord } from "@/data/previs-repository";
import {
  SPATIAL_STALE_LABEL,
  bookmarkCameraFingerprint,
  cameraSourceFromBookmark,
  cameraSourceFromPath,
  decodeDepthF32,
  decodeMaskU8,
  decodeObjectIdsU32,
  depthPreviewRgba,
  maskPreviewRgba,
  objectIdPreviewRgba,
  pickCurrentBundle,
  spatialPassStaleReasons,
  type ControlCameraSource,
  type SpatialCurrentState,
} from "@/domain/previs/spatial-passes";
import type { CameraBookmarkValue } from "@/domain/previs/types";
import { renderSpatialCapture, spatialCaptureForm, type CapturedPasses } from "@/lib/previs/spatial-capture";
import type { SpatialSceneAdapter } from "@/lib/previs/scene-adapter";
import { captureSpatialPassBundle, loadSpatialPassBundles } from "@/server/spatial-pass-actions";
import type { BlockingState } from "./character-blocking-panel";
import type { CameraMotionState } from "./camera-motion-panel";

/**
 * Spatial Control Passes (Phase 2F M2C): depth + object IDs + exact Character masks rendered from the Shot's
 * production camera (a saved camera path at the timeline playhead, else the Production Camera bookmark), from SAVED
 * state only. Machine data first; the previews below are generated straight from the canonical bytes and are
 * display-only. Nothing here talks to a generation provider.
 */

type Status = { tone: "idle" | "ok" | "error" | "busy"; text: string };
const short = (fp: string | null) => (fp ? fp.slice(0, 10) : "—");
const seconds = (ms: number) => (ms / 1000).toFixed(3);

export interface SpatialPassesPanelProps {
  adapter: () => SpatialSceneAdapter;
  ready: boolean;
  projectSlug: string;
  locationId: string;
  shotId: string;
  characters: Array<{ id: string; name: string }>;
  /** the stored bundles when this is the page's own Shot; null = fetch them */
  initialBundles: SpatialPassBundleRecord[] | null;
  /** the SAVED set (null = nothing saved yet) and whether the live set differs from it */
  scene: { documentId: string | null; revision: number | null; fingerprint: string | null; dirty: boolean };
  bookmark: { id: string; sceneFingerprint: string; value: CameraBookmarkValue } | null;
  motion: CameraMotionState | null;
  blocking: BlockingState | null;
}

function sourceLabel(s: ControlCameraSource): string {
  return s.kind === "camera_path" ? `Camera Path · ${seconds(s.timeMs)} s` : "Production Camera Bookmark";
}

function Raster(props: {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  testId: string;
  label: string;
  characterId?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    c.width = props.width;
    c.height = props.height;
    c.getContext("2d")?.putImageData(
      new ImageData(props.rgba as Uint8ClampedArray<ArrayBuffer>, props.width, props.height),
      0,
      0,
    );
  }, [props.rgba, props.width, props.height]);
  return (
    <figure className="m-0">
      <canvas
        ref={ref}
        data-testid={props.testId}
        data-character-id={props.characterId}
        className="w-full rounded border border-line"
        style={{ aspectRatio: `${props.width} / ${props.height}`, imageRendering: "pixelated" }}
      />
      <figcaption className="text-[10px] text-muted">{props.label}</figcaption>
    </figure>
  );
}

interface Previews {
  width: number;
  height: number;
  depth: Uint8ClampedArray;
  ids: Uint8ClampedArray;
  masks: Array<{ characterId: string; rgba: Uint8ClampedArray }>;
}

function previewsFromCapture(c: CapturedPasses): Previews {
  return {
    width: c.width,
    height: c.height,
    depth: depthPreviewRgba(c.depth),
    ids: objectIdPreviewRgba(c.ids),
    masks: c.masks.map((m) => ({ characterId: m.characterId, rgba: maskPreviewRgba(m.mask) })),
  };
}

async function fetchBytes(assetId: string): Promise<Uint8Array> {
  const res = await fetch(`/api/assets/${assetId}`, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`Could not read the stored pass (${res.status}).`);
  return new Uint8Array(await res.arrayBuffer());
}

async function previewsFromStore(b: SpatialPassBundleRecord): Promise<Previews> {
  const { width, height } = b;
  const depth = decodeDepthF32(await fetchBytes(b.depth.assetId), width, height);
  const ids = decodeObjectIdsU32(await fetchBytes(b.objectIds.assetId), width, height);
  const masks = [];
  for (const [characterId, m] of Object.entries(b.characterMasks.masks))
    masks.push({
      characterId,
      rgba: maskPreviewRgba(decodeMaskU8(await fetchBytes(m.assetId), width, height)),
    });
  return { width, height, depth: depthPreviewRgba(depth), ids: objectIdPreviewRgba(ids), masks };
}

export function SpatialPassesPanel(props: SpatialPassesPanelProps) {
  const [bundles, setBundles] = useState<SpatialPassBundleRecord[]>(props.initialBundles ?? []);
  const [loaded, setLoaded] = useState(props.initialBundles !== null);
  const [status, setStatus] = useState<Status>({ tone: "idle", text: "" });
  const [busy, setBusy] = useState(false);
  const [previews, setPreviews] = useState<Record<string, Previews>>({});
  const names = useMemo(() => new Map(props.characters.map((c) => [c.id, c.name])), [props.characters]);

  useEffect(() => {
    if (props.initialBundles !== null) return;
    let cancelled = false;
    const fd = new FormData();
    fd.set("projectSlug", props.projectSlug);
    fd.set("shotId", props.shotId);
    void loadSpatialPassBundles(fd).then((r) => {
      if (cancelled) return;
      if (r.ok) setBundles(r.bundles);
      else setStatus({ tone: "error", text: r.error });
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
    // the Shot is the identity of this panel (the parent keys it)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── what a capture right now would be taken from ──
  const savedPath = props.motion?.saved ?? null;
  const reasons: string[] = [];
  if (!props.ready) reasons.push("The 3D set is still loading.");
  if (props.scene.dirty || !props.scene.fingerprint) reasons.push("Save the 3D set first.");
  if (!props.blocking) reasons.push("Character blocking is still loading.");
  else {
    if (props.blocking.dirty) reasons.push("Save the character blocking first.");
    if (props.blocking.stale) reasons.push("Re-anchor the character blocking to the current set first.");
  }
  let source: ControlCameraSource | null = null;
  let sourceError: string | null = null;
  if (savedPath) {
    if (props.motion?.dirty) reasons.push("Save the camera path first.");
    if (props.motion?.playing) reasons.push("Pause playback to capture at the playhead.");
    if (props.scene.fingerprint && savedPath.sceneFingerprint !== props.scene.fingerprint)
      reasons.push("The camera path was saved against an older set. Re-save it first.");
    try {
      source = cameraSourceFromPath(
        savedPath.path,
        { id: savedPath.id, revision: savedPath.revision, pathFingerprint: savedPath.pathFingerprint },
        props.motion?.timeMs ?? 0,
      );
    } catch (e) {
      sourceError = e instanceof Error ? e.message : "The camera path cannot be evaluated.";
    }
  } else if (props.bookmark) {
    if (props.scene.fingerprint && props.bookmark.sceneFingerprint !== props.scene.fingerprint)
      reasons.push("The Production Camera was linked against an older set. Link it again first.");
    try {
      source = cameraSourceFromBookmark({ id: props.bookmark.id }, props.bookmark.value);
    } catch (e) {
      sourceError = e instanceof Error ? e.message : "The Production Camera cannot be used.";
    }
  } else {
    reasons.push("Link the Production Camera to this shot (or save a camera path) first.");
  }
  if (sourceError) reasons.push(sourceError);
  const canCapture = reasons.length === 0 && !busy && !!source;

  // ── freshness: judged against SAVED state; audio never matters ──
  const current: SpatialCurrentState | null = props.blocking
    ? {
        sceneFingerprint: props.scene.fingerprint,
        blockingFingerprint: props.blocking.savedFingerprint,
        pathFingerprint: savedPath?.pathFingerprint ?? null,
        bookmarkCameraFingerprint: props.bookmark ? bookmarkCameraFingerprint(props.bookmark.value) : null,
      }
    : null;
  const currentBundle = current ? pickCurrentBundle(bundles, current) : null;

  const capture = useCallback(async () => {
    if (!source || !props.scene.documentId || props.scene.revision === null || !props.scene.fingerprint)
      return;
    const blocking = props.blocking;
    if (!blocking) return;
    setBusy(true);
    setStatus({ tone: "busy", text: "Rendering control passes…" });
    try {
      // let the busy state paint before the (synchronous) GPU readback
      await new Promise((r) => setTimeout(r, 30));
      const cap = renderSpatialCapture({
        adapter: props.adapter(),
        shotId: props.shotId,
        scene: {
          documentId: props.scene.documentId,
          revision: props.scene.revision,
          fingerprint: props.scene.fingerprint,
        },
        blockingFingerprint: blocking.savedFingerprint,
        source,
        savedFigures: blocking.savedFigures.filter((f) => f.visible),
      });
      setStatus({ tone: "busy", text: "Saving control passes privately…" });
      const r = await captureSpatialPassBundle(
        spatialCaptureForm(cap, {
          projectSlug: props.projectSlug,
          shotId: props.shotId,
          locationId: props.locationId,
          source,
        }),
      );
      if (!r.ok) {
        setStatus({ tone: "error", text: r.error });
        return;
      }
      setPreviews((p) => ({ ...p, [r.bundle.id]: previewsFromCapture(cap) }));
      setBundles((list) => (list.some((b) => b.id === r.bundle.id) ? list : [r.bundle, ...list]));
      setStatus({
        tone: "ok",
        text: r.existing
          ? "These exact control passes were already captured."
          : `Control passes saved privately (${r.bundle.width}×${r.bundle.height})`,
      });
    } catch (e) {
      setStatus({
        tone: "error",
        text: e instanceof Error ? e.message : "Could not capture control passes.",
      });
    } finally {
      setBusy(false);
    }
  }, [source, props]);

  const showPreviews = async (b: SpatialPassBundleRecord) => {
    setStatus({ tone: "busy", text: "Reading stored passes…" });
    try {
      const p = await previewsFromStore(b);
      setPreviews((m) => ({ ...m, [b.id]: p }));
      setStatus({ tone: "idle", text: "" });
    } catch (e) {
      setStatus({
        tone: "error",
        text: e instanceof Error ? e.message : "Could not read the stored passes.",
      });
    }
  };

  return (
    <section data-testid="spatial-passes" data-loaded={loaded ? "true" : "false"} className="mt-4">
      <h2 className="mb-1 text-xs uppercase tracking-wide text-muted">Spatial control passes</h2>
      <p className="mb-2 text-xs text-muted">
        Depth, object IDs and exact Character masks for one frame of this shot&apos;s{" "}
        <strong>production camera</strong>, rendered from saved state. Machine data for later conditioning,
        compositing and QA; no provider is called.
      </p>
      <div className="mb-2 rounded border border-line p-2 text-xs" data-testid="spatial-source-info">
        <div>
          Source:{" "}
          <strong data-testid="spatial-source" data-kind={source?.kind ?? ""}>
            {source ? sourceLabel(source) : "—"}
          </strong>
        </div>
        <div>
          Frame: <strong data-testid="spatial-size">1912×800</strong> · row 0 = top · metres
        </div>
      </div>
      {reasons.length > 0 ? (
        <ul className="mb-2 list-disc pl-4 text-xs text-warn" data-testid="spatial-gate">
          {reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      ) : null}
      <button
        className="btn btn-primary w-full"
        disabled={!canCapture}
        onClick={() => void capture()}
        data-testid="capture-spatial-passes"
      >
        {busy ? "Capturing…" : "Capture Control Passes"}
      </button>
      {status.text ? (
        <p
          className={`mt-1 text-xs ${status.tone === "error" ? "text-fail" : status.tone === "ok" ? "text-pass" : "text-muted"}`}
          data-testid="spatial-status"
          role="status"
        >
          {status.text}
        </p>
      ) : null}

      <ul className="mt-2 space-y-2" data-testid="spatial-bundles">
        {bundles.map((b) => {
          const reasonsNow = current ? spatialPassStaleReasons(b, current) : [];
          const isCurrent = current ? reasonsNow.length === 0 : false;
          const p = previews[b.id];
          const characterIds = Object.keys(b.characterMasks.masks).sort();
          return (
            <li
              key={b.id}
              className="rounded border border-line p-1.5 text-xs"
              data-testid="spatial-bundle"
              data-bundle-id={b.id}
              data-fingerprint={b.bundleFingerprint}
              data-source={b.camera.kind}
              data-state={!current ? "unknown" : isCurrent ? "current" : "stale"}
              data-current-pick={currentBundle?.id === b.id ? "true" : "false"}
            >
              <div className="flex flex-wrap items-center justify-between gap-1">
                <strong data-testid="spatial-bundle-source">{sourceLabel(b.camera)}</strong>
                <span className="text-muted">{new Date(b.createdAt).toLocaleString()}</span>
              </div>
              <div className="text-muted" data-testid="spatial-bundle-meta">
                {b.width}×{b.height} · {b.objectIds.manifest.objects.length} object
                {b.objectIds.manifest.objects.length === 1 ? "" : "s"} · {characterIds.length} character
                {characterIds.length === 1 ? "" : "s"} · depth {b.depth.metadata.minDepth?.toFixed(2) ?? "—"}–
                {b.depth.metadata.maxDepth?.toFixed(2) ?? "—"} m · {short(b.bundleFingerprint)}
              </div>
              {current ? (
                isCurrent ? (
                  <div className="text-pass" data-testid="spatial-bundle-current">
                    Current
                  </div>
                ) : (
                  <div className="text-warn" data-testid="spatial-bundle-stale">
                    {reasonsNow.map((r) => SPATIAL_STALE_LABEL[r]).join(" · ")}
                  </div>
                )
              ) : null}
              {characterIds.length > 0 ? (
                <ul className="mt-0.5 text-muted" data-testid="spatial-bundle-masks">
                  {characterIds.map((id) => (
                    <li key={id} data-character-id={id}>
                      {names.get(id) ?? "Character"} mask · {b.characterMasks.masks[id].visiblePixelCount} px
                      ·{" "}
                      <a
                        className="underline"
                        href={`/api/assets/${b.characterMasks.masks[id].assetId}`}
                        data-testid="spatial-mask-asset"
                      >
                        mask
                      </a>
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="mt-1 flex flex-wrap gap-2">
                <a
                  className="underline"
                  href={`/api/assets/${b.depth.assetId}`}
                  data-testid="spatial-depth-asset"
                >
                  depth
                </a>
                <a
                  className="underline"
                  href={`/api/assets/${b.objectIds.assetId}`}
                  data-testid="spatial-ids-asset"
                >
                  object ids
                </a>
                {!p ? (
                  <button
                    className="underline"
                    onClick={() => void showPreviews(b)}
                    data-testid="spatial-show-previews"
                  >
                    Show previews
                  </button>
                ) : null}
              </div>
              {p ? (
                <div className="mt-1 grid gap-1" data-testid="spatial-previews">
                  <Raster
                    rgba={p.depth}
                    width={p.width}
                    height={p.height}
                    testId="spatial-depth-preview"
                    label="DEPTH (display only: near = dark, far = light)"
                  />
                  <Raster
                    rgba={p.ids}
                    width={p.width}
                    height={p.height}
                    testId="spatial-id-preview"
                    label="OBJECT IDs (false colour; indices are bundle-local)"
                  />
                  {p.masks.map((m) => (
                    <Raster
                      key={m.characterId}
                      rgba={m.rgba}
                      width={p.width}
                      height={p.height}
                      testId="spatial-mask-preview"
                      characterId={m.characterId}
                      label={`CHARACTER MASK · ${names.get(m.characterId) ?? "Character"}`}
                    />
                  ))}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
