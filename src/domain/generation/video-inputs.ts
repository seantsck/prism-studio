import type { ShotContext } from "../context";
import { PRODUCTION_FRAME_REFERENCE } from "../generated-production-frame";
import type { GenerationPackage } from "../generation-package";
import type { GenerationAttempt } from "../schemas";
import { animationFreshness, animationProvenance, animationSource } from "./animation";
import { durationSupported } from "./compatibility";
import { isAnimationAttempt, type GenerationModel } from "./schemas";

/**
 * Phase 5B-V1: Canonical Production Frame → Shot Clip, in words a filmmaker reads before pressing Animate. Pure, and
 * derived ONLY from the frozen GenerationPackage the animation will freeze (the same one Phase 2H's
 * `animationSource` / adapter invariant check), so the preview can never disagree with what is sent.
 */
export const SHOT_CLIP_EARLIER_FRAME = "Generated from an earlier Production Frame.";
export const SHOT_CLIP_REPLACE_CONFIRM =
  "This Shot already has a Shot Clip. Confirm the replacement: the current clip stays in the Shot's history.";
export const SHOT_CLIP_NO_FRAME = "Select a Production Frame before animating this Shot.";

export interface VideoInputs {
  /** Animate is possible (2H source rules hold). */
  ready: boolean;
  firstFrame: {
    label: string;
    frameId: string;
    version: number;
    assetId: string;
    checksum: string | null;
    width: number | null;
    height: number | null;
    /** The production conform of the frame's own generation, or the provider original / an uploaded image. */
    image: "production_conform" | "original";
  } | null;
  action: string[];
  camera: string;
  performance: string[];
  continuity: string[];
  durationMs: number;
}

const clean = (xs: Array<string | null | undefined | false>) =>
  xs.map((x) => (x ? String(x).trim() : "")).filter(Boolean);

export function videoInputs(
  ctx: ShotContext,
  pkg: GenerationPackage,
  attempts: readonly GenerationAttempt[],
): VideoInputs {
  const source = animationSource(pkg);
  const pf = pkg.references.productionFrame;
  const frame = ctx.selectedProductionFrame;
  const fromAttempt = frame?.sourceGenerationAttemptId
    ? attempts.find((a) => a.id === frame.sourceGenerationAttemptId)
    : null;
  const cam = pkg.camera;
  const note = (label: string) => cam.notes.match(new RegExp(`^${label}: (.+)$`, "m"))?.[1]?.trim() ?? "";
  const camera =
    [
      !cam.movement.trim() || /^static/i.test(cam.movement.trim()) ? "Static" : cam.movement,
      cam.cameraAngle,
      cam.lens,
    ]
      .filter((x) => x && x.trim())
      .join(" · ") || "As established by the Production Frame";
  return {
    ready: source.ok,
    firstFrame:
      pf && frame
        ? {
            label: `Production Frame v${pf.version} — Shot ${pkg.shot.code}`,
            frameId: pf.frameId,
            version: pf.version,
            assetId: pf.assetId,
            checksum: pkg.assets[pf.assetId]?.checksum ?? null,
            width: frame.width,
            height: frame.height,
            image:
              fromAttempt && fromAttempt.outputAssetId && fromAttempt.outputAssetId !== pf.assetId
                ? "production_conform"
                : "original",
          }
        : null,
    action: clean([pkg.storyIntent.storyBeat, pkg.blocking.subjectBlocking]),
    camera,
    performance: clean([
      note("Emotional intent"),
      pkg.lighting.mood && `Mood: ${pkg.lighting.mood}`,
      cam.movement.trim() && !/^static/i.test(cam.movement.trim())
        ? ""
        : "Minimal movement: breathing, blinking, subtle motion",
    ]),
    continuity: clean([
      ...pkg.characters.map((c) => (c.look ? `${c.name} — ${c.look.name} Look` : `${c.name} — no Look`)),
      pkg.set?.name,
      pkg.references.locationView && `View: ${pkg.references.locationView.name}`,
      pkg.blocking.screenDirection && `Screen direction: ${pkg.blocking.screenDirection}`,
    ]),
    durationMs: pkg.timing.durationMs,
  };
}

export interface ShotClip {
  attempt: GenerationAttempt;
  /** The Shot's selected clip (`approved`; at most one per Shot). */
  selected: boolean;
  freshness: ReturnType<typeof animationFreshness>;
  /** The clip started from a Production Frame other than the Shot's current one. */
  fromEarlierFrame: boolean;
  /** Frozen first-frame provenance (2H). */
  provenance: NonNullable<ReturnType<typeof animationProvenance>>;
}

/** Every animation clip of the Shot (newest first), with its selection, lineage and freshness. History is kept. */
export function shotClips(ctx: ShotContext, attempts: readonly GenerationAttempt[]): ShotClip[] {
  const current = ctx.selectedProductionFrame?.id ?? null;
  return attempts
    .filter((a) => a.shotId === ctx.shot.id && isAnimationAttempt(a))
    .sort((a, b) => b.attemptNumber - a.attemptNumber)
    .map((attempt) => {
      const provenance = animationProvenance(attempt)!;
      const freshness = animationFreshness(ctx, attempt);
      return {
        attempt,
        selected: attempt.approved,
        freshness,
        fromEarlierFrame:
          provenance.frameId !== current || freshness.changed.includes(PRODUCTION_FRAME_REFERENCE),
        provenance,
      };
    });
}

/**
 * The clip durations a creator can choose: whole seconds (and any exact allowed value) that at least one usable
 * image-to-video model supports. One provider generation = one supported clip: nothing longer is faked or stitched.
 */
export function clipDurationChoices(models: readonly GenerationModel[]): number[] {
  const out = new Set<number>();
  for (const m of models) {
    const v = m.capabilities.video;
    if (!v || !m.capabilities.modalities.includes("image_to_video")) continue;
    for (const ms of v.allowedDurationsMs ?? []) out.add(ms);
    if (!v.allowedDurationsMs?.length)
      for (let s = 1; s <= 30; s++) if (durationSupported(v, s * 1000)) out.add(s * 1000);
  }
  return [...out].sort((a, b) => a - b);
}
