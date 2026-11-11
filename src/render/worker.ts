import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { derivedAssetId } from "@/media/delivery";
import { MediaError } from "@/media/types";
import type { Asset } from "@/domain/schemas";
import { safeFileName } from "@/lib/storage-paths";
import { FfmpegEpisodeRenderer, sniffRenderInput, type LocalSource } from "./ffmpeg-renderer";
import { resolveTitleFonts, titleFontIdentity, TitleFontError, type ResolvedFont } from "./fonts";
import { buildRenderPlan, pictureSourcesOf, RenderPlanError, type RenderPiece } from "./plan";
import {
  RENDER_LEASE_MS,
  RenderError,
  type ClaimedRender,
  type RenderOutput,
  type RenderStorage,
  type RenderWorkerStore,
} from "./repository";

/**
 * Phase 5B-V4 render worker: runs ONE claimed render at a time, ONE ffmpeg process at a time (segment concurrency 1:
 * correctness over speed). For a claimed render:
 *
 *   1. plan      the FROZEN manifest + profile → pieces (never the Edit tables; a later edit cannot reach this)
 *   2. sources   each source Asset of the render's own project, read from private storage into the job's temp dir and
 *                verified against the checksum the manifest froze (a changed source fails the render: nothing mixed)
 *   3. segments  per piece: a cached segment is REUSED when its record exists and both objects re-hash to the recorded
 *                checksums; otherwise rendered, stored under its deterministic key and recorded. Progress is durable
 *   4. assemble  the normalized pieces, in order, sequentially (concat)
 *   5. verify    ffprobe: H.264, the canvas, the rate, the exact frame count (= the manifest's timeline), AAC when sound
 *   6. complete  the MP4 becomes a NEW immutable private Asset (deterministic id per render: a retry never duplicates it)
 *
 * Any failure → `failed` with a short, path-free message; cached segments stay for the retry; no output Asset exists.
 * The job's temp directory is removed in `finally`, success or failure. The worker reads no provider credential.
 */

export interface RenderWorkerDeps {
  store: RenderWorkerStore;
  /** private object storage holding the sources, the segment cache and the output */
  storage: RenderStorage;
  /** how the output Asset row names that storage (local disk in memory mode, the private bucket in Supabase mode) */
  storageProvider: Asset["storageProvider"];
  bucket: string | null;
  renderer?: FfmpegEpisodeRenderer;
  workerId: string;
  now?: () => Date;
  tempRoot?: string;
  /** where the fonts are looked up (tests / hosted override); default = fontSearchDirs() */
  fontDirs?: string[];
  /** test seam: called before each piece is RENDERED (not reused); throw to simulate a crash mid-render */
  beforeRenderPiece?: (piece: RenderPiece, renderId: string) => void | Promise<void>;
  /** test seam: called after the plan is built (to change the Edit while this render runs) */
  afterPlan?: (renderId: string) => void | Promise<void>;
  logger?: (line: string) => void;
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** Where a project's cached segments live in private storage: inside the project's own prefix (Storage RLS). */
export const segmentObjectPath = (projectId: string, cacheKey: string, ext: "mp4" | "wav") =>
  `${projectId}/${derivedAssetId(`render-segment|${projectId}|${cacheKey}`)}/segment-${cacheKey.slice(0, 32)}.${ext}`;

export const renderOutputAssetId = (renderId: string) => derivedAssetId(`episode-render|${renderId}`);

export interface RenderRunResult {
  renderId: string;
  status: "completed" | "failed";
  rendered: number;
  reused: number;
  error?: string;
}

export class EpisodeRenderWorker {
  private readonly renderer: FfmpegEpisodeRenderer;
  private readonly now: () => Date;

  constructor(private readonly deps: RenderWorkerDeps) {
    this.renderer = deps.renderer ?? new FfmpegEpisodeRenderer();
    this.now = deps.now ?? (() => new Date());
  }

  private iso() {
    return this.now().toISOString();
  }

  /** Claims and runs the next render; null when nothing is queued. */
  async runOnce(): Promise<RenderRunResult | null> {
    const claimed = await this.deps.store.claimNext(this.deps.workerId, this.iso(), RENDER_LEASE_MS);
    if (!claimed) return null;
    return this.runClaimed(claimed);
  }

  /** Runs until nothing is queued (the inline / test loop). */
  async drain(): Promise<RenderRunResult[]> {
    const out: RenderRunResult[] = [];
    for (let r = await this.runOnce(); r; r = await this.runOnce()) out.push(r);
    return out;
  }

  private async runClaimed({ render, leaseToken }: ClaimedRender): Promise<RenderRunResult> {
    const { store, storage } = this.deps;
    const dir = await mkdtemp(path.join(this.deps.tempRoot ?? tmpdir(), "prism-render-"));
    let rendered = 0;
    let reused = 0;
    try {
      const profile = render.profile;
      const hasTitles = render.manifest.segments.some((s) => s.kind === "title");
      const fonts: { film: ResolvedFont; plain: ResolvedFont } | null = hasTitles
        ? await resolveTitleFonts(this.deps.fontDirs)
        : null;
      const plan = buildRenderPlan(render.manifest, profile, fonts ? titleFontIdentity(fonts) : null);
      await this.deps.afterPlan?.(render.id);

      // sources: every Asset the plan reads, verified against the frozen manifest checksums
      const local = new Map<string, LocalSource>();
      const frozen = new Map<string, string | null>();
      for (const piece of plan.pieces) {
        for (const pic of pictureSourcesOf(piece)) frozen.set(pic.assetId, pic.checksum);
        for (const a of piece.audio) if (!frozen.has(a.assetId)) frozen.set(a.assetId, a.checksum);
      }
      for (const [assetId, checksum] of frozen) {
        const ref = await store.source(render.projectId, assetId);
        if (!ref?.objectPath)
          throw new RenderRunError(
            "source_missing",
            `A source of this render no longer exists (Asset ${assetId}).`,
          );
        const bytes = await storage.get(ref.objectPath);
        if (!bytes)
          throw new RenderRunError(
            "source_missing",
            `A source file of this render cannot be read (Asset ${assetId}).`,
          );
        const actual = sha256(bytes);
        // the manifest froze the checksum (pictures); a take's audio is checked against its own Asset row
        const expected = checksum ?? ref.checksum;
        if (expected && expected !== actual)
          throw new RenderRunError(
            "source_changed",
            "A source file changed since this render was requested; render the current revision again.",
          );
        const kind = sniffRenderInput(bytes);
        if (!kind)
          throw new RenderRunError("source_unsupported", "A source file is not a supported media format.");
        const file = `src-${assetId}.${kind.ext}`;
        await writeFile(path.join(dir, file), bytes);
        let hasAudio = false;
        if (["wav", "ogg", "flac", "mp3"].includes(kind.ext)) hasAudio = true;
        else if (kind.ext === "mp4" || kind.ext === "webm")
          hasAudio = (await this.renderer.probe(dir, file)).audioCodec != null;
        local.set(assetId, { file, demuxer: kind.demuxer, hasAudio });
      }

      // segments
      const outs: Array<{ video: string; audio: string | null }> = [];
      for (const piece of plan.pieces) {
        const name = `p${String(piece.index).padStart(4, "0")}`;
        const cached = await this.reuse(render.projectId, piece.cacheKey, plan.hasAudio, dir, name);
        if (cached) {
          reused++;
          outs.push(cached);
        } else {
          await this.deps.beforeRenderPiece?.(piece, render.id);
          const video = await this.renderer.renderPicture(piece, profile, dir, name, local, fonts);
          const audio = plan.hasAudio ? await this.renderer.renderSound(piece, dir, name, local) : null;
          const vBytes = await readFile(path.join(dir, video));
          const aBytes = audio ? await readFile(path.join(dir, audio)) : null;
          const videoPath = segmentObjectPath(render.projectId, piece.cacheKey, "mp4");
          const audioPath = aBytes ? segmentObjectPath(render.projectId, piece.cacheKey, "wav") : null;
          await this.write(videoPath, vBytes, "video/mp4");
          if (aBytes && audioPath) await this.write(audioPath, aBytes, "audio/wav");
          await store.putSegment(
            {
              projectId: render.projectId,
              cacheKey: piece.cacheKey,
              videoPath,
              videoChecksum: sha256(vBytes),
              audioPath,
              audioChecksum: aBytes ? sha256(aBytes) : null,
              frames: piece.frames,
              samples: piece.samples,
            },
            this.iso(),
          );
          rendered++;
          outs.push({ video, audio });
        }
        await store.progress(render.id, leaseToken, { segmentsDone: piece.index + 1 }, this.iso());
      }

      // assemble + verify
      await store.progress(render.id, leaseToken, { status: "assembling" }, this.iso());
      const filename = safeFileName(render.outputFilename || `episode-render-${render.number}.mp4`);
      const final = await this.renderer.assemble(dir, outs, profile, plan.hasAudio, "final.mp4");
      await store.progress(render.id, leaseToken, { status: "verifying" }, this.iso());
      const probe = await this.renderer.probe(dir, final);
      const fps = `${profile.fps.num}/${profile.fps.den}`;
      const problems = [
        probe.videoCodec !== "h264" && `video codec ${probe.videoCodec}`,
        (probe.width !== profile.canvas.width || probe.height !== profile.canvas.height) &&
          `size ${probe.width}×${probe.height}`,
        probe.frameRate !== fps && `frame rate ${probe.frameRate}`,
        probe.frames !== plan.totalFrames && `${probe.frames} frames instead of ${plan.totalFrames}`,
        plan.hasAudio && probe.audioCodec !== "aac" && `audio ${probe.audioCodec ?? "missing"}`,
      ].filter(Boolean);
      if (problems.length)
        throw new RenderRunError(
          "verification_failed",
          `The final file did not verify: ${problems.join(", ")}.`,
        );
      const bytes = await readFile(path.join(dir, final));
      const checksum = sha256(bytes);
      const assetId = renderOutputAssetId(render.id);
      const objectPath = `${render.projectId}/${assetId}/${filename}`;
      await this.write(objectPath, bytes, "video/mp4");
      const durationMs = Math.round((plan.totalFrames * 1000 * profile.fps.den) / profile.fps.num);
      const now = this.iso();
      const asset: Asset = {
        id: assetId,
        projectId: render.projectId,
        createdBy: render.createdBy,
        type: "video",
        purpose: "episode_render",
        source: "derived",
        name: filename,
        originalFilename: filename,
        storageProvider: this.deps.storageProvider,
        bucket: this.deps.bucket,
        objectPath,
        mime: "video/mp4",
        byteSize: bytes.length,
        checksum,
        width: profile.canvas.width,
        height: profile.canvas.height,
        durationMs,
        frameRate: profile.fps.num / profile.fps.den,
        sampleRate: plan.hasAudio ? profile.audio.sampleRate : null,
        channels: plan.hasAudio ? profile.audio.channels : null,
        tags: ["episode-render"],
        notes: "",
        metadata: {
          renderId: render.id,
          renderNumber: render.number,
          editId: render.editId,
          editRevision: render.editRevision,
          manifestFingerprint: render.manifestFingerprint,
          stateFingerprint: render.stateFingerprint,
          profile: profile.id,
        },
        createdAt: now,
        updatedAt: now,
      };
      const output: RenderOutput = {
        assetId,
        filename,
        checksum,
        byteSize: bytes.length,
        durationMs,
        frames: probe.frames!,
        width: probe.width!,
        height: probe.height!,
        frameRate: probe.frameRate!,
        videoCodec: probe.videoCodec!,
        audioCodec: probe.audioCodec,
        segmentsReused: reused,
        segmentsRendered: rendered,
        toolVersion: await this.renderer.toolVersion(dir),
        fonts: fonts
          ? [fonts.film, fonts.plain].map((f) => ({ style: f.style, family: f.family, checksum: f.checksum }))
          : [],
      };
      await store.complete(render.id, leaseToken, asset, output, now);
      this.deps.logger?.(`render ${render.id} completed (${rendered} rendered, ${reused} reused)`);
      return { renderId: render.id, status: "completed", rendered, reused };
    } catch (err) {
      const { code, message } = describe(err);
      this.deps.logger?.(`render ${render.id} failed: ${code}`);
      await store.fail(render.id, leaseToken, { code, message }, this.iso()).catch((e: unknown) => {
        if (!(e instanceof RenderError)) throw e; // a lost lease: another worker owns it now
      });
      return { renderId: render.id, status: "failed", rendered, reused, error: message };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** A cached segment, verified byte-for-byte against its record; a bad entry is dropped (and re-rendered). */
  /**
   * Writes an object at a DETERMINISTIC path (a segment's cache key, a render's own output). Hosted Storage refuses to
   * overwrite (`upsert: false`), so an object left by an interrupted attempt — uploaded, then the worker died before
   * the database recorded it — or a corrupted cached segment would otherwise fail every retry with "already exists".
   * The path is owned by this key / this render alone, and its record is written only after this succeeds, so
   * replacing the leftover is safe; a second failure is a real Storage error and fails the render.
   */
  private async write(objectPath: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const { storage } = this.deps;
    try {
      await storage.put(objectPath, bytes, contentType);
    } catch {
      await storage.remove(objectPath);
      await storage.put(objectPath, bytes, contentType);
    }
  }

  private async reuse(projectId: string, cacheKey: string, hasAudio: boolean, dir: string, name: string) {
    const { store, storage } = this.deps;
    const entry = await store.getSegment(projectId, cacheKey);
    if (!entry || (hasAudio && !entry.audioPath)) return null;
    const v = await storage.get(entry.videoPath);
    const a = hasAudio && entry.audioPath ? await storage.get(entry.audioPath) : null;
    if (!v || sha256(v) !== entry.videoChecksum || (hasAudio && (!a || sha256(a) !== entry.audioChecksum))) {
      await store.dropSegment(projectId, cacheKey);
      return null;
    }
    await writeFile(path.join(dir, `${name}.mp4`), v);
    if (a) await writeFile(path.join(dir, `${name}.wav`), a);
    return { video: `${name}.mp4`, audio: a ? `${name}.wav` : null };
  }
}

export class RenderRunError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RenderRunError";
  }
}

/** A short, path-free failure for the creator (codes for debugging; never a worker path or a credential). */
function describe(err: unknown): { code: string; message: string } {
  if (err instanceof RenderRunError) return { code: err.code, message: err.message };
  if (err instanceof RenderPlanError) return { code: err.code, message: err.message };
  if (err instanceof TitleFontError) return { code: "title_font_unavailable", message: err.message };
  if (err instanceof MediaError) return { code: `media_${err.code}`, message: err.message };
  const message = (err instanceof Error ? err.message : String(err))
    .replace(/[A-Za-z]:\\[^\s"']+|\/[^\s"']+/g, "<path>")
    .slice(0, 300);
  return { code: "render_failed", message: `The render failed: ${message}` };
}
