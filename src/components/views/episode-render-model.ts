import { formatDuration } from "@/domain/duration";
import { editRateLabel } from "@/domain/edit/edit-rate";
import type { EpisodeEdit } from "@/domain/edit/model";
import { buildRenderManifest } from "@/domain/edit/render-manifest";
import type { ProjectData } from "@/domain/schemas";
import { buildRenderPlan, missingMedia, missingMediaMessage } from "@/render/plan";
import { canvasLabel, deliveryProfile } from "@/render/profile";
import {
  ACTIVE_RENDER_STATUSES,
  RENDER_STATUS_LABEL,
  type EpisodeRender,
  type RenderStatus,
} from "@/render/repository";

/**
 * Phase 5B-V4 display model of "Render Episode" on the Episode Edit page: what a render of the CURRENT saved revision
 * would be (before), and every render of this Episode (after), newest last. Pure; nothing here renders or writes.
 */

export interface RenderRowVM {
  id: string;
  number: number;
  status: RenderStatus;
  statusLabel: string;
  active: boolean;
  progress: string;
  editRevision: number;
  savedRevisionNumber: number | null;
  /** the Edit moved on since this render was requested: a historical finished render, not a broken one */
  newerRevisionExists: boolean;
  error: string | null;
  output: {
    assetId: string;
    url: string;
    downloadUrl: string;
    filename: string;
    duration: string;
    durationMs: number;
    resolution: string;
    frameRate: string;
    size: string;
    checksum: string;
    codecs: string;
    profile: string;
    manifestFingerprint: string;
    segments: string;
  } | null;
}

export interface RenderPanelVM {
  editRevision: number;
  /** the saved revision the current state equals (null = unsaved changes: render refused until saved) */
  savedAs: number | null;
  duration: string;
  durationMs: number;
  visualSegments: number;
  renderSegments: number;
  missing: string[];
  missingMessage: string | null;
  target: string;
  format: string;
  cost: string;
  canRender: boolean;
  blockedReason: string | null;
  anyActive: boolean;
  renders: RenderRowVM[];
}

const mb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 2 : 1)} MB`;

export function renderPanelOf(
  data: ProjectData,
  edit: EpisodeEdit,
  savedAs: number | null,
  renders: readonly EpisodeRender[],
): RenderPanelVM {
  const manifest = buildRenderManifest(data, edit);
  const profile = deliveryProfile(manifest.target);
  const missing = missingMedia(manifest);
  const plan = missing.length ? null : buildRenderPlan(manifest, profile);
  const rows = renders.map<RenderRowVM>((r) => {
    const active = (ACTIVE_RENDER_STATUSES as readonly string[]).includes(r.status);
    const o = r.output;
    return {
      id: r.id,
      number: r.number,
      status: r.status,
      statusLabel: RENDER_STATUS_LABEL[r.status],
      active,
      progress:
        r.status === "rendering_segments" || r.status === "queued"
          ? `${r.segmentsDone}/${r.segmentsTotal} segments`
          : r.status === "completed"
            ? `${r.segmentsTotal}/${r.segmentsTotal} segments`
            : "",
      editRevision: r.editRevision,
      savedRevisionNumber: r.savedRevisionNumber,
      newerRevisionExists: edit.revision > r.editRevision,
      error: r.status === "failed" ? (r.errorMessage ?? "The render failed.") : null,
      output: o
        ? {
            assetId: o.assetId,
            url: `/api/assets/${o.assetId}`,
            downloadUrl: `/api/assets/${o.assetId}?download=1`,
            filename: o.filename,
            duration: formatDuration(o.durationMs),
            durationMs: o.durationMs,
            resolution: `${o.width}×${o.height}`,
            frameRate: o.frameRate,
            size: mb(o.byteSize),
            checksum: o.checksum,
            codecs: [o.videoCodec.toUpperCase(), o.audioCodec?.toUpperCase()].filter(Boolean).join(" + "),
            profile: r.profile.id,
            manifestFingerprint: r.manifestFingerprint,
            segments: `${o.segmentsRendered} rendered, ${o.segmentsReused} reused`,
          }
        : null,
    };
  });
  const anyActive = rows.some((r) => r.active);
  const blockedReason = missing.length
    ? missingMediaMessage(missing)
    : savedAs == null
      ? "Save this Edit revision before rendering it."
      : null;
  return {
    editRevision: edit.revision,
    savedAs,
    duration: formatDuration(manifest.totalMs),
    durationMs: manifest.totalMs,
    visualSegments: manifest.segments.filter((s) => s.kind === "shot").length,
    renderSegments: plan?.pieces.length ?? 0,
    missing: missing.map((m) => m.shotCode ?? m.itemId.slice(0, 8)),
    missingMessage: missing.length ? missingMediaMessage(missing) : null,
    target: `${canvasLabel(profile)} · ${editRateLabel(profile.fps)} · ${manifest.target.aspectRatio ?? "16:9"}`,
    format: "MP4 · H.264 yuv420p · AAC 48 kHz stereo (when the Episode has sound)",
    cost: "$0.00 — rendered by Prism's render worker; no provider call",
    canRender: blockedReason == null,
    blockedReason,
    anyActive,
    renders: rows,
  };
}
