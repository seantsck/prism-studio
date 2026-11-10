import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import type { AssetBytes } from "../../provider";

const exec = promisify(execFile);

export const RUNWAY_START_FRAME_TRANSPORT_POLICY = "contain-pad-v1" as const;

export interface FrozenRunwayStartFrameTransport {
  version: 1;
  policy: typeof RUNWAY_START_FRAME_TRANSPORT_POLICY;
  sourceAssetId: string;
  targetCanvas: { width: number; height: number };
  background: "black";
}

export function parseFrozenRunwayStartFrameTransport(raw: unknown): FrozenRunwayStartFrameTransport | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const canvas =
    r.targetCanvas && typeof r.targetCanvas === "object" ? (r.targetCanvas as Record<string, unknown>) : null;
  if (
    r.version !== 1 ||
    r.policy !== RUNWAY_START_FRAME_TRANSPORT_POLICY ||
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
    policy: RUNWAY_START_FRAME_TRANSPORT_POLICY,
    sourceAssetId: r.sourceAssetId,
    targetCanvas: { width: Number(canvas.width), height: Number(canvas.height) },
    background: "black",
  };
}

export interface RunwayStartFrameTransportSpec {
  targetCanvas: { width: number; height: number };
  aspectRange: { min: number; max: number };
}

export interface RunwayStartFrameTransportResult {
  asset: AssetBytes;
  policy: typeof RUNWAY_START_FRAME_TRANSPORT_POLICY;
  applied: boolean;
  source: { width: number; height: number; aspect: number };
  target: { width: number; height: number; aspect: number };
  content: { width: number; height: number; x: number; y: number; scaled: boolean };
}

export type RunwayStartFrameTransport = (
  asset: AssetBytes,
  spec: RunwayStartFrameTransportSpec,
) => Promise<RunwayStartFrameTransportResult>;

const evenFloor = (n: number) => Math.max(2, Math.floor(n / 2) * 2);

export function containPadGeometry(
  source: { width: number; height: number },
  target: { width: number; height: number },
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

    if (source.width === target.width && source.height === target.height) {
      return {
        asset,
        policy: RUNWAY_START_FRAME_TRANSPORT_POLICY,
        applied: false,
        source: { ...source, aspect: sourceAspect },
        target: { ...target, aspect: targetAspect },
        content: { width: source.width, height: source.height, x: 0, y: 0, scaled: false },
      };
    }

    const geometry = containPadGeometry(source, target);
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
      policy: RUNWAY_START_FRAME_TRANSPORT_POLICY,
      applied: true,
      source: { ...source, aspect: sourceAspect },
      target: { ...target, aspect: targetAspect },
      content: geometry,
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
};
