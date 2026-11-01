import { createHash } from "node:crypto";
import type {
  EdgeMediaFile,
  SequenceLivePreregistration,
  SequenceEdgePair,
  SequenceEdgeSide,
  SequenceMaterials,
} from "../calibration/sequence-calibration";
import { SEQUENCE_FIXTURES, sequenceInputHash } from "../calibration/sequence-fixtures";
import { GeminiAnalysisProvider } from "../providers/gemini/analyzer";
import { readGeminiConfig } from "../providers/gemini/config";
import type { GeminiTransport } from "../providers/gemini/transport";
import {
  materialChecksums,
  SEQUENCE_CALIBRATION_PREREGISTERED,
  sequenceCalibrationIdentity,
} from "../calibration/sequence-calibration";

/** Small unique bytes standing in for the derived media, so the harness tests need no ffmpeg (the media test does). */
const stubFile = (tag: string, mime: string, durationMs: number | null, size = 2048): EdgeMediaFile => {
  const bytes = new Uint8Array(size);
  bytes.set(new TextEncoder().encode(tag));
  return {
    bytes,
    mime,
    checksum: createHash("sha256").update(bytes).digest("hex"),
    width: 640,
    height: 360,
    durationMs,
  };
};

const stubSide = (id: string, which: "left" | "right", clipBytes?: number): SequenceEdgeSide => ({
  parentChecksum: createHash("sha256").update(`parent:${id}:${which}`).digest("hex"),
  sourceInMs: 500,
  sourceOutMs: 4500,
  window: which === "left" ? { startMs: 2500, endMs: 4500 } : { startMs: 500, endMs: 2500 },
  stillAtMs: which === "left" ? 4459 : 500,
  clip: stubFile(`${id}:${which}:clip`, "video/mp4", 2000, clipBytes),
  still: stubFile(`${id}:${which}:still`, "image/png", null),
  clipHasAudio: false,
});

export const stubEdges = (id: string, clipBytes?: number): SequenceEdgePair => ({
  left: stubSide(id, "left", clipBytes),
  right: stubSide(id, "right", clipBytes),
});

export const stubMaterials = (): SequenceMaterials =>
  new Map(SEQUENCE_FIXTURES.map((f) => [f.id, stubEdges(f.id)]));

/** The reviewed identity, over the stub media's hash: everything else in it is the real preregistration. */
export const stubPreregistration = (materials: SequenceMaterials): SequenceLivePreregistration => ({
  ...SEQUENCE_CALIBRATION_PREREGISTERED,
  inputHash: sequenceInputHash(materialChecksums(materials)),
});
export const REVIEWED_PROCESSOR = SEQUENCE_CALIBRATION_PREREGISTERED.protocol.processor;

export const calibrationConfig = () =>
  readGeminiConfig({
    PRISM_STUDIO_CONTINUITY_ANALYZERS: "gemini",
    GEMINI_API_KEY: "test-key-not-a-real-credential",
    PRISM_STUDIO_GEMINI_DIRECT_VIDEO: "1",
  });

export const calibrationProvider = (transport: GeminiTransport) =>
  new GeminiAnalysisProvider({
    config: calibrationConfig(),
    transport,
    testCrossCutCalibration: sequenceCalibrationIdentity(),
  });
