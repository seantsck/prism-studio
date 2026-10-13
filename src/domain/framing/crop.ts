import { RATIO_TOLERANCE, sameRatio, type Size } from "./ratio";

/** Axis-aligned pixel rectangle in a canvas (origin top-left). */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type CropAxis = "none" | "vertical" | "horizontal";

export interface CropResult {
  rect: Rect;
  /** Which axis lost pixels: "vertical" = top/bottom removed (e.g. 16:9 → 2.39:1). */
  axis: CropAxis;
  /** 0..1 share of the canvas AREA that is discarded. */
  discardedFraction: number;
  /** width / height of the retained rectangle (differs slightly from the target after even-rounding). */
  actualRatio: number;
}

/** Codecs (yuv420) need even dimensions and even offsets. */
const evenRound = (n: number) => Math.max(2, 2 * Math.round(n / 2));

/**
 * Largest centred crop of `canvas` with aspect ratio `target`, in integer, even pixels. Never larger than
 * the canvas and never off-canvas. A canvas that already has the target ratio is returned whole.
 */
export function centerCrop(canvas: Size, target: number): CropResult {
  const { width: W, height: H } = canvas;
  if (!(W > 0) || !(H > 0) || !(target > 0)) throw new Error("centerCrop needs a positive canvas and ratio");
  const canvasRatio = W / H;
  if (sameRatio(canvasRatio, target, RATIO_TOLERANCE)) {
    return {
      rect: { x: 0, y: 0, width: W, height: H },
      axis: "none",
      discardedFraction: 0,
      actualRatio: canvasRatio,
    };
  }
  if (canvasRatio > target) {
    // canvas is wider than the target: remove left/right
    const width = Math.min(W, evenRound(H * target));
    const x = Math.floor((W - width) / 4) * 2;
    return {
      rect: { x, y: 0, width, height: H },
      axis: "horizontal",
      discardedFraction: 1 - width / W,
      actualRatio: width / H,
    };
  }
  const height = Math.min(H, evenRound(W / target));
  const y = Math.floor((H - height) / 4) * 2;
  return {
    rect: { x: 0, y, width: W, height },
    axis: "vertical",
    discardedFraction: 1 - height / H,
    actualRatio: W / height,
  };
}

export interface PadResult {
  /** The production-shaped frame the picture is placed in. */
  frame: Size;
  /** Where the (unscaled) provider picture sits inside `frame`. */
  placement: Rect;
  /** "letterbox" = bars top/bottom, "pillarbox" = bars left/right, "none" = same ratio. */
  mode: "none" | "letterbox" | "pillarbox";
  /** 0..1 share of the frame area that is black bars. */
  barFraction: number;
}

/**
 * Fit the whole provider picture inside a production-ratio frame by padding (no cropping, no scaling).
 * Provider wider than production → letterbox; provider narrower → pillarbox.
 */
export function padToFrame(canvas: Size, target: number): PadResult {
  const { width: W, height: H } = canvas;
  const canvasRatio = W / H;
  if (sameRatio(canvasRatio, target, RATIO_TOLERANCE)) {
    return {
      frame: { width: W, height: H },
      placement: { x: 0, y: 0, width: W, height: H },
      mode: "none",
      barFraction: 0,
    };
  }
  if (canvasRatio > target) {
    const height = evenRound(W / target);
    const y = Math.floor((height - H) / 4) * 2;
    return {
      frame: { width: W, height },
      placement: { x: 0, y, width: W, height: H },
      mode: "letterbox",
      barFraction: 1 - H / height,
    };
  }
  const width = evenRound(H * target);
  const x = Math.floor((width - W) / 4) * 2;
  return {
    frame: { width, height: H },
    placement: { x, y: 0, width: W, height: H },
    mode: "pillarbox",
    barFraction: 1 - W / width,
  };
}

/** A crop that throws away more than this share of the picture is "unreasonable" and is blocked. */
export const MAX_REASONABLE_DISCARD = 0.6;

/** A crop expressed as 0..1 fractions of the canvas, resolution-independent (used for previews/plans). */
export function normalizeRect(rect: Rect, canvas: Size): Rect {
  const r = (n: number) => Number(n.toFixed(5));
  return {
    x: r(rect.x / canvas.width),
    y: r(rect.y / canvas.height),
    width: r(rect.width / canvas.width),
    height: r(rect.height / canvas.height),
  };
}
