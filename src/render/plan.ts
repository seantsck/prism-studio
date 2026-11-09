import { frameAtMs } from "@/domain/edit/edit-rate";
import type { ManifestMedia, ManifestShotSegment, RenderManifest } from "@/domain/edit/render-manifest";
import type { TitleStyle } from "@/domain/edit/model";
import { fingerprint } from "@/domain/hash";
import { AUDIO_SAMPLE_RATE, type RenderProfile } from "./profile";

/**
 * Phase 5B-V4 render PLAN: the V3 render manifest → a list of bounded, independently rendered PIECES, in timeline order.
 * Pure and deterministic. The renderer never reads the Episode Edit tables: the frozen manifest is its only input.
 *
 *   title       a title card                                          (no source media)
 *   body        the part of ONE item that no dissolve touches          (1 picture source)
 *   transition  a cross dissolve: the outgoing item's last d ms over   (2 picture sources)
 *               the incoming item's first d ms, linear
 *
 * Every timeline instant belongs to exactly one piece, so Σ pieces = the canonical timeline: an item of duration D with
 * dissolves d_in / d_out contributes a body of D − d_in − d_out, and each dissolve d is rendered once. Piece boundaries
 * are FRAMES of absolute timeline positions (`frameAtMs`, the V3 math), so the frame counts telescope to exactly the
 * manifest's `totalFrames` (no per-piece rounding accumulates). Audio boundaries are the samples of those frames.
 *
 * Bounded by construction: a piece opens at most 2 picture sources and `MAX_AUDIO_SOURCES_PER_PIECE` sound sources; the
 * assembly reads the normalized pieces sequentially (concat). No step ever opens the whole Episode at once.
 */

export const MAX_PICTURE_SOURCES_PER_PIECE = 2;
export const MAX_AUDIO_SOURCES_PER_PIECE = 16;

/** A picture source as the plan addresses it: an immutable Asset + checksum, and where in it this piece starts. */
export interface PictureSource {
  kind: "video" | "still";
  assetId: string;
  checksum: string;
  mime: string | null;
  /** video: the source position (ms) at the piece's first frame; still: 0 */
  sourceStartMs: number;
  itemId: string;
  shotCode: string | null;
}

/** One sound inside a piece: `durationMs` of `assetId` from `sourceStartMs`, starting `offsetMs` after the piece start. */
export interface AudioSource {
  kind: "clip" | "take";
  assetId: string;
  checksum: string | null;
  sourceStartMs: number;
  offsetMs: number;
  durationMs: number;
  itemId: string;
}

interface PieceBase {
  index: number;
  /** absolute timeline frames [startFrame, startFrame + frames) */
  startFrame: number;
  frames: number;
  /** the same interval in audio samples (exact, from the frame boundaries) */
  startSample: number;
  samples: number;
  audio: AudioSource[];
  /** deterministic identity of the rendered piece (profile + sources + parameters; never its timeline position) */
  cacheKey: string;
}

export interface TitlePiece extends PieceBase {
  kind: "title";
  titleId: string;
  placement: "opening" | "closing";
  title: string;
  subtitle: string;
  style: TitleStyle;
}
export interface BodyPiece extends PieceBase {
  kind: "body";
  itemId: string;
  shotCode: string | null;
  picture: PictureSource;
}
export interface TransitionPiece extends PieceBase {
  kind: "transition";
  from: PictureSource;
  to: PictureSource;
}
export type RenderPiece = TitlePiece | BodyPiece | TransitionPiece;

/** The fonts title pieces are rendered with (identity only: family + file checksum), part of a title's cache key. */
export interface TitleFonts {
  film: { family: string; checksum: string };
  plain: { family: string; checksum: string };
}

export interface RenderPlan {
  manifestFingerprint: string;
  stateFingerprint: string;
  profileId: string;
  totalFrames: number;
  totalSamples: number;
  /** the Episode has sound anywhere (else the final MP4 is video-only) */
  hasAudio: boolean;
  pieces: RenderPiece[];
  /** Σ dissolves (ms), for the review summary */
  dissolveMs: number;
}

export class RenderPlanError extends Error {
  constructor(
    readonly code: "missing_media" | "unbounded" | "empty",
    message: string,
    readonly shotCodes: string[] = [],
  ) {
    super(message);
    this.name = "RenderPlanError";
  }
}

/**
 * A FINAL render never silently omits a picture: every Shot segment must name an Asset with a checksum. Returns the
 * items that would be missing (Shot code or item id), empty = renderable.
 */
export function missingMedia(manifest: RenderManifest): Array<{ itemId: string; shotCode: string | null }> {
  return manifest.segments
    .filter((s): s is ManifestShotSegment => s.kind === "shot")
    .filter((s) => s.media.kind === "none" || !s.media.assetId || !s.media.checksum)
    .map((s) => ({ itemId: s.itemId, shotCode: s.shotCode }));
}

export const missingMediaMessage = (missing: ReturnType<typeof missingMedia>) =>
  `Episode contains ${missing.length} item${missing.length === 1 ? "" : "s"} with missing media: ${missing
    .map((m) => m.shotCode ?? m.itemId.slice(0, 8))
    .join(", ")}.`;

const picture = (seg: ManifestShotSegment, offsetMs: number): PictureSource => {
  const m = seg.media as ManifestMedia & { assetId: string; checksum: string };
  return {
    kind: m.kind === "video" ? "video" : "still",
    assetId: m.assetId,
    checksum: m.checksum,
    mime: m.mimeType,
    sourceStartMs: m.kind === "video" ? (seg.sourceInMs ?? 0) + offsetMs : 0,
    itemId: seg.itemId,
    shotCode: seg.shotCode,
  };
};

const sampleAtFrame = (frame: number, fps: RenderProfile["fps"]) =>
  Math.round((frame * AUDIO_SAMPLE_RATE * fps.den) / fps.num);

/** The exact timeline position (ms, fractional) of a frame boundary: what audio offsets inside a piece are measured from. */
const msAtFrameExact = (frame: number, fps: RenderProfile["fps"]) => (frame * 1000 * fps.den) / fps.num;

export function buildRenderPlan(
  manifest: RenderManifest,
  profile: RenderProfile,
  fonts: TitleFonts | null = null,
): RenderPlan {
  const missing = missingMedia(manifest);
  if (missing.length)
    throw new RenderPlanError(
      "missing_media",
      missingMediaMessage(missing),
      missing.map((m) => m.shotCode ?? m.itemId),
    );
  if (manifest.segments.length === 0)
    throw new RenderPlanError("empty", "The Episode edit has nothing to render.");
  const fps = profile.fps;

  // every sound the Episode places, on the absolute timeline (ms)
  const sounds: Array<
    Omit<AudioSource, "offsetMs" | "sourceStartMs" | "durationMs"> & {
      startMs: number;
      endMs: number;
      sourceAtStartMs: number;
    }
  > = [];
  for (const seg of manifest.segments) {
    if (
      seg.kind !== "shot" ||
      seg.clipAudio !== "included" ||
      seg.media.kind !== "video" ||
      !seg.media.assetId
    )
      continue;
    sounds.push({
      kind: "clip",
      assetId: seg.media.assetId,
      checksum: seg.media.checksum,
      itemId: seg.itemId,
      startMs: seg.startMs,
      endMs: seg.startMs + seg.durationMs,
      sourceAtStartMs: seg.sourceInMs ?? 0,
    });
  }
  for (const p of manifest.audio.performance) {
    if (!p.assetId) continue; // a take without an audio file (timed text) sounds as silence
    sounds.push({
      kind: "take",
      assetId: p.assetId,
      checksum: null,
      itemId: p.itemId,
      startMs: p.startMs,
      endMs: p.startMs + (p.takeOutMs - p.takeInMs),
      sourceAtStartMs: p.takeInMs,
    });
  }
  const hasAudio = sounds.length > 0;

  // the pieces' timeline intervals (ms), in order
  type Draft =
    | {
        kind: "title";
        startMs: number;
        endMs: number;
        seg: Extract<RenderManifest["segments"][number], { kind: "title" }>;
      }
    | { kind: "body"; startMs: number; endMs: number; seg: ManifestShotSegment }
    | {
        kind: "transition";
        startMs: number;
        endMs: number;
        from: ManifestShotSegment;
        to: ManifestShotSegment;
      };
  const drafts: Draft[] = [];
  let dissolveMs = 0;
  manifest.segments.forEach((seg, i) => {
    if (seg.kind === "title") {
      drafts.push({ kind: "title", startMs: seg.startMs, endMs: seg.startMs + seg.durationMs, seg });
      return;
    }
    const prev = manifest.segments[i - 1];
    const dIn =
      prev?.kind === "shot" && prev.transitionToNext.kind === "dissolve"
        ? prev.transitionToNext.durationMs
        : 0;
    const dOut = seg.transitionToNext.kind === "dissolve" ? seg.transitionToNext.durationMs : 0;
    const bodyStart = seg.startMs + dIn;
    const bodyEnd = seg.startMs + seg.durationMs - dOut;
    if (bodyEnd > bodyStart) drafts.push({ kind: "body", startMs: bodyStart, endMs: bodyEnd, seg });
    const next = manifest.segments[i + 1];
    if (dOut > 0 && next?.kind === "shot") {
      dissolveMs += dOut;
      drafts.push({
        kind: "transition",
        startMs: next.startMs,
        endMs: next.startMs + dOut,
        from: seg,
        to: next,
      });
    }
  });

  const pieces: RenderPiece[] = [];
  for (const d of drafts) {
    const startFrame = frameAtMs(d.startMs, fps);
    const endFrame = frameAtMs(d.endMs, fps);
    const frames = endFrame - startFrame;
    if (frames <= 0) continue; // shorter than a frame at this rate: nothing to show
    const startSample = sampleAtFrame(startFrame, fps);
    const samples = sampleAtFrame(endFrame, fps) - startSample;
    // the piece's exact timeline interval, as rendered
    const a = msAtFrameExact(startFrame, fps);
    const b = msAtFrameExact(endFrame, fps);
    const audio: AudioSource[] = [];
    for (const s of sounds) {
      const from = Math.max(a, s.startMs);
      const to = Math.min(b, s.endMs);
      if (to - from < 0.5) continue;
      audio.push({
        kind: s.kind,
        assetId: s.assetId,
        checksum: s.checksum,
        itemId: s.itemId,
        sourceStartMs: Math.round((s.sourceAtStartMs + (from - s.startMs)) * 1000) / 1000,
        offsetMs: Math.round((from - a) * 1000) / 1000,
        durationMs: Math.round((to - from) * 1000) / 1000,
      });
    }
    if (audio.length > MAX_AUDIO_SOURCES_PER_PIECE)
      throw new RenderPlanError(
        "unbounded",
        `A ${(frames / (fps.num / fps.den)).toFixed(2)} s stretch places more than ${MAX_AUDIO_SOURCES_PER_PIECE} sounds at once.`,
      );
    const base = { index: pieces.length, startFrame, frames, startSample, samples, audio };
    // the sounds of the piece, without the item id (identity is the media and its placement, not the edit item)
    const audioKey = audio.map((a) => ({ ...a, itemId: undefined }));
    const profileKey = {
      id: profile.id,
      v: profile.rendererVersion,
      fps: profile.fps,
      canvas: profile.canvas,
      video: profile.video,
      audio: profile.audio,
      hasAudio,
    };
    if (d.kind === "title") {
      const style = d.seg.layout.style;
      const piece: TitlePiece = {
        ...base,
        kind: "title",
        titleId: d.seg.titleId,
        placement: d.seg.placement,
        title: d.seg.text.title,
        subtitle: d.seg.text.subtitle,
        style,
        cacheKey: fingerprint({
          profileKey,
          kind: "title",
          frames,
          samples,
          text: d.seg.text,
          style,
          font: fonts ? fonts[style] : null,
          audio: audioKey,
        }),
      };
      pieces.push(piece);
    } else if (d.kind === "body") {
      const pic = picture(d.seg, d.startMs - d.seg.startMs);
      pieces.push({
        ...base,
        kind: "body",
        itemId: d.seg.itemId,
        shotCode: d.seg.shotCode,
        picture: pic,
        cacheKey: fingerprint({
          profileKey,
          kind: "body",
          frames,
          samples,
          picture: { ...pic, itemId: undefined, shotCode: undefined },
          audio: audioKey,
        }),
      });
    } else {
      const from = picture(d.from, d.startMs - d.from.startMs);
      const to = picture(d.to, 0);
      pieces.push({
        ...base,
        kind: "transition",
        from,
        to,
        cacheKey: fingerprint({
          profileKey,
          kind: "transition",
          frames,
          samples,
          from: { ...from, itemId: undefined, shotCode: undefined },
          to: { ...to, itemId: undefined, shotCode: undefined },
          audio: audioKey,
        }),
      });
    }
  }
  const totalFrames = pieces.reduce((n, p) => n + p.frames, 0);
  return {
    manifestFingerprint: fingerprint(manifest),
    stateFingerprint: manifest.edit.stateFingerprint,
    profileId: profile.id,
    totalFrames,
    totalSamples: pieces.reduce((n, p) => n + p.samples, 0),
    hasAudio,
    pieces,
    dissolveMs,
  };
}

/** Picture sources a piece opens (the bounded-rendering guard reads this). */
export const pictureSourcesOf = (p: RenderPiece): PictureSource[] =>
  p.kind === "title" ? [] : p.kind === "body" ? [p.picture] : [p.from, p.to];
