import type { GenerationPackage } from "../generation-package";
import {
  buildAdaptationPlan,
  type DurationStrategy,
  type FramingStrategy,
  type GenerationAdaptationPlan,
} from "../framing/adaptation";
import { parseAspectRatio, sameRatio } from "../framing/ratio";
import {
  GENERATION_MODALITIES,
  type GenerationModality,
  type GenerationModel,
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
  /** Human summary of the duration comparison, always present for video modalities. */
  duration: { productionMs: number; supported: string; ok: boolean } | null;
  /**
   * How production intent is adapted to this model (framing + duration). Always built for a model; `native`
   * when nothing changes. `used.*` already reflects the provider canvas/duration when the plan is `adapted`.
   * Not recorded on attempts logged before Phase 2C.
   */
  adaptation: GenerationAdaptationPlan | null;
}

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

  for (const c of pkg.characters) {
    for (const id of c.identityReferenceAssetIds) push(id, "identity", `${c.name} identity`);
    for (const id of c.look?.referenceAssetIds ?? [])
      push(id, "character_look", `${c.name} Look "${c.look?.name}"`);
  }
  for (const id of pkg.set?.referenceAssetIds ?? [])
    push(id, "location", `${pkg.set?.name ?? "Set"} reference`);
  push(pkg.lighting.referenceAssetId, "style", "Lighting reference");
  push(pkg.references.approvedStoryboardFrame?.assetId, "storyboard", "Approved storyboard frame");
  for (const id of pkg.references.referenceAssetIds) push(id, "other", "Shot reference");
  return out;
}

function chooseModality(pkg: GenerationPackage, model: GenerationModel): GenerationModality | null {
  const supported = new Set(model.capabilities.modalities);
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
  } = {},
): CompatibilityReport {
  const caps = model.capabilities;
  const errors: CompatibilityIssue[] = [];
  const warnings: CompatibilityIssue[] = [];
  const ignored: IgnoredFeature[] = [];
  const inputs: CompatibilityInput[] = [];

  const modality = opts.modality ?? chooseModality(pkg, model);
  if (!modality || !caps.modalities.includes(modality)) {
    errors.push({
      id: "modality.unsupported",
      feature: "modality",
      message: `${model.displayName} cannot do what this shot needs (${pkg.generation.modality}). It supports: ${caps.modalities.join(", ")}.`,
    });
  }
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
  const start = pkg.references.startFrameAssetId;
  const end = pkg.references.endFrameAssetId;
  let startUsed: string | null = null;
  let endUsed: string | null = null;
  if (modality === "image_to_video" || modality === "image_to_image") {
    if (!start) {
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
        message: `${model.displayName} cannot take a start frame.`,
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
  if (end) {
    if (caps.references.endFrame && video) endUsed = end;
    else
      ignored.push({
        id: "end_frame",
        feature: "end_frame",
        label: "End frame",
        impact: "The end frame will NOT be used; the shot may not land on the intended final pose.",
      });
  }
  if (start)
    inputs.push({
      kind: "start_frame",
      label: "Start frame",
      assetId: start,
      role: "start_frame",
      used: Boolean(startUsed),
    });
  if (end)
    inputs.push({
      kind: "end_frame",
      label: "End frame",
      assetId: end,
      role: "end_frame",
      used: Boolean(endUsed),
    });

  // ── references ──
  const candidates = deriveReferenceCandidates(pkg);
  const accepted: GenerationReference[] = [];
  const roleSupported = (role: ReferenceRole): boolean => {
    if (!caps.references.referenceImages) return false;
    if (role === "identity" || role === "character_look") return caps.references.characterReferences;
    if (role === "location") return caps.references.locationReferences;
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
  for (const [role, list] of droppedByRole) {
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
  if (pkg.references.referenceVideoAssetId) {
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
  if (audioTakes.length > 0 && !conditions) {
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
    duration,
    adaptation,
  };
}

/** Ids of every modality, exposed for UI selects. */
export const ALL_MODALITIES = GENERATION_MODALITIES;
