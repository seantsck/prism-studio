import type { RgbaImage } from "./png";

/**
 * Phase 5B-I3: the provider-neutral MATTING boundary. An engine looks at an image and returns ONLY an alpha matte
 * (0 = background, 255 = subject, values between = soft edge). It never returns pixels: `composeCutout` keeps every
 * source RGB value and only replaces alpha, so a cutout can never redraw a face, hair, wardrobe or props.
 *
 * Engines:
 *   plain-background-keyer-1   Prism's own deterministic keyer for plain / studio backgrounds (in this file's sibling).
 *   (pending owner + legal decision) an ONNX segmentation/matting model such as BiRefNet-matting, behind the same
 *   interface: see docs/phase-5b-i3-background-removal.md.
 */
export interface MatteResult {
  /** width × height bytes. */
  alpha: Uint8Array;
  /** "soft": continuous alpha at edges; "binary": 0/255 only. */
  kind: "soft" | "binary";
  /** Facts worth recording in provenance (thresholds, estimated background, coverage). */
  details: Record<string, unknown>;
}

export class MattingRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface MattingEngine {
  id: string;
  version: string;
  displayName: string;
  /** The engine's own license (and its weights' license, if any). */
  license: string;
  /** Deterministic: the same input always gives the same matte. */
  deterministic: boolean;
  /** Throws MattingRefusal when the image is outside what the engine can do well (never a silent bad cutout). */
  matte(image: RgbaImage): MatteResult;
}

/**
 * The cutout: the source's RGB, untouched, with the matte as alpha. A pixel that was already transparent in the source
 * stays at least as transparent (min of both alphas).
 */
export function composeCutout(source: RgbaImage, matte: MatteResult): RgbaImage {
  const n = source.width * source.height;
  if (matte.alpha.length !== n) throw new Error("Matte size does not match the image.");
  const data = new Uint8Array(source.data);
  for (let i = 0; i < n; i++) data[i * 4 + 3] = Math.min(source.data[i * 4 + 3]!, matte.alpha[i]!);
  return { width: source.width, height: source.height, data };
}

/** Share of pixels by alpha band (for provenance and the review UI). */
export function alphaCoverage(alpha: Uint8Array): { opaque: number; transparent: number; soft: number } {
  let o = 0;
  let t = 0;
  for (const a of alpha) {
    if (a === 255) o++;
    else if (a === 0) t++;
  }
  const n = alpha.length || 1;
  const r = (x: number) => Math.round((x / n) * 10_000) / 10_000;
  return { opaque: r(o), transparent: r(t), soft: r(n - o - t) };
}
