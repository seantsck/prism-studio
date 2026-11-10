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

export interface FrozenStartFrameTransport {
  version: 1;
  policy: typeof START_FRAME_TRANSPORT_POLICY;
  sourceAssetId: string;
  targetCanvas: Size;
  background: "black";
}

export function parseFrozenStartFrameTransport(raw: unknown): FrozenStartFrameTransport | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
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

/** Where the canonical picture sits on the provider canvas (pixels), for a request that used a transport. */
export interface ProviderTransportGeometry {
  policy: typeof START_FRAME_TRANSPORT_POLICY;
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
  const g = containPadGeometry(source, frozen.targetCanvas);
  return {
    policy: frozen.policy,
    sourceAssetId: frozen.sourceAssetId,
    canvas: frozen.targetCanvas,
    content: { x: g.x, y: g.y, width: g.width, height: g.height },
  };
}
