import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import { START_FRAME_TRANSPORT_POLICY, containPadGeometry } from "@/domain/framing/transport";
import type { AssetBytes } from "../../provider";

const exec = promisify(execFile);

// The frozen metadata and the contain geometry are pure domain facts (delivery conform needs them too).
export {
  PREPAD_CENTER_CROP_POLICY,
  prepadTransportErrors,
  START_FRAME_TRANSPORT_POLICY as RUNWAY_START_FRAME_TRANSPORT_POLICY,
  parseFrozenStartFrameTransport as parseFrozenRunwayStartFrameTransport,
  containPadGeometry,
  type FrozenStartFrameTransport as FrozenRunwayStartFrameTransport,
} from "@/domain/framing/transport";

export interface RunwayStartFrameTransportSpec {
  targetCanvas: { width: number; height: number };
  aspectRange: { min: number; max: number };
  /**
   * `contain-prepad-center-crop-v1`: the frozen placement of the uniformly scaled picture on the submitted canvas.
   * Absent = centred (`contain-pad-v1`). The scale is always the contain scale; a placement whose size differs is refused.
   */
  placement?: { width: number; height: number; x: number; y: number };
  /** The canonical dimensions the frozen record was planned from; refused when the stored bytes differ. */
  expectedSource?: { width: number; height: number };
}

export interface RunwayStartFrameTransportResult {
  asset: AssetBytes;
  policy: typeof START_FRAME_TRANSPORT_POLICY;
  applied: boolean;
  source: { width: number; height: number; aspect: number };
  target: { width: number; height: number; aspect: number };
  content: { width: number; height: number; x: number; y: number; scaled: boolean };
}

export type RunwayStartFrameTransport = (
  asset: AssetBytes,
  spec: RunwayStartFrameTransportSpec,
) => Promise<RunwayStartFrameTransportResult>;

function extension(mime: string | null, filename: string): string {
  const fromName = extname(filename).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp"].includes(fromName)) return fromName;
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/webp") return ".webp";
  return ".png";
}

async function probe(file: string): Promise<{ width: number; height: number }> {
  const { stdout } = await exec(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", file],
    { maxBuffer: 1024 * 1024 },
  );
  const parsed = JSON.parse(stdout) as { streams?: Array<{ width?: number; height?: number }> };
  const width = parsed.streams?.[0]?.width;
  const height = parsed.streams?.[0]?.height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || !width || !height) {
    throw new Error("Could not determine first-frame dimensions.");
  }
  return { width, height };
}

/**
 * Provider-only transport adaptation for an animation start frame.
 *
 * The canonical Production Frame is never changed or replaced. When its canvas differs from the Runway canvas,
 * Prism uniformly scales the complete frame to CONTAIN inside the provider canvas (up or down as needed), then
 * center-pads only the remaining axis. No source composition is cropped. This avoids Runway's implicit center-crop
 * while satisfying its documented prompt-image aspect bounds. The provider output is still conformed back to the
 * production frame by the existing delivery plan.
 */
export const ffmpegRunwayStartFrameTransport: RunwayStartFrameTransport = async (asset, spec) => {
  const target = spec.targetCanvas;
  if (
    !Number.isInteger(target.width) ||
    !Number.isInteger(target.height) ||
    target.width < 2 ||
    target.height < 2
  ) {
    throw new Error("Invalid provider transport canvas.");
  }
  const targetAspect = target.width / target.height;
  if (targetAspect < spec.aspectRange.min || targetAspect > spec.aspectRange.max) {
    throw new Error("Provider transport canvas is outside the documented prompt-image aspect range.");
  }

  const dir = await mkdtemp(join(tmpdir(), "prism-runway-frame-"));
  const input = join(dir, `input${extension(asset.mime, asset.filename)}`);
  const output = join(dir, "transport.png");
  try {
    await writeFile(input, asset.bytes);
    const source = await probe(input);
    const sourceAspect = source.width / source.height;
    if (
      spec.expectedSource &&
      (spec.expectedSource.width !== source.width || spec.expectedSource.height !== source.height)
    ) {
      throw new Error("The start frame's dimensions differ from the frozen transport record.");
    }

    if (!spec.placement && source.width === target.width && source.height === target.height) {
      return {
        asset,
        policy: START_FRAME_TRANSPORT_POLICY,
        applied: false,
        source: { ...source, aspect: sourceAspect },
        target: { ...target, aspect: targetAspect },
        content: { width: source.width, height: source.height, x: 0, y: 0, scaled: false },
      };
    }

    const contained = containPadGeometry(source, target);
    const p = spec.placement;
    if (
      p &&
      (p.width !== contained.width ||
        p.height !== contained.height ||
        p.x < 0 ||
        p.y < 0 ||
        p.x + p.width > target.width ||
        p.y + p.height > target.height)
    ) {
      throw new Error(
        "The frozen transport placement does not match the uniform contain scale of this frame.",
      );
    }
    const geometry = p ? { ...contained, x: p.x, y: p.y } : contained;
    const { width, height, x, y, scaled } = geometry;

    const filters = [
      ...(scaled ? [`scale=${width}:${height}:flags=lanczos`] : []),
      `pad=${target.width}:${target.height}:${x}:${y}:color=black`,
      "setsar=1",
    ].join(",");

    await exec(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        input,
        "-vf",
        filters,
        "-frames:v",
        "1",
        "-c:v",
        "png",
        output,
      ],
      { maxBuffer: 2 * 1024 * 1024 },
    );
    const bytes = new Uint8Array(await readFile(output));
    const actual = await probe(output);
    if (actual.width !== target.width || actual.height !== target.height) {
      throw new Error("First-frame transport output has the wrong dimensions.");
    }
    return {
      asset: { bytes, mime: "image/png", filename: "runway-start-frame-transport.png" },
      policy: START_FRAME_TRANSPORT_POLICY,
      applied: true,
      source: { ...source, aspect: sourceAspect },
      target: { ...target, aspect: targetAspect },
      content: geometry,
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
};
