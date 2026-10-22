import type RunwayML from "@runwayml/sdk";
import type { CatalogModel } from "@/domain/generation/models/types";
import { tierById } from "@/domain/generation/models/catalog";
import type { GenerationReference, GenerationRequest } from "@/domain/generation/schemas";

/**
 * Still-image request shapes for the Runway developer API (SDK 4.22.0 `textToImage.create`). Pure: no network,
 * no assets. Every body is built against the SDK's own request union, so an untyped field or a ratio the SDK does
 * not list fails type checking (no `as any`, no hand-written REST).
 *
 *   gpt_image    `ratio` (pixel string) · `quality` · tagged `referenceImages` · up to 16
 *   seedream     `ratio` · `outputFormat` · ordered `referenceImages` (no tags) · up to 14
 *   muse_image   `ratio` · `outputFormat` · ordered `referenceImages` (no tags) · up to 10
 *
 * Phase 2G.2 invariant: `outputCount` is ALWAYS 1. One attempt is one image, whatever the provider could return.
 */
type Params = RunwayML.TextToImageCreateParams;
type GptParams = Extract<Params, { model: "gpt_image_2_5_flare" }>;
type MuseParams = Extract<Params, { model: "muse_image" }>;
type SeedreamParams = Extract<Params, { model: "seedream5_lite" }>;

export const IMAGE_OUTPUT_COUNT = 1 as const;

/** Ratios the SDK types for each model. The catalog is tested against these lists. */
export const GPT_IMAGE_RATIOS = [
  "2048:880",
  "1920:1088",
  "1920:1280",
  "1920:1440",
  "1920:1536",
  "1920:1920",
  "1536:1920",
  "1440:1920",
  "1280:1920",
  "1088:1920",
] as const satisfies readonly GptParams["ratio"][];

export const MUSE_IMAGE_RATIOS = [
  "2352:1008",
  "2016:1152",
  "1920:1280",
  "1792:1344",
  "1600:1600",
  "1344:1792",
  "1280:1920",
  "1152:2016",
] as const satisfies readonly MuseParams["ratio"][];

export const GPT_IMAGE_QUALITIES = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly NonNullable<GptParams["quality"]>[];

export type RunwayImageModelId = "gpt_image_2_5_flare" | "muse_image" | "seedream5_lite";

export interface ResolvedImageReference {
  /** data URI or short-lived signed URL of the stored reference image (never a Prism public URL). */
  uri: string;
  role: GenerationReference["role"];
  label: string;
}

const pick = <T extends string>(list: readonly T[], value: string | null): T | null =>
  list.find((x) => x === value) ?? null;

/** Provider `ratio` for the request's aspect label at the model's (single) canvas tier; null when not offered. */
export function imageRatioFor(model: CatalogModel, request: GenerationRequest): string | null {
  const tier = tierById(model, null);
  const label = request.aspectRatio;
  return label ? (tier.ratios[label] ?? null) : null;
}

export function imageQualityFor(model: CatalogModel, request: GenerationRequest): string | null {
  const wanted = request.providerOptions?.quality;
  if (typeof wanted === "string" && model.image?.qualities.some((q) => q.id === wanted)) return wanted;
  return model.image?.defaultQuality ?? null;
}

// ───────────────────────── reference tags ─────────────────────────

const TAG_BASE: Partial<Record<GenerationReference["role"], string>> = {
  production_frame: "ProductionFrame",
  storyboard: "Storyboard",
  location: "Location",
  location_view: "LocationView",
  style: "Lighting",
  other: "ShotRef",
};

const wordsOf = (s: string) =>
  s
    .replace(/[^A-Za-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1));

/** The subject name inside a label such as `Yumeko identity` / `Yumeko Look "Rain Coat"`. */
function nameOfLabel(label: string): string {
  const m = /^(.*?)\s+(?:identity|Look)\b/.exec(label);
  return m?.[1] ?? "";
}

/**
 * Deterministic, provider-safe tags (3–16 chars, start with a letter, letters/digits/underscore only, unique).
 * Role + subject: ProductionFrame · Storyboard · YumekoIdentity · YumekoLook · LocationView · Location · Lighting ·
 * ShotRef.
 * Provider tag syntax stays inside this adapter: nothing here leaks into the GenerationPackage or the domain.
 */
export function runwayImageTags(refs: readonly Pick<ResolvedImageReference, "role" | "label">[]): string[] {
  const used = new Set<string>();
  return refs.map((r) => {
    const subject = wordsOf(nameOfLabel(r.label)).join("");
    const suffix = r.role === "identity" ? "Identity" : r.role === "character_look" ? "Look" : "";
    let base = TAG_BASE[r.role] ?? `${subject}${suffix}`;
    if (!TAG_BASE[r.role]) {
      const room = Math.max(1, 16 - suffix.length);
      base = `${subject.slice(0, room)}${suffix}`;
    }
    if (!/^[A-Za-z]/.test(base)) base = `Ref${base}`;
    if (base.length < 3) base = `${base}Ref`.slice(0, 16);
    let tag = base.slice(0, 16);
    for (let n = 2; used.has(tag); n += 1) {
      const tail = String(n);
      tag = `${base.slice(0, 16 - tail.length)}${tail}`;
    }
    used.add(tag);
    return tag;
  });
}

// ───────────────────────── request body ─────────────────────────

export interface BuiltImageCall {
  body: Params;
  /** Tags sent per reference (null for models that address references by order). */
  tags: Array<string | null>;
}

/** The exact SDK request body for a validated still-image request. */
export function buildImageCall(
  model: CatalogModel,
  request: GenerationRequest,
  promptText: string,
  refs: readonly ResolvedImageReference[],
): BuiltImageCall {
  const ratio = imageRatioFor(model, request);
  if (!ratio) throw new Error(`No provider canvas for ${request.aspectRatio ?? "an unset aspect"}`);
  switch (model.modelId as RunwayImageModelId) {
    case "gpt_image_2_5_flare": {
      const r = pick(GPT_IMAGE_RATIOS, ratio);
      if (!r) throw new Error(`Ratio ${ratio} is not a typed canvas for ${model.modelId}`);
      const quality = pick(GPT_IMAGE_QUALITIES, imageQualityFor(model, request));
      const tags = runwayImageTags(refs);
      const body: GptParams = {
        model: "gpt_image_2_5_flare",
        promptText,
        ratio: r,
        outputCount: IMAGE_OUTPUT_COUNT,
        // explicit, never the provider's hidden default (which is `high`)
        ...(quality ? { quality } : {}),
        ...(refs.length > 0 ? { referenceImages: refs.map((x, i) => ({ uri: x.uri, tag: tags[i]! })) } : {}),
      };
      return { body, tags };
    }
    case "muse_image": {
      const r = pick(MUSE_IMAGE_RATIOS, ratio);
      if (!r) throw new Error(`Ratio ${ratio} is not a typed canvas for ${model.modelId}`);
      const body: MuseParams = {
        model: "muse_image",
        promptText,
        ratio: r,
        outputCount: IMAGE_OUTPUT_COUNT,
        outputFormat: "png",
        ...(refs.length > 0 ? { referenceImages: refs.map((x) => ({ uri: x.uri })) } : {}),
      };
      return { body, tags: refs.map(() => null) };
    }
    case "seedream5_lite": {
      const body: SeedreamParams = {
        model: "seedream5_lite",
        promptText,
        ratio,
        outputCount: IMAGE_OUTPUT_COUNT,
        outputFormat: "png",
        ...(refs.length > 0 ? { referenceImages: refs.map((x) => ({ uri: x.uri })) } : {}),
      };
      return { body, tags: refs.map(() => null) };
    }
    default:
      throw new Error(`Unsupported Runway image model ${model.modelId}`);
  }
}

/** One legend line per reference so the model is never asked to infer which image is which. */
export function referenceLegend(
  model: CatalogModel,
  refs: readonly Pick<ResolvedImageReference, "role" | "label">[],
  tags: readonly (string | null)[],
): string {
  if (refs.length === 0) return "";
  const addressing = model.image?.referenceAddressing ?? "none";
  const lines = refs.map((r, i) => {
    const what = r.label;
    return addressing === "tags" && tags[i]
      ? `@${tags[i]} is ${what}.`
      : addressing === "order"
        ? `${model.family === "seedream" ? "Figure" : "Reference image"} ${i + 1} is ${what}.`
        : `${what}.`;
  });
  return `References: ${lines.join(" ")}`;
}

/** Model-aware request validation for still images. Messages are stable (tests and UI quote them). */
export function validateImageRequest(model: CatalogModel, request: GenerationRequest): string[] {
  const errors: string[] = [];
  const name = model.displayName;
  if (!model.modalities.includes(request.modality)) {
    errors.push(`${name} does not support ${request.modality.replace(/_/g, "-")}.`);
  }
  if (model.availability === "retired" || model.availability === "unavailable") {
    errors.push(`${name} is not available (${model.availabilityNote || model.availability}).`);
  }
  if (request.startFrameAssetId || request.endFrameAssetId) {
    errors.push("A still-image request takes reference images, not start/end frames.");
  }
  if (request.audioAssetIds.length > 0) errors.push(`${name} takes no audio input.`);
  const refs = request.references.length;
  const max = model.inputs.maxReferenceImages;
  if (max != null && refs > max) {
    errors.push(`${name} accepts at most ${max} reference images; got ${refs}.`);
  }
  if (request.modality === "text_to_image" && refs > 0) {
    errors.push("References need image-to-image for this request.");
  }
  if (request.modality === "image_to_image" && refs === 0) {
    errors.push("Image-to-image needs at least one reference image.");
  }
  const ratio = imageRatioFor(model, request);
  if (!ratio) {
    errors.push(
      `Aspect ratio ${request.aspectRatio ?? "(unset)"} is not available for ${name} (offers ${model.aspectRatios.join(", ")}).`,
    );
  }
  const q = request.providerOptions?.quality;
  if (typeof q === "string" && !model.image?.qualities.some((x) => x.id === q)) {
    errors.push(
      model.image && model.image.qualities.length > 0
        ? `${name} has no ${q} quality (offers ${model.image.qualities.map((x) => x.id).join(", ")}).`
        : `${name} has no quality option.`,
    );
  }
  if (!request.prompt.positive.trim()) errors.push("The prompt is empty.");
  return errors;
}
