import { canonicalJson, fingerprint } from "@/domain/hash";
import type { ProjectData } from "@/domain/schemas";
import type { EditRate } from "./edit-rate";
import type { EpisodeEdit, TitlePlacement, TitleStyle, VisualKind } from "./model";
import { editStateFingerprint } from "./revision";
import { editTimeline } from "./timeline";

/**
 * Phase 5B-V3 render manifest: a DETERMINISTIC description of exactly one edit state, for the V4 segmented renderer.
 * Built from THE canonical timeline (timeline.ts), the same one the preview plays, so the two cannot disagree about
 * order, positions or the total. It names immutable media by Asset id + checksum and says how to cut it; it never
 * contains a URL, a timestamp, or anything that changes without the edit changing. V3 renders nothing.
 *
 *   segments   in timeline order: title cards and Shot items, each with its timeline start, output duration, source
 *              in/out (clips) and the transition into the next segment
 *   audio      what the edit already places: each clip's own audio policy and the pinned performance takes
 *              (an Episode music bed is deferred to V3b; `bed` is always null in this version)
 */

export const RENDER_MANIFEST_VERSION = "prism.render-manifest/1";

export interface ManifestMedia {
  kind: VisualKind;
  /** the immutable Asset to read (null for `none`, or when the pinned row is missing: reported, never guessed) */
  assetId: string | null;
  checksum: string | null;
  mimeType: string | null;
  /** the pinned row the Asset came from */
  attemptId?: string;
  productionFrameId?: string;
  storyboardFrameId?: string;
}

export type ManifestTransition = { kind: "cut" } | { kind: "dissolve"; durationMs: number };

export interface ManifestTitleSegment {
  order: number;
  kind: "title";
  titleId: string;
  placement: TitlePlacement;
  text: { title: string; subtitle: string };
  layout: { style: TitleStyle; align: "center"; background: "black" };
  startMs: number;
  durationMs: number;
  transitionToNext: ManifestTransition;
}

export interface ManifestShotSegment {
  order: number;
  kind: "shot";
  itemId: string;
  shotId: string;
  shotCode: string | null;
  media: ManifestMedia;
  /** video: the exact source interval; stills: null (a still is held for `durationMs`) */
  sourceInMs: number | null;
  sourceOutMs: number | null;
  startMs: number;
  durationMs: number;
  transitionToNext: ManifestTransition;
  clipAudio: "muted" | "included";
}

export type ManifestSegment = ManifestTitleSegment | ManifestShotSegment;

export interface RenderManifest {
  version: typeof RENDER_MANIFEST_VERSION;
  edit: {
    id: string;
    projectId: string;
    episodeId: string;
    /** the working revision counter the manifest was built from */
    revision: number;
    /** `editStateFingerprint`: the same as a saved revision of this exact state */
    stateFingerprint: string;
  };
  target: {
    editRate: EditRate;
    aspectRatio: string | null;
    width: number | null;
    height: number | null;
  };
  totalMs: number;
  totalFrames: number;
  segments: ManifestSegment[];
  audio: {
    clipAudio: Array<{ itemId: string; assetId: string | null; startMs: number; durationMs: number }>;
    performance: Array<{
      itemId: string;
      dialogueLineId: string;
      takeId: string;
      assetId: string | null;
      startMs: number;
      takeInMs: number;
      takeOutMs: number;
    }>;
    /** V3b (deferred): an Episode-level music bed */
    bed: null;
  };
}

const CUT: ManifestTransition = { kind: "cut" };

export function buildRenderManifest(data: ProjectData, edit: EpisodeEdit): RenderManifest {
  const timeline = editTimeline(edit);
  // only an Asset with stored bytes can be rendered: a placeholder row (no object) is reported as no media (5B-V4)
  const asset = (id: string | null | undefined) =>
    id ? data.assets.find((a) => a.id === id && a.objectPath) : undefined;
  const media = (item: EpisodeEdit["items"][number]): ManifestMedia => {
    const v = item.visual;
    switch (v.kind) {
      case "video": {
        const a = asset(v.assetId);
        return {
          kind: "video",
          assetId: a ? v.assetId : null,
          checksum: a?.checksum ?? null,
          mimeType: a?.mime ?? null,
          attemptId: v.attemptId,
        };
      }
      case "production_frame": {
        const f = (data.productionFrames ?? []).find((x) => x.id === v.productionFrameId);
        const a = asset(f?.assetId);
        return {
          kind: "production_frame",
          assetId: a?.id ?? null,
          checksum: a?.checksum ?? null,
          mimeType: a?.mime ?? null,
          productionFrameId: v.productionFrameId,
        };
      }
      case "storyboard_frame": {
        const f = data.frames.find((x) => x.id === v.storyboardFrameId);
        const a = asset(f?.assetId);
        return {
          kind: "storyboard_frame",
          assetId: a?.id ?? null,
          checksum: a?.checksum ?? null,
          mimeType: a?.mime ?? null,
          storyboardFrameId: v.storyboardFrameId,
        };
      }
      default:
        return { kind: "none", assetId: null, checksum: null, mimeType: null };
    }
  };

  const segments: ManifestSegment[] = timeline.segments.map((seg, order) => {
    const next = timeline.segments[order + 1];
    const transitionToNext: ManifestTransition =
      seg.kind === "item" && next?.kind === "item" && next.transitionInMs > 0
        ? { kind: "dissolve", durationMs: next.transitionInMs }
        : CUT;
    if (seg.kind === "title")
      return {
        order,
        kind: "title",
        titleId: seg.title.id,
        placement: seg.placement,
        text: { title: seg.title.title, subtitle: seg.title.subtitle },
        layout: { style: seg.title.style, align: "center", background: "black" },
        startMs: seg.startMs,
        durationMs: seg.durationMs,
        transitionToNext,
      };
    const v = seg.item.visual;
    return {
      order,
      kind: "shot",
      itemId: seg.item.id,
      shotId: seg.item.shotId,
      shotCode: data.shots.find((s) => s.id === seg.item.shotId)?.shotCode ?? null,
      media: media(seg.item),
      sourceInMs: v.kind === "video" ? v.sourceInMs : null,
      sourceOutMs: v.kind === "video" ? v.sourceOutMs : null,
      startMs: seg.startMs,
      durationMs: seg.durationMs,
      transitionToNext,
      clipAudio: v.kind === "video" && seg.item.sourceAudio === "included" ? "included" : "muted",
    };
  });

  const bible = data.bible;
  return {
    version: RENDER_MANIFEST_VERSION,
    edit: {
      id: edit.id,
      projectId: edit.projectId,
      episodeId: edit.episodeId,
      revision: edit.revision,
      stateFingerprint: editStateFingerprint(edit),
    },
    target: {
      editRate: { num: edit.editRate.num, den: edit.editRate.den },
      aspectRatio: bible?.aspectRatio || null,
      width: bible?.deliveryWidth ?? null,
      height: bible?.deliveryHeight ?? null,
    },
    totalMs: timeline.totalMs,
    totalFrames: timeline.totalFrames,
    segments,
    audio: {
      clipAudio: timeline.items
        .filter((t) => t.item.visual.kind === "video" && t.item.sourceAudio === "included")
        .map((t) => ({
          itemId: t.item.id,
          assetId: t.item.visual.kind === "video" ? (asset(t.item.visual.assetId)?.id ?? null) : null,
          startMs: t.startMs,
          durationMs: t.durationMs,
        })),
      performance: timeline.items.flatMap((t) =>
        t.item.performance.map((p) => ({
          itemId: t.item.id,
          dialogueLineId: p.dialogueLineId,
          takeId: p.takeId,
          // a take without a stored audio file (timed text, a placeholder) sounds as silence
          assetId: asset(data.takes.find((x) => x.id === p.takeId)?.audioAssetId)?.id ?? null,
          startMs: t.startMs + p.startMs,
          takeInMs: p.takeInMs,
          takeOutMs: p.takeOutMs,
        })),
      ),
      bed: null,
    },
  };
}

/** The manifest as stable text (sorted keys) and its fingerprint: identical edit state + media = identical bytes. */
export const manifestJson = (m: RenderManifest): string => canonicalJson(m);
export const manifestFingerprint = (m: RenderManifest): string => fingerprint(m);
