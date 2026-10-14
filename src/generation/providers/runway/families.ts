import type { CatalogModel, CatalogTier } from "@/domain/generation/models/types";
import { providerRatioFor, tierById } from "@/domain/generation/models/catalog";
import type { GenerationRequest } from "@/domain/generation/schemas";

/**
 * Model-family request shapes for the Runway developer API (SDK 4.21.0 types). Pure: no network, no assets.
 *
 * One adapter, several request SHAPES, chosen by the catalog entry's family:
 *   runway_gen4  promptImage [{position:first}] · ratio is a pixel string · no audio/refs/negative prompt
 *   veo          first (+ last) frame · `audio` boolean · `negativePrompt` · duration 4|6|8
 *   seedance     keyframes (first/last) on image_to_video OR `references` on text_to_video (never mixed),
 *                `referenceAudio`, `audio` boolean
 *   hailuo       like seedance, but `ratio` is an aspect label plus a separate `resolution` tier; no seed
 */
export type RunwayEndpoint = "image_to_video" | "text_to_video";

export interface ResolvedInputs {
  first: string | null;
  last: string | null;
  references: string[];
  audio: string[];
}

export const DEFAULT_ASPECT = "16:9";
/** Prompt cap used when the documentation states none (the provider validates; omissions are acknowledged). */
export const UNSTATED_PROMPT_CAP = 2500;

export function endpointFor(request: GenerationRequest): RunwayEndpoint {
  return request.modality === "image_to_video" ? "image_to_video" : "text_to_video";
}

export function tierFor(model: CatalogModel, request: GenerationRequest): CatalogTier {
  const wanted = request.providerOptions?.resolutionTier;
  return tierById(model, typeof wanted === "string" ? wanted : null);
}

export function nativeAudioRequested(model: CatalogModel, request: GenerationRequest): boolean {
  return model.audio.nativeGeneration === "supported" && request.providerOptions?.nativeAudio === true;
}

export function aspectsFor(model: CatalogModel, request: GenerationRequest): string[] {
  return request.modality === "text_to_video" && model.textToVideoAspectRatios
    ? model.textToVideoAspectRatios
    : model.aspectRatios;
}

/** Provider `ratio` value for the request (null when the model/tier/modality does not offer the aspect). */
export function ratioFor(
  model: CatalogModel,
  request: GenerationRequest,
): { ratio: string | null; tier: CatalogTier; defaulted: boolean; aspect: string } {
  const aspect = request.aspectRatio ?? DEFAULT_ASPECT;
  const tier = tierFor(model, request);
  const offered = aspectsFor(model, request).includes(aspect);
  return {
    ratio: offered ? providerRatioFor(model, aspect, tier.id) : null,
    tier,
    defaulted: request.aspectRatio == null,
    aspect,
  };
}

const seconds = (ms: number) => ms / 1000;

/** Canvas size when the provider ratio is a pixel string ("1280:720"); null for label ratios. */
export function canvasOf(ratio: string | null): { width: number; height: number } | null {
  const m = /^(\d{3,5}):(\d{3,5})$/.exec(ratio ?? "");
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

export function promptLimit(model: CatalogModel): number {
  return model.promptMaxChars ?? UNSTATED_PROMPT_CAP;
}

export interface BuiltCall {
  endpoint: RunwayEndpoint;
  body: Record<string, unknown>;
}

/** The exact SDK request body for a validated request. */
export function buildCall(
  model: CatalogModel,
  request: GenerationRequest,
  promptText: string,
  uris: ResolvedInputs,
): BuiltCall {
  const { ratio, tier } = ratioFor(model, request);
  const endpoint = endpointFor(request);
  const body: Record<string, unknown> = {
    model: model.modelId,
    promptText,
    duration: seconds(request.durationMs!),
    ratio: ratio!,
  };
  if (request.seed != null && model.family !== "hailuo") body.seed = request.seed;
  if (model.family === "hailuo") body.resolution = tier.id;

  if (model.family === "veo") {
    body.audio = nativeAudioRequested(model, request);
    if (request.prompt.negative.trim()) body.negativePrompt = request.prompt.negative.trim();
  }
  if (model.family === "seedance" && nativeAudioRequested(model, request)) body.audio = true;

  if (endpoint === "image_to_video") {
    const frames: Array<{ position: "first" | "last"; uri: string }> = [];
    if (uris.first) frames.push({ position: "first", uri: uris.first });
    if (uris.last && model.inputs.endFrame === "supported") frames.push({ position: "last", uri: uris.last });
    body.promptImage = frames;
  } else if (uris.references.length > 0) {
    body.references = uris.references.map((uri) => ({ uri }));
  }
  if (uris.audio.length > 0 && (model.family === "seedance" || model.family === "hailuo")) {
    body.referenceAudio = uris.audio.map((uri) => ({ type: "audio", uri }));
  }
  return { endpoint, body };
}

/** Model-aware request validation. Messages for the Gen-4 family are stable (tests and UI quote them). */
export function validateForModel(model: CatalogModel, request: GenerationRequest): string[] {
  const errors: string[] = [];
  const name = model.displayName;
  const ms = request.durationMs;

  if (!model.modalities.includes(request.modality)) {
    errors.push(`${name} does not support ${request.modality.replace(/_/g, "-")}.`);
  }
  if (model.availability === "retired" || model.availability === "unavailable") {
    errors.push(`${name} is not available (${model.availabilityNote || model.availability}).`);
  }

  // duration: never rounded
  const d = model.duration;
  const okDuration =
    ms != null &&
    ms % 1000 === 0 &&
    (d.allowedSeconds
      ? d.allowedSeconds.includes(seconds(ms))
      : seconds(ms) >= d.minSeconds &&
        seconds(ms) <= d.maxSeconds &&
        (!d.stepSeconds || (seconds(ms) - d.minSeconds) % d.stepSeconds === 0));
  if (!okDuration) {
    const offered = d.allowedSeconds
      ? d.allowedSeconds.map((s) => `${s} s`).join(", ")
      : `whole-second durations from ${d.minSeconds} to ${d.maxSeconds} s`;
    errors.push(
      `${name} accepts ${offered}; this shot is ${ms == null ? "unset" : `${seconds(ms)} s`}. Prism will not round it.`,
    );
  }

  const hasFirst = Boolean(request.startFrameAssetId);
  if (request.modality === "image_to_video" && !hasFirst) {
    errors.push("Image-to-video needs a first frame (approved storyboard frame or start frame).");
  }
  if (request.modality === "text_to_video" && hasFirst) {
    errors.push("A start frame was supplied but the text-to-video endpoint cannot use it.");
  }
  if (request.endFrameAssetId) {
    if (model.inputs.endFrame !== "supported") errors.push(`${name} has no end-frame input.`);
    else if (request.modality === "text_to_video") errors.push("An end frame needs image-to-video.");
    else if (!hasFirst) errors.push("A last frame requires a first frame.");
  }
  const refs = request.references.length;
  if (refs > 0) {
    if (model.inputs.referenceImages !== "supported") {
      errors.push(`${name} takes no reference images.`);
    } else if (model.inputs.maxReferenceImages != null && refs > model.inputs.maxReferenceImages) {
      errors.push(
        `${name} accepts at most ${model.inputs.maxReferenceImages} reference images; got ${refs}.`,
      );
    }
    if (hasFirst || request.endFrameAssetId) {
      errors.push(
        `${name} cannot combine first/last frames with reference images (the two modes cannot be mixed).`,
      );
    }
    if (request.modality === "image_to_video") {
      errors.push("Reference images use the text-to-video endpoint for this model.");
    }
  }
  if (request.audioAssetIds.length > 0 && model.audio.referenceConditioning !== "supported") {
    errors.push(`${name} takes no audio input.`);
  }
  if (request.prompt.negative.trim() && model.inputs.negativePrompt !== "supported") {
    // not an error: the compatibility engine already required acknowledgement; the field is simply not sent
  }

  if (model.modalities.includes(request.modality)) {
    const { ratio } = ratioFor(model, request);
    if (!ratio) {
      const offered = aspectsFor(model, request).join(", ");
      errors.push(
        `Aspect ratio ${request.aspectRatio ?? DEFAULT_ASPECT} is not available for ${request.modality.replace(/_/g, "-")} (offers ${offered}).`,
      );
    }
  }
  const tierWanted = request.providerOptions?.resolutionTier;
  if (typeof tierWanted === "string" && !model.tiers.some((t) => t.id === tierWanted)) {
    errors.push(`${name} has no ${tierWanted} tier (offers ${model.tiers.map((t) => t.id).join(", ")}).`);
  }
  if (request.providerOptions?.nativeAudio === true && model.audio.nativeGeneration !== "supported") {
    errors.push(`${name} cannot generate native audio.`);
  }
  if (!request.prompt.positive.trim()) errors.push("The prompt is empty.");
  return errors;
}
