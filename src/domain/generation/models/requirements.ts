import type { GenerationPackage } from "../../generation-package";
import { deriveReferenceCandidates } from "../compatibility";

/**
 * What THIS shot asks of a generator, derived only from structured Prism production truth (the frozen
 * GenerationPackage). No AI, no subjective inference, no fake precision: a requirement is present because a
 * stored field says so, and each one carries the reason in plain language.
 */
export interface ShotGenerationRequirements {
  production: {
    aspectRatio: string | null;
    durationMs: number | null;
    resolution: string | null;
    fps: number | null;
  };
  characterCount: number;
  identityReferenceCount: number;
  lookReferenceCount: number;
  locationReferenceCount: number;
  /** Distinct reference IMAGES the package implies (excluding the start/end frame). */
  referenceImageCount: number;
  hasStartFrame: boolean;
  hasEndFrame: boolean;
  hasApprovedStoryboard: boolean;
  hasReferenceVideo: boolean;
  hasPerformanceAudio: boolean;
  performanceAudioCount: number;
  hasDialogue: boolean;
  protectedComposition: string[];
  /** Model-relevant needs (each with the reason that makes it a need). */
  needs: {
    startFrame: Need;
    multipleImageReferences: Need;
    audio: Need;
    videoReference: Need;
    longDuration: Need;
    multiCharacter: Need;
    nativeProductionRatio: Need;
  };
}

export interface Need {
  needed: boolean;
  because: string;
}

/** Above this a generator is "long" for the current model set (Veo tops out at 8 s). */
export const LONG_DURATION_MS = 8_000;
/** Ratios most generators offer natively; anything else is a non-standard production frame. */
export const STANDARD_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4"];

const need = (needed: boolean, yes: string, no: string): Need => ({ needed, because: needed ? yes : no });

export function deriveShotRequirements(
  pkg: GenerationPackage,
  opts: { protectedComposition?: string[] } = {},
): ShotGenerationRequirements {
  const identity = new Set<string>();
  const looks = new Set<string>();
  for (const c of pkg.characters) {
    for (const id of c.identityReferenceAssetIds) identity.add(id);
    for (const id of c.look?.referenceAssetIds ?? []) looks.add(id);
  }
  const location = new Set(pkg.set?.referenceAssetIds ?? []);
  const referenceImageCount = deriveReferenceCandidates(pkg).length;
  const audio = pkg.performance.filter((p) => Boolean(p.selectedTake?.audioAssetId)).length;
  const hasDialogue = pkg.performance.length > 0 || pkg.sourceScript.dialogue.length > 0;
  const aspect = pkg.style.aspectRatio || null;
  const duration = pkg.timing.durationMs > 0 ? pkg.timing.durationMs : null;
  const characterCount = pkg.characters.length;
  const hasStart = Boolean(pkg.references.startFrameAssetId);
  const hasEnd = Boolean(pkg.references.endFrameAssetId);
  const hasVideo = Boolean(pkg.references.referenceVideoAssetId);
  const nonStandard = aspect != null && !STANDARD_RATIOS.includes(aspect);

  return {
    production: {
      aspectRatio: aspect,
      durationMs: duration,
      resolution: pkg.generation.resolution || null,
      fps: pkg.generation.fps || null,
    },
    characterCount,
    identityReferenceCount: identity.size,
    lookReferenceCount: looks.size,
    locationReferenceCount: location.size,
    referenceImageCount,
    hasStartFrame: hasStart,
    hasEndFrame: hasEnd,
    hasApprovedStoryboard: Boolean(pkg.references.approvedStoryboardFrame?.assetId),
    hasReferenceVideo: hasVideo,
    hasPerformanceAudio: audio > 0,
    performanceAudioCount: audio,
    hasDialogue,
    protectedComposition: (opts.protectedComposition ?? []).map((s) => s.trim()).filter(Boolean),
    needs: {
      startFrame: need(
        hasStart,
        "An approved storyboard/start frame exists and should condition the first frame.",
        "No start frame: text-to-video is acceptable.",
      ),
      multipleImageReferences: need(
        identity.size + looks.size >= 2,
        `${identity.size} identity and ${looks.size} Look reference image(s) carry the character; a model that takes only a start frame will not use them.`,
        "Fewer than two identity/Look references.",
      ),
      audio: need(
        audio > 0,
        `${audio} selected performance take(s) with audio.`,
        "No selected performance audio.",
      ),
      videoReference: need(hasVideo, "A motion reference video is attached.", "No reference video."),
      longDuration: need(
        duration != null && duration > LONG_DURATION_MS,
        `Production duration ${duration! / 1000}s is above ${LONG_DURATION_MS / 1000}s.`,
        "Duration fits short-clip models.",
      ),
      multiCharacter: need(
        characterCount >= 2,
        `${characterCount} characters in frame.`,
        characterCount === 1 ? "One character in frame." : "No named character in frame.",
      ),
      nativeProductionRatio: need(
        nonStandard,
        `Production ratio ${aspect} is not a common provider ratio; most models need framing adaptation.`,
        "Production ratio is a common provider ratio.",
      ),
    },
  };
}

// ───────────────────────── feature profile ─────────────────────────

export type CountBucket = "0" | "1" | "2" | "3+";
export type DurationBucket = "lt3" | "3to6" | "6to10" | "gt10" | "unset";
export type MovementBucket = "static" | "moving" | "unspecified";
export type IntExt = "interior" | "exterior" | "unspecified";
export type DayNight = "day" | "night" | "unspecified";

/**
 * Coarse, structured, explainable features used to group historical outcomes ("single-character close-up",
 * "two-character dialogue"). Derived from stored fields only; subjective qualities are never inferred.
 */
export interface ShotFeatureProfile {
  version: 1;
  characterCount: CountBucket;
  hasDialogue: boolean;
  hasPerformanceAudio: boolean;
  durationBucket: DurationBucket;
  shotSize: string;
  cameraMovement: MovementBucket;
  interiorExterior: IntExt;
  dayNight: DayNight;
  hasRecurringCharacter: boolean;
  referenceCount: number;
  needsWardrobeContinuity: boolean;
  needsLocationContinuity: boolean;
  productionRatio: string | null;
  nonStandardRatio: boolean;
}

const countBucket = (n: number): CountBucket => (n <= 0 ? "0" : n === 1 ? "1" : n === 2 ? "2" : "3+");

export function durationBucket(ms: number | null): DurationBucket {
  if (ms == null || ms <= 0) return "unset";
  const s = ms / 1000;
  return s < 3 ? "lt3" : s <= 6 ? "3to6" : s <= 10 ? "6to10" : "gt10";
}

function dayNight(pkg: GenerationPackage): DayNight {
  const raw = `${pkg.continuity.timeOfDay} ${pkg.storyIntent.scene.slugline}`.toLowerCase();
  if (/\bnight|evening|dusk|midnight/.test(raw)) return "night";
  if (/\bday|morning|afternoon|noon|dawn/.test(raw)) return "day";
  return "unspecified";
}

function interiorExterior(pkg: GenerationPackage): IntExt {
  const s = pkg.storyIntent.scene.slugline.trim().toUpperCase();
  if (/^(INT\.?\/EXT|I\/E)/.test(s)) return "unspecified";
  if (/^INT\b/.test(s)) return "interior";
  if (/^EXT\b/.test(s)) return "exterior";
  return "unspecified";
}

export function deriveShotFeatureProfile(
  pkg: GenerationPackage,
  req: ShotGenerationRequirements = deriveShotRequirements(pkg),
): ShotFeatureProfile {
  const movement = pkg.camera.movement.trim().toLowerCase();
  const size = pkg.camera.shotSize.trim().toLowerCase();
  const wardrobe = pkg.characters.some(
    (c) => c.look != null && (c.look.locked || c.look.wardrobe.trim() !== ""),
  );
  return {
    version: 1,
    characterCount: countBucket(req.characterCount),
    hasDialogue: req.hasDialogue,
    hasPerformanceAudio: req.hasPerformanceAudio,
    durationBucket: durationBucket(req.production.durationMs),
    shotSize: size || "unspecified",
    cameraMovement: !movement
      ? "unspecified"
      : /static|locked|still|hold/.test(movement)
        ? "static"
        : "moving",
    interiorExterior: interiorExterior(pkg),
    dayNight: dayNight(pkg),
    hasRecurringCharacter: pkg.characters.some((c) => c.identityReferenceAssetIds.length > 0),
    referenceCount: req.referenceImageCount,
    needsWardrobeContinuity: wardrobe,
    needsLocationContinuity: Boolean(pkg.set?.locked) || Boolean(pkg.set),
    productionRatio: req.production.aspectRatio,
    nonStandardRatio: req.needs.nativeProductionRatio.needed,
  };
}

/** Human label for grouping, e.g. "1 character · close-up · dialogue · 3–6 s". */
export function profileLabel(p: ShotFeatureProfile): string {
  const chars =
    p.characterCount === "0"
      ? "no character"
      : p.characterCount === "1"
        ? "1 character"
        : `${p.characterCount} characters`;
  const size = p.shotSize !== "unspecified" ? p.shotSize : "unspecified size";
  const duration: Record<DurationBucket, string> = {
    lt3: "< 3 s",
    "3to6": "3–6 s",
    "6to10": "6–10 s",
    gt10: "> 10 s",
    unset: "no duration",
  };
  return [chars, size, p.hasDialogue ? "dialogue" : "no dialogue", duration[p.durationBucket]].join(" · ");
}

/** The features that decide "similar shot" (kept few and explainable). */
const SIMILARITY_KEYS = [
  "characterCount",
  "hasDialogue",
  "durationBucket",
  "shotSize",
  "cameraMovement",
] as const;

/** 0..1 share of the key features two shots have in common. */
export function profileSimilarity(a: ShotFeatureProfile, b: ShotFeatureProfile): number {
  let same = 0;
  for (const k of SIMILARITY_KEYS) if (a[k] === b[k]) same += 1;
  return same / SIMILARITY_KEYS.length;
}

/** Shots count as "similar" at or above this share of matching key features (4 of 5). */
export const SIMILAR_THRESHOLD = 0.8;
export const isSimilar = (a: ShotFeatureProfile, b: ShotFeatureProfile) =>
  profileSimilarity(a, b) >= SIMILAR_THRESHOLD;
