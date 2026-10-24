import { lockedReferenceLabel } from "../character-continuity";
import type { GenerationPackage } from "../generation-package";
import {
  buildAdaptationPlan,
  type DurationStrategy,
  type FramingStrategy,
  type GenerationAdaptationPlan,
} from "../framing/adaptation";
import { parseAspectRatio, sameRatio } from "../framing/ratio";
import {
  ANIMATE_KEYFRAME_DISCLOSURE,
  ANIMATE_NO_REFERENCE_MODE,
  ANIMATE_REQUIRES_EXACT_FIRST_FRAME,
  ANIMATE_REQUIRES_IMAGE_TO_VIDEO,
  animationSource,
} from "./animation";
import {
  GENERATION_MODALITIES,
  type GenerationModality,
  type GenerationModel,
  type GenerationPurpose,
  type GenerationReference,
  type ReferenceRole,
  type Resolution,
} from "./schemas";

/**
 * Deterministic package ↔ model compatibility. Pure.
 *
 * Policy (the product's stance, encoded here):
 *   errors    block generation. Prism never "makes it fit" by silently rounding duration or dropping a
 *             required input.
 *   ignored   production intent the model cannot honour (end frame, performed audio, style references...).
 *             Always listed, always shown to the user, and the user must acknowledge them to submit.
 *   warnings  informational only.
 */

export interface CompatibilityIssue {
  id: string;
  feature: string;
  message: string;
}

export interface IgnoredFeature {
  /** Stable id used for acknowledgement ("performance_audio", "end_frame", "references.style"...). */
  id: string;
  feature: string;
  label: string;
  /** Plain-language consequence for the film. */
  impact: string;
}

export interface CompatibilityInput {
  kind: "start_frame" | "end_frame" | "reference" | "audio" | "reference_video";
  label: string;
  assetId: string | null;
  role: ReferenceRole | null;
  used: boolean;
}

export interface CompatibilityReport {
  provider: string;
  modelId: string;
  /** Why this generation is requested. `production_frame`: a still the human may promote; never the Shot's output. */
  purpose: GenerationPurpose;
  modality: GenerationModality | null;
  compatible: boolean;
  errors: CompatibilityIssue[];
  warnings: CompatibilityIssue[];
  ignoredFeatures: IgnoredFeature[];
  inputs: CompatibilityInput[];
  /** What the adapter will actually be given. */
  used: {
    durationMs: number | null;
    resolution: Resolution | null;
    aspectRatio: string | null;
    fps: number | null;
    references: GenerationReference[];
    startFrameAssetId: string | null;
    endFrameAssetId: string | null;
    audioAssetIds: string[];
  };
  /**
   * For models where first/last frames and reference images are mutually exclusive: which mode this
   * evaluation used. null for every other model. Phase 2E.
   */
  inputMode: "keyframes" | "references" | null;
  /** Human summary of the duration comparison, always present for video modalities. */
  duration: { productionMs: number; supported: string; ok: boolean } | null;
  /**
   * How production intent is adapted to this model (framing + duration). Always built for a model; `native`
   * when nothing changes. `used.*` already reflects the provider canvas/duration when the plan is `adapted`.
   * Not recorded on attempts logged before Phase 2C.
   */
  adaptation: GenerationAdaptationPlan | null;
}

export type InputMode = "keyframes" | "references";

/** The user's explicit adaptation choices (never defaulted by the engine). */
export interface AdaptationChoice {
  framing?: FramingStrategy | null;
  duration?: DurationStrategy | null;
}

const seconds = (ms: number) => `${Number((ms / 1000).toFixed(3))}s`;

export function parseResolution(raw: string | null | undefined): Resolution | null {
  const m = /^\s*(\d{2,5})\s*[x×]\s*(\d{2,5})\s*$/i.exec(raw ?? "");
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

const VIDEO_INTENT = new Set<GenerationModality>([
  "text_to_video",
  "image_to_video",
  "video_to_video",
  "audio_to_video",
  "lip_sync",
]);
export const isVideoModality = (m: GenerationModality) => VIDEO_INTENT.has(m);

interface Candidate {
  assetId: string;
  role: ReferenceRole;
  label: string;
}

interface CharacterImage {
  assetId: string;
  label: string;
}

/**
 * One assigned Character's identity and Look images with their request labels. A locked assignment's images come from
 * its frozen Character Continuity Lock (v5), in frozen order, labelled with the slot and the Lock; an unlocked one's
 * from the package's live entry exactly as before 2G.4. Never both: a locked entry's ids ARE the Lock's (the package
 * is assembled from one resolved appearance), so no reference is ever sent twice.
 */
export function characterImages(
  pkg: GenerationPackage,
  c: GenerationPackage["characters"][number],
): { identity: CharacterImage[]; look: CharacterImage[] } {
  const lock = c.continuityLock
    ? pkg.references.characterContinuity?.find(
        (l) => l.characterId === c.characterId && l.lockId === c.continuityLock?.lockId,
      )
    : undefined;
  if (lock) {
    const sorted = [...lock.references].sort((a, b) => a.position - b.position);
    const of = (role: "identity" | "look") =>
      sorted
        .filter((r) => r.role === role)
        .map((r) => ({ assetId: r.assetId, label: lockedReferenceLabel(lock, r) }));
    return { identity: of("identity"), look: of("look") };
  }
  return {
    identity: c.identityReferenceAssetIds.map((assetId) => ({ assetId, label: `${c.name} identity` })),
    look: (c.look?.referenceAssetIds ?? []).map((assetId) => ({
      assetId,
      label: `${c.name} Look "${c.look?.name}"`,
    })),
  };
}

/** Ordered reference candidates the package implies, deduplicated by asset. Start/end frames are separate. */
export function deriveReferenceCandidates(pkg: GenerationPackage): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const push = (assetId: string | null | undefined, role: ReferenceRole, label: string) => {
    if (!assetId || seen.has(assetId)) return;
    const a = pkg.assets[assetId];
    if (!a || (a.type !== "image" && a.type !== "reference")) return;
    seen.add(assetId);
    out.push({ assetId, role, label });
  };
  const { startFrameAssetId, endFrameAssetId } = pkg.references;
  if (startFrameAssetId) seen.add(startFrameAssetId);
  if (endFrameAssetId) seen.add(endFrameAssetId);

  const view = pkg.references.locationView;
  for (const c of pkg.characters) {
    const images = characterImages(pkg, c);
    for (const i of images.identity) if (i.assetId !== view?.assetId) push(i.assetId, "identity", i.label);
    for (const i of images.look) if (i.assetId !== view?.assetId) push(i.assetId, "character_look", i.label);
  }
  // v4: the Shot's canonical Location View before the Location's generic reference photos
  if (view) push(view.assetId, "location_view", locationViewLabel(view.name));
  for (const id of pkg.set?.referenceAssetIds ?? [])
    push(id, "location", `${pkg.set?.name ?? "Set"} reference`);
  push(pkg.lighting.referenceAssetId, "style", "Lighting reference");
  push(pkg.references.approvedStoryboardFrame?.assetId, "storyboard", "Approved storyboard frame");
  for (const id of pkg.references.referenceAssetIds) push(id, "other", "Shot reference");
  return out;
}

/** A package asset that has an actual stored file (a placeholder/seed record without bytes is never sent). */
const hasStoredFile = (pkg: GenerationPackage, assetId: string): boolean => {
  const a = pkg.assets[assetId];
  return Boolean(a && a.objectPath && a.checksum && (a.type === "image" || a.type === "reference"));
};

/** How a request labels the canonical Location View image (adapters show it to the model verbatim). */
export const locationViewLabel = (name: string) => `Canonical Location View "${name}"`;

/**
 * Deterministic reference priority for `production_frame` image generation (Phase 2G.2, extended in 2G.3 and 2G.4),
 * deduplicated by asset:
 *   1 selected Production Frame · 2 approved Storyboard · 3 Character identity · 4 Character Look ·
 *   5 selected Location View · 6 generic Location references · 7 lighting · 8 explicit Shot references.
 * Characters in Shot assignment order; identity before Look. A Character with a selected Continuity Lock contributes
 * ONLY the Lock's frozen images (identity in slot order, then Look in frozen order); one without, its live images.
 * An image is sent ONCE, under its most specific role: the Shot's own pictures (Production Frame, Storyboard) outrank
 * the Location View; the Location View outranks every generic role (identity / Look / Location / lighting / Shot
 * reference), so an image that is both is never spent twice and never mislabelled as generic.
 * Only explicit production data; only assets with a stored file; never the whole Project.
 */
export function deriveProductionFrameReferenceCandidates(pkg: GenerationPackage): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const push = (assetId: string | null | undefined, role: ReferenceRole, label: string) => {
    if (!assetId || seen.has(assetId) || !hasStoredFile(pkg, assetId)) return;
    seen.add(assetId);
    out.push({ assetId, role, label });
  };
  const view = pkg.references.locationView;
  push(pkg.references.productionFrame?.assetId, "production_frame", "Current Production Frame");
  push(pkg.references.approvedStoryboardFrame?.assetId, "storyboard", "Approved storyboard frame");
  const images = pkg.characters.map((c) => characterImages(pkg, c));
  for (const c of images)
    for (const i of c.identity) if (i.assetId !== view?.assetId) push(i.assetId, "identity", i.label);
  for (const c of images)
    for (const i of c.look) if (i.assetId !== view?.assetId) push(i.assetId, "character_look", i.label);
  if (view) push(view.assetId, "location_view", locationViewLabel(view.name));
  for (const id of pkg.set?.referenceAssetIds ?? [])
    push(id, "location", `${pkg.set?.name ?? "Set"} reference`);
  push(pkg.lighting.referenceAssetId, "style", "Lighting reference");
  for (const id of pkg.references.referenceAssetIds) push(id, "other", "Shot reference");
  return out;
}

function chooseModality(
  pkg: GenerationPackage,
  model: GenerationModel,
  purpose: GenerationPurpose,
): GenerationModality | null {
  const supported = new Set(model.capabilities.modalities);
  // Phase 2H: the canonical Production Frame IS the first frame. Image-to-video or nothing: never a text-to-video fallback.
  if (purpose === "animate_production_frame") return supported.has("image_to_video") ? "image_to_video" : null;
  if (purpose === "production_frame") {
    // Independent of `shot.generation.modality`: reference inputs present → image_to_image, otherwise text_to_image.
    const hasRefs = deriveProductionFrameReferenceCandidates(pkg).length > 0;
    const order: GenerationModality[] = hasRefs
      ? ["image_to_image", "text_to_image"]
      : ["text_to_image", "image_to_image"];
    return order.find((m) => supported.has(m)) ?? null;
  }
  const hasStart = Boolean(pkg.references.startFrameAssetId);
  const intent = pkg.generation.modality;
  const order: GenerationModality[] =
    intent === "image_to_video"
      ? ["image_to_video"]
      : intent === "video"
        ? hasStart
          ? ["image_to_video", "text_to_video"]
          : ["text_to_video", "image_to_video"]
        : intent === "image"
          ? hasStart || deriveReferenceCandidates(pkg).length > 0
            ? ["image_to_image", "text_to_image"]
            : ["text_to_image", "image_to_image"]
          : ["voice"];
  return order.find((m) => supported.has(m)) ?? null;
}

function describeSupportedDurations(v: NonNullable<GenerationModel["capabilities"]["video"]>): string {
  if (v.allowedDurationsMs?.length) return v.allowedDurationsMs.map(seconds).join(", ");
  const step = v.durationStepMs ? ` in ${seconds(v.durationStepMs)} steps` : "";
  return `${seconds(v.minDurationMs)}–${seconds(v.maxDurationMs)}${step}`;
}

function durationSupported(v: NonNullable<GenerationModel["capabilities"]["video"]>, ms: number): boolean {
  if (v.allowedDurationsMs?.length) return v.allowedDurationsMs.includes(ms);
  if (ms < v.minDurationMs || ms > v.maxDurationMs) return false;
  return v.durationStepMs ? (ms - v.minDurationMs) % v.durationStepMs === 0 : true;
}

export function evaluateCompatibility(
  pkg: GenerationPackage,
  model: GenerationModel,
  opts: {
    modality?: GenerationModality;
    adaptation?: AdaptationChoice;
    /** Shot-level protected composition notes (manual production intent). */
    protectedNotes?: string[];
    /**
     * Only meaningful for models whose first/last frames exclude reference images. Default "keyframes": the
     * approved storyboard frame stays the exact first frame and references are listed as not used.
     */
    inputMode?: InputMode;
    /**
     * Default `shot_output`. `production_frame` asks for a still image and ignores video-only inputs.
     * `animate_production_frame` (2H): image-to-video whose exact first frame is the selected, current Production
     * Frame; keyframe mode only; the frame is never also a reference.
     */
    purpose?: GenerationPurpose;
  } = {},
): CompatibilityReport {
  const purpose: GenerationPurpose = opts.purpose ?? "shot_output";
  const pfPurpose = purpose === "production_frame";
  const animPurpose = purpose === "animate_production_frame";
  const caps = model.capabilities;
  const errors: CompatibilityIssue[] = [];
  const warnings: CompatibilityIssue[] = [];
  const ignored: IgnoredFeature[] = [];
  const inputs: CompatibilityInput[] = [];

  const exclusive = caps.references.keyframesExcludeReferences === true;
  // reference mode would demote the Production Frame to a reference image: never for an animation of it
  if (animPurpose && opts.inputMode === "references")
    errors.push({ id: "animate.reference_mode", feature: "input_mode", message: ANIMATE_NO_REFERENCE_MODE });
  const referenceMode =
    !animPurpose &&
    exclusive &&
    opts.inputMode === "references" &&
    caps.references.referenceImages &&
    pkg.generation.modality === "video" &&
    caps.modalities.includes("text_to_video");
  const modality = opts.modality ?? (referenceMode ? "text_to_video" : chooseModality(pkg, model, purpose));
  if (
    !modality ||
    !caps.modalities.includes(modality) ||
    (pfPurpose && isVideoModality(modality)) ||
    (animPurpose && modality !== "image_to_video")
  ) {
    errors.push({
      id: animPurpose ? "animate.image_to_video_required" : "modality.unsupported",
      feature: "modality",
      message: animPurpose
        ? `${ANIMATE_REQUIRES_EXACT_FIRST_FRAME} ${ANIMATE_REQUIRES_IMAGE_TO_VIDEO} ${model.displayName} supports: ${caps.modalities.join(", ")}.`
        : pfPurpose
          ? `${model.displayName} cannot generate a still image for a Production Frame. It supports: ${caps.modalities.join(", ")}.`
          : `${model.displayName} cannot do what this shot needs (${pkg.generation.modality}). It supports: ${caps.modalities.join(", ")}.`,
    });
  }
  // the hard source rules (no frame / stale frame / a different manual override): never acknowledgeable
  const source = animPurpose ? animationSource(pkg) : null;
  if (source && !source.ok)
    for (const i of source.issues)
      errors.push({ id: `animate.${i.code}`, feature: "start_frame", message: i.message });
  const video = modality ? isVideoModality(modality) : false;

  // ── resolution (clamped, but loudly) — resolved first: the adaptation plan sizes the provider canvas from it ──
  let resolution = parseResolution(pkg.generation.resolution);
  const max = video ? caps.video?.maxResolution : caps.image?.resolutions.at(-1);
  if (resolution && max && (resolution.width > max.width || resolution.height > max.height)) {
    ignored.push({
      id: "resolution",
      feature: "resolution",
      label: `Resolution ${resolution.width}×${resolution.height}`,
      impact: `Model maximum is ${max.width}×${max.height}; output will be smaller than the shot's requested resolution.`,
    });
    resolution = {
      width: Math.min(resolution.width, max.width),
      height: Math.min(resolution.height, max.height),
    };
  }

  // ── adaptation: production intent → provider canvas/duration (explicit, never silent) ──
  const aspect = pkg.style.aspectRatio || null;
  const ratios = (video ? caps.video?.aspectRatios : caps.image?.aspectRatios) ?? [];
  const production = pkg.timing.durationMs;
  const adaptation = buildAdaptationPlan({
    video,
    production: {
      aspectRatio: aspect,
      durationMs: video && production > 0 ? production : null,
      fps: pkg.generation.fps || null,
    },
    provider: {
      provider: model.provider,
      modelId: model.modelId,
      aspectRatios: ratios,
      requestedResolution: resolution,
      maxResolution: max ?? null,
      duration:
        video && caps.video
          ? {
              minMs: caps.video.minDurationMs,
              maxMs: caps.video.maxDurationMs,
              stepMs: caps.video.durationStepMs,
              allowedMs: caps.video.allowedDurationsMs,
            }
          : null,
    },
    choice: opts.adaptation,
    protectedNotes: opts.protectedNotes,
  });

  // ── duration (never rounded) ──
  let durationMs: number | null = null;
  let duration: CompatibilityReport["duration"] = null;
  if (video) {
    if (!caps.video) {
      errors.push({
        id: "duration.unsupported",
        feature: "duration",
        message: `${model.displayName} does not declare video capabilities.`,
      });
    } else if (!(production > 0)) {
      errors.push({
        id: "duration.unset",
        feature: "duration",
        message: "This shot has no duration. Select a performance take or set a target duration.",
      });
    } else {
      const ok = durationSupported(caps.video, production);
      const supported = describeSupportedDurations(caps.video);
      duration = { productionMs: production, supported, ok };
      if (ok) durationMs = production;
      else if (adaptation.duration.status === "adapted" && adaptation.duration.providerMs != null) {
        // The user explicitly chose "generate longer, then trim": the provider is asked for a supported
        // duration; the production duration is untouched and recorded in the plan.
        durationMs = adaptation.duration.providerMs;
      } else {
        errors.push({
          id: "duration.unsupported",
          feature: "duration",
          message: `Production duration ${seconds(production)}; ${model.displayName} supports ${supported}. Prism will not round the shot silently.`,
        });
      }
    }
  }

  // ── aspect ratio ──
  const framingAdapted = adaptation.framing.status === "adapted";
  if (aspect && ratios.length > 0 && !framingAdapted) {
    const parsed = parseAspectRatio(aspect);
    const offered = ratios.some((r) => {
      const pr = parseAspectRatio(r);
      return r === aspect || (parsed && pr && sameRatio(pr.value, parsed.value));
    });
    if (!offered) {
      errors.push({
        id: "aspect_ratio.unsupported",
        feature: "aspect_ratio",
        message: `Aspect ratio ${aspect} is not supported (model offers ${ratios.join(", ")}).`,
      });
    }
  }
  // Non-native adaptation is production intent that execution changes: it is acknowledged like any other
  // "will not be honoured as designed" item, and recorded on the attempt.
  for (const a of adaptation.acknowledgements) {
    ignored.push({ id: a.id, feature: "adaptation", label: a.label, impact: a.impact });
  }

  let fps: number | null = pkg.generation.fps || null;
  if (video && fps && caps.video && caps.video.fps.length > 0 && !caps.video.fps.includes(fps)) {
    const nearest = [...caps.video.fps].sort((a, b) => Math.abs(a - fps!) - Math.abs(b - fps!))[0]!;
    ignored.push({
      id: "fps",
      feature: "fps",
      label: `${fps} fps`,
      impact: `Model offers ${caps.video.fps.join(", ")} fps; output will be ${nearest} fps.`,
    });
    fps = nearest;
  }

  // ── prompt ──
  if (!caps.references.textPrompt) {
    errors.push({
      id: "prompt.unsupported",
      feature: "prompt",
      message: "This model does not accept a text prompt.",
    });
  }
  if (pkg.prompt.negative.trim() && !caps.references.negativePrompt) {
    ignored.push({
      id: "negative_prompt",
      feature: "negative_prompt",
      label: "Negative constraints",
      impact: "The model has no negative prompt field; 'do not' constraints cannot be enforced separately.",
    });
  }

  // ── frames ──
  // An animation starts ONLY from the selected Production Frame's own Asset (never the generic precedence's override or
  // Storyboard); every other purpose keeps the package's start frame.
  const start = animPurpose
    ? (pkg.references.productionFrame?.assetId ?? null)
    : pkg.references.startFrameAssetId;
  const end = pkg.references.endFrameAssetId;
  let startUsed: string | null = null;
  let endUsed: string | null = null;
  const asReference = referenceMode && video && modality === "text_to_video";
  const frameRefs: Candidate[] = [];
  if (pfPurpose) {
    // Production Frame candidates: the selected Production Frame / Storyboard are IMAGE REFERENCES (highest priority),
    // never first/last frames of a video. Frame inputs and the Shot's explicit start-frame override do not apply.
  } else if (asReference) {
    // Reference mode: frames cannot be keyframes, so they join the reference images (visibly, not silently).
    if (start) {
      frameRefs.push({
        assetId: start,
        role: start === pkg.references.approvedStoryboardFrame?.assetId ? "storyboard" : "start_frame",
        label: "Start frame / storyboard",
      });
      ignored.push({
        id: "start_frame",
        feature: "start_frame",
        label: "Start frame as a reference image",
        impact:
          "In reference mode the storyboard frame is a reference image, not the exact first frame of the clip.",
      });
    }
    if (end) {
      frameRefs.push({ assetId: end, role: "end_frame", label: "End frame" });
      ignored.push({
        id: "end_frame",
        feature: "end_frame",
        label: "End frame as a reference image",
        impact: "In reference mode the end frame is a reference image, not the exact last frame of the clip.",
      });
    }
  } else if (modality === "image_to_video" || modality === "image_to_image") {
    if (!start) {
      // an animation without a Production Frame is already blocked by its own source rule (one message, not two)
      if (!animPurpose)
        errors.push({
          id: "start_frame.missing",
          feature: "start_frame",
          message:
            "This modality needs a start frame, but the shot has no approved storyboard frame or start frame.",
        });
    } else if (!caps.references.startFrame) {
      errors.push({
        id: "start_frame.unsupported",
        feature: "start_frame",
        message: animPurpose
          ? `${model.displayName} cannot take a start frame. ${ANIMATE_REQUIRES_EXACT_FIRST_FRAME}`
          : `${model.displayName} cannot take a start frame.`,
      });
    } else startUsed = start;
  } else if (start) {
    if (caps.references.startFrame) startUsed = start;
    else
      ignored.push({
        id: "start_frame",
        feature: "start_frame",
        label: "Start frame (storyboard)",
        impact: "The approved storyboard frame will NOT condition the first frame of this generation.",
      });
  }
  if (end && !asReference && !pfPurpose) {
    if (caps.references.endFrame && video) endUsed = end;
    else
      ignored.push({
        id: "end_frame",
        feature: "end_frame",
        label: "End frame",
        impact: "The end frame will NOT be used; the shot may not land on the intended final pose.",
      });
  }
  if (start && !pfPurpose)
    inputs.push({
      kind: "start_frame",
      label: animPurpose ? "Production Frame (exact first frame)" : "Start frame",
      assetId: start,
      role: "start_frame",
      used: Boolean(startUsed) || frameRefs.some((f) => f.assetId === start),
    });
  if (end && !pfPurpose)
    inputs.push({
      kind: "end_frame",
      label: "End frame",
      assetId: end,
      role: "end_frame",
      used: Boolean(endUsed) || frameRefs.some((f) => f.assetId === end),
    });

  // ── references ──
  const candidates = pfPurpose
    ? deriveProductionFrameReferenceCandidates(pkg)
    : animPurpose
      ? // the frame is the start frame only (one Asset, one input slot); the Storyboard it supersedes is not sent
        deriveReferenceCandidates(pkg).filter((c) => c.assetId !== start && c.role !== "storyboard")
      : [...frameRefs, ...deriveReferenceCandidates(pkg)];
  const accepted: GenerationReference[] = [];
  const roleSupported = (role: ReferenceRole): boolean => {
    if (!caps.references.referenceImages) return false;
    if (role === "identity" || role === "character_look") return caps.references.characterReferences;
    if (role === "location" || role === "location_view") return caps.references.locationReferences;
    if (role === "style") return caps.references.styleReferences;
    return true;
  };
  const droppedByRole = new Map<string, Candidate[]>();
  for (const c of candidates) {
    if (roleSupported(c.role))
      accepted.push({ assetId: c.assetId, role: c.role, order: accepted.length, label: c.label });
    else droppedByRole.set(c.role, [...(droppedByRole.get(c.role) ?? []), c]);
    inputs.push({
      kind: "reference",
      label: c.label,
      assetId: c.assetId,
      role: c.role,
      used: roleSupported(c.role),
    });
  }
  if (exclusive && !referenceMode && (startUsed || endUsed) && accepted.length > 0) {
    // The provider cannot mix first/last frames with reference images: never drop one silently.
    for (const i of inputs) if (i.kind === "reference") i.used = false;
    ignored.push({
      id: "references.mode_exclusive",
      feature: "references",
      label: `${accepted.length} reference image${accepted.length === 1 ? "" : "s"} (keyframe mode)`,
      impact: animPurpose
        ? ANIMATE_KEYFRAME_DISCLOSURE
        : "This model cannot combine first/last frames with reference images. In keyframe mode the references are NOT used; choose reference mode to use them (the storyboard frame then becomes a reference, not the exact first frame).",
    });
    accepted.length = 0;
  }
  // truthful: a Continuity Lock's appearance is still described in words, but the model never sees its images
  const lockedAssets = new Set(
    (pkg.references.characterContinuity ?? []).flatMap((l) => l.references.map((r) => r.assetId)),
  );
  const droppedLocked = [...droppedByRole.values()].flat().filter((c) => lockedAssets.has(c.assetId));
  if (droppedLocked.length > 0)
    ignored.push({
      id: "references.character_continuity",
      feature: "references",
      label: `${droppedLocked.length} Character Continuity Lock image${droppedLocked.length === 1 ? "" : "s"}`,
      impact:
        "Character reference images not supplied to this model. The locked identity and Look are described in the prompt text only; the result is NOT conditioned on those images.",
    });
  for (const [role, list] of droppedByRole) {
    if (role === "location_view") {
      // truthful: the view's viewpoint is still described in words, but the model never sees its image
      ignored.push({
        id: "references.location_view",
        feature: "references",
        label: list[0]!.label,
        impact:
          "Location View image not supplied to this model. Its viewpoint is described in the prompt text only; the result is NOT conditioned on the image.",
      });
      continue;
    }
    ignored.push({
      id: `references.${role}`,
      feature: "references",
      label: `${list.length} ${role.replace("_", " ")} reference${list.length === 1 ? "" : "s"}`,
      impact: caps.references.referenceImages
        ? `This model does not accept ${role.replace("_", " ")} references; they will NOT influence the result.`
        : "This model does not accept reference images; none of the references will influence the result.",
    });
  }
  if (accepted.length > caps.references.maxReferences) {
    errors.push({
      id: "references.too_many",
      feature: "references",
      message: `${accepted.length} references selected; ${model.displayName} accepts at most ${caps.references.maxReferences}. Reduce references in Shot Prep.`,
    });
  }
  if (accepted.length > 1 && !caps.references.orderedReferences) {
    ignored.push({
      id: "references.order",
      feature: "references",
      label: "Reference order",
      impact: "The model does not preserve reference order; earlier references will not carry more weight.",
    });
  }
  if (pkg.references.referenceVideoAssetId && !pfPurpose) {
    const used = caps.references.referenceVideo;
    inputs.push({
      kind: "reference_video",
      label: "Reference video",
      assetId: pkg.references.referenceVideoAssetId,
      role: "motion_reference",
      used,
    });
    if (!used) {
      ignored.push({
        id: "reference_video",
        feature: "reference_video",
        label: "Reference video",
        impact: "The motion reference video will NOT be used.",
      });
    }
  }

  // ── audio: never pretend these capabilities are equivalent ──
  const audioAssetIds: string[] = [];
  const audioTakes = pkg.performance.flatMap((p) =>
    p.selectedTake?.audioAssetId ? [{ assetId: p.selectedTake.audioAssetId, speaker: p.speaker }] : [],
  );
  const conditions = caps.audio.audioConditioning || caps.audio.lipSync || caps.references.referenceAudio;
  if (pfPurpose) {
    // An image model receives no audio. Informational only: it never claims audio conditioning, and it is not a
    // production intent the user has to acknowledge for a still.
    if (audioTakes.length > 0)
      warnings.push({
        id: "performance_audio.image",
        feature: "performance_audio",
        message:
          "Performed audio is not sent to image models. The performance only informs the emotional and pose intent in the prompt text.",
      });
  } else
    for (const t of audioTakes) {
      inputs.push({
        kind: "audio",
        label: `${t.speaker} performance`,
        assetId: t.assetId,
        role: null,
        used: conditions,
      });
      if (conditions) audioAssetIds.push(t.assetId);
    }
  if (audioTakes.length > 0 && !conditions && !pfPurpose) {
    const speakers = [...new Set(audioTakes.map((t) => t.speaker))].join(", ");
    ignored.push({
      id: "performance_audio",
      feature: "performance_audio",
      label: `Performed audio (${speakers})`,
      impact: `Selected ${speakers} performance will NOT condition this ${video ? "video" : "generation"}.${
        caps.audio.nativeDialogueAudio ? " The model may generate its own speech instead." : ""
      } Lip sync and timing will have to be handled in post.`,
    });
  }

  return {
    provider: model.provider,
    modelId: model.modelId,
    purpose,
    modality: modality ?? null,
    compatible: errors.length === 0,
    errors,
    warnings,
    ignoredFeatures: ignored,
    inputs,
    used: {
      durationMs,
      resolution: framingAdapted ? (adaptation.framing.providerCanvas ?? resolution) : resolution,
      aspectRatio: framingAdapted ? (adaptation.framing.providerLabel ?? aspect) : aspect,
      fps,
      references: accepted.slice(0, caps.references.maxReferences),
      startFrameAssetId: startUsed,
      endFrameAssetId: endUsed,
      audioAssetIds,
    },
    inputMode: exclusive ? (referenceMode ? "references" : "keyframes") : null,
    duration,
    adaptation,
  };
}

/** Ids of every modality, exposed for UI selects. */
export const ALL_MODALITIES = GENERATION_MODALITIES;
