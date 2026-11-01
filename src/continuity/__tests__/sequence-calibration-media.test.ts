import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { lastDisplayedFrameMs } from "@/domain/continuity/sequence";
import { DEFAULT_EDIT_RATE } from "@/domain/edit/edit-rate";
import { FfmpegMediaProcessor } from "@/media/ffmpeg";
import {
  fixtureInput,
  inlineOnlyProblems,
  materialChecksums,
  prepareSequenceMaterials,
  runSequenceCalibration,
  SEQUENCE_CALIBRATION_PREREGISTERED,
  type SequenceEdgePair,
} from "../calibration/sequence-calibration";
import { SEQUENCE_FIXTURES, sequenceInputHash } from "../calibration/sequence-fixtures";
import { prepareSmokeEdges } from "../calibration/sequence-contract-smoke";
import { sequenceOracle } from "../calibration/sequence-oracle";
import { renderFixture } from "../calibration/temporal-calibration";
import { FakeGeminiTransport } from "../providers/gemini/fake-transport";
import { calibrationProvider } from "./sequence-calibration-stub";

/**
 * Phase 3A.4E: the REAL media path, for every fixture: rendered parents, production `extractWindow` / `extractFrame`,
 * then the real provider path over a fake transport. Local ffmpeg only; byte identity is only claimed within one tool
 * build (`SEQUENCE_CALIBRATION_PREREGISTERED.protocol.processor`).
 */
vi.setConfig({ testTimeout: 300_000, hookTimeout: 400_000 });
const processor = new FfmpegMediaProcessor({ limits: { timeoutMs: 60_000 } });
const available = await processor.available();
const suite = available ? describe : describe.skip;
const dir = mkdtempSync(path.join(tmpdir(), "prism-sequence-calibration-"));
let materials: Map<string, SequenceEdgePair>;

beforeAll(async () => {
  if (available) materials = await prepareSequenceMaterials({ processor });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Clip-local x of the block of a colour at `atSec`, from decoded RGB pixels (the pixels, not the recipe). */
function blockX(
  clip: Uint8Array,
  atSec: number,
  match: (r: number, g: number, b: number) => boolean,
): number {
  const f = path.join(dir, `${createHash("sha256").update(clip).digest("hex")}.mp4`);
  writeFileSync(f, clip);
  const raw = execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-ss",
      String(atSec),
      "-i",
      f,
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-",
    ],
    { maxBuffer: 16 * 1024 * 1024, windowsHide: true },
  );
  const W = 640;
  const xs: number[] = [];
  for (let i = 0; i + 2 < raw.length; i += 3)
    if (match(raw[i]!, raw[i + 1]!, raw[i + 2]!)) xs.push((i / 3) % W);
  expect(xs.length).toBeGreaterThan(100);
  return Math.min(...xs);
}
const isRed = (r: number, g: number, b: number) => r > 180 && g < 70 && b < 70;
const isOrange = (r: number, g: number, b: number) => r > 200 && g > 90 && g < 170 && b < 70;

suite("every fixture through the real cut-edge path", () => {
  it("left = the final 2000 ms of the used A, right = the first 2000 ms of the used B, no audio, playable", () => {
    expect(materials.size).toBe(20);
    for (const f of SEQUENCE_FIXTURES) {
      const m = materials.get(f.id)!;
      expect(m.left.window, f.id).toEqual({ startMs: f.cut.left.outMs - 2000, endMs: f.cut.left.outMs });
      expect(m.right.window, f.id).toEqual({ startMs: f.cut.right.inMs, endMs: f.cut.right.inMs + 2000 });
      for (const s of [m.left, m.right]) {
        expect(s.clip.mime, f.id).toBe("video/mp4");
        expect(Math.abs(s.clip.durationMs! - 2000), f.id).toBeLessThanOrEqual(42);
        expect(s.clip.width, f.id).toBe(640);
        expect(s.clip.height, f.id).toBe(360);
        expect(s.clipHasAudio, f.id).toBe(false);
        expect(s.clip.checksum, f.id).toMatch(/^[0-9a-f]{64}$/);
        expect(s.still.mime, f.id).toBe("image/png");
        expect(s.still.checksum, f.id).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });

  it("the stills are the production edge frames, taken from the parents", () => {
    for (const f of SEQUENCE_FIXTURES) {
      const m = materials.get(f.id)!;
      expect(m.left.stillAtMs, f.id).toBe(
        lastDisplayedFrameMs(f.cut.left.inMs, f.cut.left.outMs, DEFAULT_EDIT_RATE),
      );
      expect(m.right.stillAtMs, f.id).toBe(f.cut.right.inMs);
    }
  });

  it("the parents really carry audio and are longer: the extraction, not the render, made these clips", async () => {
    const f = SEQUENCE_FIXTURES[0]!;
    const parent = await renderFixture({ id: f.id, ...f.left });
    const probe = await processor.probe(parent);
    expect(probe.hasAudio).toBe(true);
    expect(probe.durationMs).toBeGreaterThanOrEqual(4900);
    expect(createHash("sha256").update(parent).digest("hex")).toBe(materials.get(f.id)!.left.parentChecksum);
  });

  it("the pixels prove the moving truth: direction continues or reverses; the action phase continues or restarts", () => {
    const edge = (id: string) => materials.get(id)!;
    const dir = (clip: Uint8Array) => blockX(clip, 1.5, isRed) - blockX(clip, 0.25, isRed);
    expect(dir(edge("screen-direction-positive").left.clip.bytes)).toBeGreaterThan(50);
    expect(dir(edge("screen-direction-positive").right.clip.bytes)).toBeGreaterThan(50);
    expect(dir(edge("screen-direction-conflict").left.clip.bytes)).toBeGreaterThan(50);
    expect(dir(edge("screen-direction-conflict").right.clip.bytes)).toBeLessThan(-50);
    // nothing leaves the frame: the square stays fully visible through both clips
    for (const id of ["screen-direction-positive", "screen-direction-conflict"]) {
      for (const t of [0, 1.9]) {
        const x = blockX(edge(id).right.clip.bytes, t, isRed);
        expect(x).toBeGreaterThan(0);
        expect(x + 70).toBeLessThan(640);
      }
    }
    // x = 40 + 5·p: 60 % at the cut; +5 % on the positive right side; 10 % on the conflict's
    const pct = (x: number) => (x - 40) / 5;
    const atCut = pct(blockX(edge("action-match-positive").left.clip.bytes, 1.95, isOrange));
    const start = (id: string) => pct(blockX(edge(id).right.clip.bytes, 0, isOrange));
    expect(atCut).toBeGreaterThan(55);
    expect(atCut).toBeLessThanOrEqual(61);
    expect(start("action-match-positive")).toBeGreaterThanOrEqual(atCut);
    expect(start("action-match-positive")).toBeLessThan(70);
    expect(start("action-match-conflict")).toBeLessThan(15);
  });

  it("each conflict's cut really differs from its positive, in the right clip only", () => {
    for (const family of new Set(SEQUENCE_FIXTURES.map((f) => f.family))) {
      const id = family.replace(/_/g, "-");
      const pos = materials.get(`${id}-positive`)!;
      const con = materials.get(`${id}-conflict`)!;
      expect(con.left.clip.checksum, family).toBe(pos.left.clip.checksum);
      expect(con.right.clip.checksum, family).not.toBe(pos.right.clip.checksum);
    }
  });

  it("every clip stays well inside the inline threshold: no provider file is ever needed", () => {
    const provider = calibrationProvider(new FakeGeminiTransport([]));
    expect(inlineOnlyProblems(provider, materials)).toEqual([]);
    for (const m of materials.values())
      for (const s of [m.left, m.right]) expect(s.clip.bytes.length).toBeLessThan(1024 * 1024);
  });

  it("the frozen input is valid for every real fixture, with its real checksums", () => {
    const provider = calibrationProvider(new FakeGeminiTransport([]));
    SEQUENCE_FIXTURES.forEach((f, i) => {
      const m = materials.get(f.id)!;
      const input = fixtureInput(f, i, m, provider);
      const by = new Map(input.media.map((x) => [x.inputId, x]));
      expect(by.get("left:clip")).toMatchObject({
        kind: "video",
        checksum: m.left.clip.checksum,
        side: "left",
      });
      expect(by.get("right:clip")).toMatchObject({
        kind: "video",
        checksum: m.right.clip.checksum,
        side: "right",
      });
      expect(by.get("left:last")).toMatchObject({ kind: "output_frame", checksum: m.left.still.checksum });
      expect(by.get("right:first")).toMatchObject({ kind: "output_frame", checksum: m.right.still.checksum });
      expect(by.get("left:clip")!.edge).toMatchObject({
        policy: "cut-edge-static-v1",
        startMs: 2500,
        endMs: 4500,
      });
      expect(by.get("right:clip")!.edge).toMatchObject({
        policy: "cut-edge-static-v1",
        startMs: 500,
        endMs: 2500,
      });
    });
  });

  it("the truthful oracle over the real media accepts all ten families, with the full source never sent", async () => {
    const transport = new FakeGeminiTransport(sequenceOracle(materials, "truthful"));
    const report = await runSequenceCalibration({
      provider: calibrationProvider(transport),
      materials,
      maxTransportCalls: 120,
      maxUsd: 5,
      sleep: async () => undefined,
    });
    expect(report.status).toBe("completed");
    expect(Object.values(report.families).every((f) => f.decision === "accepted")).toBe(true);
    expect(report.transportCalls).toBe(60);
    expect(transport.requests.every((r) => r.inlineVideos === 2 && r.fileParts === 0)).toBe(true);
    expect(report.matchesPreregisteredHash).toBe(
      (await processor.identity()).toolVersion ===
        SEQUENCE_CALIBRATION_PREREGISTERED.protocol.processor.toolVersion,
    );
  });

  it("the input hash is deterministic: a fresh render and derivation of one fixture gives the same checksums", async () => {
    const f = SEQUENCE_FIXTURES[0]!;
    const again = await prepareSequenceMaterials({ processor, fixtures: [f] });
    const before = materialChecksums(materials);
    expect(materialChecksums(again)[f.id]).toEqual(before[f.id]);
    expect(sequenceInputHash(before)).toBe(sequenceInputHash(materialChecksums(materials)));
  });

  it("on the recorded ffmpeg build, the computed hash IS the reviewed hash", async () => {
    const identity = await processor.identity();
    const pinned = SEQUENCE_CALIBRATION_PREREGISTERED.protocol.processor;
    expect(identity.name).toBe(pinned.name);
    expect(identity.adapterVersion).toBe(pinned.adapterVersion);
    if (identity.toolVersion !== pinned.toolVersion) return; // another build is another experiment
    expect(sequenceInputHash(materialChecksums(materials))).toBe(
      SEQUENCE_CALIBRATION_PREREGISTERED.inputHash,
    );
  });

  it("the smoke's diagnostic edges come from the same extraction and stay bounded", async () => {
    const edges = await prepareSmokeEdges(processor);
    expect(Math.abs(edges.left.clip.durationMs! - 2000)).toBeLessThanOrEqual(42);
    expect(edges.right.window).toEqual({ startMs: 0, endMs: 2000 });
    expect(edges.left.clip.bytes.length).toBeLessThan(1024 * 1024);
    expect(edges.left.clipHasAudio).toBe(false);
  });
});
