"use client";

import { useRef, useState } from "react";
import {
  manualCalibration,
  MAX_SPLAT_BYTES,
  SPLAT_FORMAT_INFO,
  UNKNOWN_CALIBRATION,
  type SplatCalibration,
  type SplatFormat,
} from "@/domain/previs/splat";
import { inspectSplat } from "@/lib/splat/inspect";
import type { SceneObjectView, SpatialSceneAdapter } from "@/lib/previs/scene-adapter";
import { importGaussianSplat } from "@/server/reconstruction-actions";

/** One imported Gaussian splat (a reconstruction record + its private result Asset), as the page shows it. */
export interface SplatEnvironmentInfo {
  assetId: string;
  reconstructionId: string;
  name: string;
  format: SplatFormat;
  byteSize: number | null;
  gaussianCount: number | null;
  checksum: string | null;
  method: string;
  sources: Array<{ assetId: string; name: string; checksum: string | null }>;
  createdAt: string;
}

export interface ReferenceImageOption {
  id: string;
  name: string;
}

const mb = (n: number | null) =>
  n === null ? "—" : `${(n / 1024 / 1024).toFixed(n < 1024 * 1024 ? 2 : 1)} MB`;

/** Add side: import a splat file or place an already-imported one. */
export function SplatAddPanel(props: {
  projectSlug: string;
  locationId: string;
  ready: boolean;
  adapter: () => SpatialSceneAdapter;
  objects: SceneObjectView[];
  environments: SplatEnvironmentInfo[];
  referenceImages: ReferenceImageOption[];
  /** register a newly imported splat so the scene loader can resolve its Asset */
  onImported: (info: SplatEnvironmentInfo) => void;
  onStatus: (tone: "ok" | "error" | "busy", text: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [sources, setSources] = useState<string[]>([]);
  const [existing, setExisting] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const placed = props.objects.find((o) => o.kind === "splat") ?? null;
  const placedAssets = new Set(props.objects.filter((o) => o.kind === "splat").map((o) => o.assetId));
  const available = props.environments.filter((e) => !placedAssets.has(e.assetId));

  const place = async (info: SplatEnvironmentInfo, label: string) => {
    props.onStatus("busy", `Loading ${label}…`);
    try {
      await props.adapter().addSplat({
        assetId: info.assetId,
        name: info.name,
        checksum: info.checksum,
        reconstructionId: info.reconstructionId,
        calibration: { ...UNKNOWN_CALIBRATION },
      });
      props.onStatus("ok", `${label} added — unsaved until you save the 3D set`);
    } catch (e) {
      props.onStatus("error", e instanceof Error ? e.message : "The splat could not be added.");
    }
  };

  const doImport = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) return props.onStatus("error", "Choose a .splat, .spz or Gaussian .ply file.");
    if (placed)
      return props.onStatus("error", "This 3D set already has a splat environment. Remove it first.");
    if (file.size > MAX_SPLAT_BYTES)
      return props.onStatus(
        "error",
        `This file is larger than the ${MAX_SPLAT_BYTES / 1024 / 1024} MB splat limit.`,
      );
    setBusy(true);
    props.onStatus("busy", "Validating splat…");
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const checked = inspectSplat(bytes, file.name); // quick feedback; the server re-inspects as the authority
      if (!checked.ok) return props.onStatus("error", checked.error);
      props.onStatus("busy", "Uploading privately…");
      const fd = new FormData();
      fd.set("projectSlug", props.projectSlug);
      fd.set("locationId", props.locationId);
      fd.set("sourceAssetIds", JSON.stringify(sources));
      fd.set("file", file);
      const r = await importGaussianSplat(fd);
      if (!r.ok) return props.onStatus("error", r.error);
      const info: SplatEnvironmentInfo = {
        assetId: r.splat.assetId,
        reconstructionId: r.splat.reconstructionId,
        name: r.splat.name,
        format: checked.format,
        byteSize: r.splat.byteSize,
        gaussianCount: r.splat.gaussianCount,
        checksum: r.splat.checksum,
        method: "imported",
        sources: r.splat.sourceAssetIds.map((id) => ({
          assetId: id,
          name: props.referenceImages.find((x) => x.id === id)?.name ?? id,
          checksum: null,
        })),
        createdAt: new Date().toISOString(),
      };
      props.onImported(info);
      if (fileRef.current) fileRef.current.value = "";
      setSources([]);
      await place(info, "Splat");
    } catch (e) {
      props.onStatus("error", e instanceof Error ? e.message : "The splat could not be imported.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-3 rounded border border-line p-2 text-xs" data-testid="splat-add">
      <h2 className="mb-1 uppercase tracking-wide text-muted">Spatial environment</h2>
      <p className="mb-1.5 text-muted">
        Import a Gaussian splat (.splat, .spz, Gaussian .ply, up to {MAX_SPLAT_BYTES / 1024 / 1024} MB). It
        belongs to this location, not to a shot.
      </p>
      <input
        ref={fileRef}
        type="file"
        accept=".splat,.spz,.ply"
        className="mb-1.5 w-full"
        data-testid="import-splat-file"
        disabled={!props.ready || busy}
      />
      {props.referenceImages.length > 0 ? (
        <fieldset className="mb-1.5">
          <legend className="text-muted">Reconstructed from (optional)</legend>
          {props.referenceImages.map((img) => (
            <label key={img.id} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                data-testid="splat-source-image"
                checked={sources.includes(img.id)}
                onChange={(e) =>
                  setSources((s) => (e.target.checked ? [...s, img.id] : s.filter((x) => x !== img.id)))
                }
              />
              <span className="truncate">{img.name}</span>
            </label>
          ))}
        </fieldset>
      ) : null}
      <button
        className="btn w-full"
        disabled={!props.ready || busy}
        data-testid="import-splat"
        onClick={() => void doImport()}
      >
        {busy ? "Importing…" : "Import Gaussian splat"}
      </button>
      {available.length > 0 && !placed ? (
        <div className="mt-2">
          <label className="block text-muted">
            Already imported
            <select
              className="mt-1 w-full"
              value={existing || available[0]?.assetId}
              onChange={(e) => setExisting(e.target.value)}
              data-testid="existing-splat"
            >
              {available.map((e) => (
                <option key={e.reconstructionId} value={e.assetId}>
                  {e.name}
                </option>
              ))}
            </select>
          </label>
          <button
            className="btn mt-1.5 w-full"
            disabled={!props.ready || busy}
            data-testid="add-existing-splat"
            onClick={() => {
              const info = available.find((e) => e.assetId === (existing || available[0]?.assetId));
              if (info) void place(info, info.name);
            }}
          >
            Add to this set
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Inspector side: what the selected splat IS, its scale truth and the controls that are specific to it. */
export function SplatInspector(props: {
  adapter: () => SpatialSceneAdapter;
  object: SceneObjectView;
  environment: SplatEnvironmentInfo | null;
}) {
  const { object, environment } = props;
  const cal: SplatCalibration = object.calibration ?? { ...UNKNOWN_CALIBRATION };
  const [metres, setMetres] = useState<string>(
    cal.metresPerSourceUnit === null ? "" : String(cal.metresPerSourceUnit),
  );
  const [error, setError] = useState<string | null>(null);
  const stats =
    props
      .adapter()
      .splatStats()
      .find((s) => s.assetId === object.assetId) ?? null;

  const applyScale = () => {
    const m = Number(metres);
    if (!Number.isFinite(m) || m <= 0) return setError("Enter a positive number of metres per source unit.");
    setError(null);
    // 1 source unit == m metres: the Set is in metres, so the object's uniform scale IS that factor
    props.adapter().updateTransform(object.id, { scale: { x: m, y: m, z: m } });
    props.adapter().setSplatCalibration(object.id, {
      ...manualCalibration(m),
      groundOffsetMetres: cal.groundOffsetMetres,
    });
  };

  return (
    <div className="mb-3 rounded border border-line p-2 text-xs" data-testid="splat-inspector">
      <div className="mb-1 font-medium" data-testid="splat-kind">
        Gaussian Splat
      </div>
      <dl className="mb-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
        <dt className="text-muted">Asset</dt>
        <dd className="truncate" data-testid="splat-asset-name">
          {environment?.name ?? object.name}
        </dd>
        <dt className="text-muted">Format</dt>
        <dd data-testid="splat-format">{environment ? SPLAT_FORMAT_INFO[environment.format].label : "—"}</dd>
        <dt className="text-muted">Size</dt>
        <dd data-testid="splat-size">{mb(environment?.byteSize ?? null)}</dd>
        <dt className="text-muted">Gaussians</dt>
        <dd data-testid="splat-gaussians">{environment?.gaussianCount?.toLocaleString() ?? "—"}</dd>
        <dt className="text-muted">Reconstruction</dt>
        <dd data-testid="splat-provenance">
          {environment ? environment.method : "—"} · {environment?.sources.length ?? 0} source image
          {environment?.sources.length === 1 ? "" : "s"}
        </dd>
        <dt className="text-muted">Scale</dt>
        <dd data-testid="splat-scale-status" data-scale-method={cal.scaleMethod}>
          {cal.scaleMethod === "manual"
            ? `manual — 1 source unit = ${cal.metresPerSourceUnit} m`
            : "unknown units (not metric)"}
        </dd>
        <dt className="text-muted">Visible</dt>
        <dd data-testid="splat-visible">{object.visible ? "yes" : "hidden"}</dd>
        <dt className="text-muted">Locked</dt>
        <dd data-testid="splat-locked">{object.locked ? "locked" : "unlocked"}</dd>
        {stats ? (
          <>
            <dt className="text-muted">Loaded</dt>
            <dd data-testid="splat-load-stats">
              {stats.loadMs} ms · ~{mb(stats.estimatedGpuBytes)} GPU (estimate)
            </dd>
          </>
        ) : null}
      </dl>

      <label className="block text-muted">
        Metres per source unit
        <input
          className="mt-1 w-full"
          inputMode="decimal"
          value={metres}
          placeholder="e.g. 0.5"
          data-testid="splat-metres-per-unit"
          onChange={(e) => setMetres(e.target.value)}
          disabled={object.locked}
        />
      </label>
      <div className="mt-1.5 flex gap-1.5">
        <button
          className="btn flex-1"
          disabled={object.locked}
          data-testid="splat-apply-scale"
          onClick={applyScale}
        >
          Apply scale
        </button>
        <button
          className="btn flex-1"
          disabled={object.locked}
          data-testid="splat-reset-scale"
          onClick={() => {
            setMetres("");
            setError(null);
            props.adapter().setSplatCalibration(object.id, {
              ...UNKNOWN_CALIBRATION,
              groundOffsetMetres: cal.groundOffsetMetres,
            });
          }}
        >
          Scale unknown
        </button>
      </div>
      {error ? (
        <p role="alert" className="mt-1 text-fail" data-testid="splat-scale-error">
          {error}
        </p>
      ) : null}

      <div className="mt-2 grid grid-cols-2 gap-1.5">
        <button
          className="btn"
          data-testid="splat-visibility"
          onClick={() => props.adapter().setObjectVisible(object.id, !object.visible)}
        >
          {object.visible ? "Hide" : "Show"}
        </button>
        <button
          className="btn"
          data-testid="splat-lock"
          onClick={() => props.adapter().setObjectLocked(object.id, !object.locked)}
        >
          {object.locked ? "Unlock" : "Lock environment"}
        </button>
        <button
          className="btn"
          disabled={object.locked}
          data-testid="splat-ground"
          onClick={() => props.adapter().alignSplatToGround(object.id)}
        >
          Set as ground level
        </button>
        <button
          className="btn"
          disabled={object.locked}
          data-testid="splat-flip"
          title="Many reconstructions are upside-down (y-down). Rotates the environment 180° about X."
          onClick={() =>
            props.adapter().updateTransform(object.id, {
              rotation: { x: object.rotation.x + Math.PI, y: object.rotation.y, z: object.rotation.z },
            })
          }
        >
          Flip 180° (X)
        </button>
      </div>
      <p className="mt-1.5 text-muted">
        Scale is never assumed. Until you set it, this environment has no real-world size.
      </p>
    </div>
  );
}
