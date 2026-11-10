import type { Rect } from "./crop";
import type { Size } from "./ratio";

/**
 * Provider-only start-frame transport geometry (Phase 5B), pure: no Node, no FFmpeg, no provider SDK.
 *
 * When a provider's prompt-image contract cannot take the canonical Production Frame directly, the immutable request
 * freezes a transport policy (`providerOptions.prismStartFrameTransport`). The canonical frame is uniformly CONTAINED
 * on the provider canvas and only the remaining axis is padded. That placement is a pure function of the frozen policy,
 * the provider canvas and the canonical source dimensions, so downstream delivery can remove exactly the transport
 * padding instead of re-deriving a nearly equivalent crop (which, rounded to even offsets, left a 1 px padding row).
 */
export const START_FRAME_TRANSPORT_POLICY = "contain-pad-v1" as const;

/**
 * `contain-prepad-center-crop-v1` (Phase 5B, Gen-4.5): for a model whose documented prompt-image aspect range is
 * narrower than the requested output canvas (e.g. Gen-4.5: 0.5–2.0 vs 1584×672 ≈ 2.357), AND whose provider documents
 * that a mismatched prompt image is centre-cropped to the requested ratio. The complete canonical frame is uniformly
 * scaled exactly as `contain-pad-v1` would place it on the OUTPUT canvas, then submitted on a larger, in-range canvas
 * with symmetric synthetic padding, positioned so the provider's documented centre crop removes synthetic padding only
 * and reproduces the `contain-pad-v1` effective geometry. Every number is frozen; nothing is re-derived implicitly.
 */
export const PREPAD_CENTER_CROP_POLICY = "contain-prepad-center-crop-v1" as const;
export type StartFrameTransportPolicy =
  typeof START_FRAME_TRANSPORT_POLICY | typeof PREPAD_CENTER_CROP_POLICY;

/** A provider-documented fact: how a prompt image whose aspect differs from the requested ratio is fitted. */
export interface ProviderPromptImageCrop {
  behavior: "center";
  /** Where the behaviour is documented, and when Prism verified it. */
  source: string;
  verifiedAt: string;
}

export interface FrozenContainPadTransport {
  version: 1;
  policy: typeof START_FRAME_TRANSPORT_POLICY;
  sourceAssetId: string;
  targetCanvas: Size;
  background: "black";
}

export interface PrepadCenterCropGeometry {
  /** 1. The canonical Production Frame's stored dimensions (never modified). */
  source: Size;
  /** 2. The complete source, uniformly scaled (no crop). */
  content: Size;
  /** 3. The prompt image actually submitted (inside the provider's documented input range). */
  submittedCanvas: Size;
  /** 4. Where the scaled picture sits inside the submitted image. */
  submittedOffset: { x: number; y: number };
  /** 5. The provider's documented handling of the mismatched input. */
  providerCrop: ProviderPromptImageCrop;
  /** 6. The requested output canvas (the verified provider canvas for the requested ratio). */
  outputCanvas: Size;
  /** 7. The crop the provider is documented to apply, in submitted-image pixels. */
  expectedCrop: Rect;
  /** 8. Where the picture sits in the provider's effective frame after that crop (= delivery's transport rect). */
  effectiveContent: Rect;
}

export interface FrozenPrepadCenterCropTransport extends PrepadCenterCropGeometry {
  version: 1;
  policy: typeof PREPAD_CENTER_CROP_POLICY;
  sourceAssetId: string;
  background: "black";
}

export type FrozenStartFrameTransport = FrozenContainPadTransport | FrozenPrepadCenterCropTransport;

const isInt = (n: unknown): n is number => Number.isInteger(n);
const sizeOf = (raw: unknown): Size | null => {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return isInt(r.width) && isInt(r.height) && r.width >= 2 && r.height >= 2
    ? { width: r.width, height: r.height }
    : null;
};
const rectOf = (raw: unknown): Rect | null => {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return isInt(r.x) &&
    isInt(r.y) &&
    isInt(r.width) &&
    isInt(r.height) &&
    r.x >= 0 &&
    r.y >= 0 &&
    r.width > 0 &&
    r.height > 0
    ? { x: r.x, y: r.y, width: r.width, height: r.height }
    : null;
};

function parsePrepad(r: Record<string, unknown>): FrozenPrepadCenterCropTransport | null {
  const source = sizeOf(r.source);
  const content = sizeOf(r.content);
  const submittedCanvas = sizeOf(r.submittedCanvas);
  const outputCanvas = sizeOf(r.outputCanvas);
  const expectedCrop = rectOf(r.expectedCrop);
  const effectiveContent = rectOf(r.effectiveContent);
  const off =
    r.submittedOffset && typeof r.submittedOffset === "object"
      ? (r.submittedOffset as Record<string, unknown>)
      : null;
  const crop =
    r.providerCrop && typeof r.providerCrop === "object" ? (r.providerCrop as Record<string, unknown>) : null;
  if (
    !source ||
    !content ||
    !submittedCanvas ||
    !outputCanvas ||
    !expectedCrop ||
    !effectiveContent ||
    !off ||
    !isInt(off.x) ||
    !isInt(off.y) ||
    off.x < 0 ||
    off.y < 0 ||
    !crop ||
    crop.behavior !== "center" ||
    typeof crop.source !== "string" ||
    typeof crop.verifiedAt !== "string"
  )
    return null;
  return {
    version: 1,
    policy: PREPAD_CENTER_CROP_POLICY,
    sourceAssetId: r.sourceAssetId as string,
    background: "black",
    source,
    content,
    submittedCanvas,
    submittedOffset: { x: off.x, y: off.y },
    providerCrop: { behavior: "center", source: crop.source, verifiedAt: crop.verifiedAt },
    outputCanvas,
    expectedCrop,
    effectiveContent,
  };
}

export function parseFrozenStartFrameTransport(raw: unknown): FrozenStartFrameTransport | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (
    r.version === 1 &&
    r.policy === PREPAD_CENTER_CROP_POLICY &&
    typeof r.sourceAssetId === "string" &&
    r.sourceAssetId &&
    r.background === "black"
  )
    return parsePrepad(r);
  const canvas =
    r.targetCanvas && typeof r.targetCanvas === "object" ? (r.targetCanvas as Record<string, unknown>) : null;
  if (
    r.version !== 1 ||
    r.policy !== START_FRAME_TRANSPORT_POLICY ||
    typeof r.sourceAssetId !== "string" ||
    !r.sourceAssetId ||
    r.background !== "black" ||
    !canvas ||
    !Number.isInteger(canvas.width) ||
    !Number.isInteger(canvas.height) ||
    Number(canvas.width) < 2 ||
    Number(canvas.height) < 2
  ) {
    return null;
  }
  return {
    version: 1,
    policy: START_FRAME_TRANSPORT_POLICY,
    sourceAssetId: r.sourceAssetId,
    targetCanvas: { width: Number(canvas.width), height: Number(canvas.height) },
    background: "black",
  };
}

const evenFloor = (n: number) => Math.max(2, Math.floor(n / 2) * 2);

/** `contain-pad-v1`: the complete source, uniformly scaled to fit, centred; only the remaining axis is padded. */
export function containPadGeometry(
  source: Size,
  target: Size,
): { width: number; height: number; x: number; y: number; scaled: boolean } {
  const scale = Math.min(target.width / source.width, target.height / source.height);
  const width = evenFloor(source.width * scale);
  const height = evenFloor(source.height * scale);
  const x = Math.floor((target.width - width) / 2);
  const y = Math.floor((target.height - height) / 2);
  if (x < 0 || y < 0) throw new Error("First frame does not fit the provider transport canvas.");
  return {
    width,
    height,
    x,
    y,
    scaled: width !== source.width || height !== source.height,
  };
}

const inside = (inner: Rect, outer: Rect) =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height;

export type PrepadPlan = { ok: true; geometry: PrepadCenterCropGeometry } | { ok: false; reason: string };

/**
 * Plans `contain-prepad-center-crop-v1`, or explains why it cannot be used. Pure and deterministic. Refuses unless
 * EVERY invariant is proven: the provider documents a centre crop; the output canvas is outside the documented input
 * range (otherwise the plain `contain-pad-v1` applies); the submitted image is inside the range; the centre crop is an
 * exact integer rectangle; it removes synthetic padding only (zero picture pixels); the picture is complete and lands
 * exactly where `contain-pad-v1` would place it on the output canvas.
 */
export function planPrepadCenterCrop(args: {
  source: Size;
  outputCanvas: Size;
  aspectRange: { min: number; max: number } | null | undefined;
  providerCrop: ProviderPromptImageCrop | null | undefined;
}): PrepadPlan {
  const { source, outputCanvas: out, aspectRange: range, providerCrop } = args;
  if (!providerCrop || providerCrop.behavior !== "center")
    return { ok: false, reason: "The provider does not document a centre crop of mismatched prompt images." };
  if (!range) return { ok: false, reason: "The provider documents no prompt-image aspect range." };
  if (!(source.width > 0 && source.height > 0 && out.width >= 2 && out.height >= 2))
    return { ok: false, reason: "Source or output dimensions are unknown." };
  const outAspect = out.width / out.height;
  if (outAspect >= range.min && outAspect <= range.max)
    return {
      ok: false,
      reason: "The output canvas is already inside the prompt-image range (contain-pad-v1 applies).",
    };

  // the picture exactly as contain-pad-v1 places it on the OUTPUT canvas (the validated effective geometry)
  const onOutput = containPadGeometry(source, out);
  let submitted: Size;
  if (outAspect > range.max) {
    // too wide: keep the output width, add symmetric synthetic rows (even total, so the centre crop is exact)
    let h = Math.max(out.height, Math.ceil(out.width / range.max));
    if ((h - out.height) % 2 !== 0) h += 1;
    submitted = { width: out.width, height: h };
  } else {
    // too narrow: keep the output height, add symmetric synthetic columns
    let w = Math.max(out.width, Math.ceil(out.height * range.min));
    if ((w - out.width) % 2 !== 0) w += 1;
    submitted = { width: w, height: out.height };
  }
  const subAspect = submitted.width / submitted.height;
  if (subAspect < range.min || subAspect > range.max)
    return {
      ok: false,
      reason: "No submitted canvas inside the documented prompt-image range keeps the output size.",
    };
  const expectedCrop: Rect = {
    x: (submitted.width - out.width) / 2,
    y: (submitted.height - out.height) / 2,
    width: out.width,
    height: out.height,
  };
  const submittedOffset = { x: expectedCrop.x + onOutput.x, y: expectedCrop.y + onOutput.y };
  const effectiveContent: Rect = {
    x: onOutput.x,
    y: onOutput.y,
    width: onOutput.width,
    height: onOutput.height,
  };
  const pictureInSubmitted: Rect = { ...submittedOffset, width: onOutput.width, height: onOutput.height };
  // the scale must not depend on which canvas the picture is contained in (one uniform scale, no crop)
  const onSubmitted = containPadGeometry(source, submitted);
  if (onSubmitted.width !== onOutput.width || onSubmitted.height !== onOutput.height)
    return { ok: false, reason: "The picture would be scaled differently on the submitted canvas." };
  if (!inside(pictureInSubmitted, { x: 0, y: 0, ...submitted }))
    return { ok: false, reason: "The picture does not fit the submitted canvas." };
  if (!inside(pictureInSubmitted, expectedCrop))
    return { ok: false, reason: "The provider's centre crop would cut picture pixels." };
  if (!inside(effectiveContent, { x: 0, y: 0, ...out }))
    return { ok: false, reason: "The picture would not lie inside the provider output." };
  return {
    ok: true,
    geometry: {
      source: { ...source },
      content: { width: onOutput.width, height: onOutput.height },
      submittedCanvas: submitted,
      submittedOffset,
      providerCrop: { ...providerCrop },
      outputCanvas: { ...out },
      expectedCrop,
      effectiveContent,
    },
  };
}

/** Problems with a frozen prepad record, re-derived from its own source and output (empty = consistent). */
export function prepadTransportErrors(
  t: FrozenPrepadCenterCropTransport,
  aspectRange: { min: number; max: number } | null | undefined,
  providerCrop: ProviderPromptImageCrop | null | undefined,
): string[] {
  const plan = planPrepadCenterCrop({
    source: t.source,
    outputCanvas: t.outputCanvas,
    aspectRange,
    providerCrop,
  });
  if (!plan.ok) return [plan.reason];
  const g = plan.geometry;
  const same =
    JSON.stringify([g.content, g.submittedCanvas, g.submittedOffset, g.expectedCrop, g.effectiveContent]) ===
      JSON.stringify([t.content, t.submittedCanvas, t.submittedOffset, t.expectedCrop, t.effectiveContent]) &&
    t.providerCrop.behavior === g.providerCrop.behavior &&
    t.providerCrop.source === g.providerCrop.source &&
    t.providerCrop.verifiedAt === g.providerCrop.verifiedAt;
  return same ? [] : ["The frozen pre-pad transport geometry does not match its own re-derivation."];
}

/** Where the canonical picture sits on the provider canvas (pixels), for a request that used a transport. */
export interface ProviderTransportGeometry {
  policy: StartFrameTransportPolicy;
  sourceAssetId: string;
  canvas: Size;
  content: Rect;
}

/**
 * The transport geometry an attempt's frozen request implies, or null when it used no transport or the geometry
 * cannot be proven: the frozen source must be one of the attempt's own inputs and its stored dimensions known.
 */
export function attemptTransportGeometry(args: {
  providerOptions: unknown;
  inputAssetIds: readonly string[];
  sourceSize: (assetId: string) => Size | null;
}): ProviderTransportGeometry | null {
  const opts =
    args.providerOptions && typeof args.providerOptions === "object"
      ? (args.providerOptions as Record<string, unknown>)
      : null;
  const frozen = parseFrozenStartFrameTransport(opts?.prismStartFrameTransport);
  if (!frozen || !args.inputAssetIds.includes(frozen.sourceAssetId)) return null;
  const source = args.sourceSize(frozen.sourceAssetId);
  if (!source || !(source.width > 0) || !(source.height > 0)) return null;
  if (frozen.policy === PREPAD_CENTER_CROP_POLICY) {
    // the stored source must be the frozen one, and the frozen effective rect must be its own re-derivation
    if (source.width !== frozen.source.width || source.height !== frozen.source.height) return null;
    const onOutput = containPadGeometry(source, frozen.outputCanvas);
    const e = frozen.effectiveContent;
    if (
      e.x !== onOutput.x ||
      e.y !== onOutput.y ||
      e.width !== onOutput.width ||
      e.height !== onOutput.height
    )
      return null;
    if (
      frozen.submittedOffset.x - frozen.expectedCrop.x !== e.x ||
      frozen.submittedOffset.y - frozen.expectedCrop.y !== e.y
    )
      return null;
    return {
      policy: frozen.policy,
      sourceAssetId: frozen.sourceAssetId,
      canvas: frozen.outputCanvas,
      content: { ...e },
    };
  }
  const g = containPadGeometry(source, frozen.targetCanvas);
  return {
    policy: frozen.policy,
    sourceAssetId: frozen.sourceAssetId,
    canvas: frozen.targetCanvas,
    content: { x: g.x, y: g.y, width: g.width, height: g.height },
  };
}
