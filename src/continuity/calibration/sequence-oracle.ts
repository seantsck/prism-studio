import { createHash } from "node:crypto";
import type { GeminiRequest } from "../providers/gemini/transport";
import type { FakeStep } from "../providers/gemini/fake-transport";
import { GeminiTransportError } from "../providers/gemini/transport";
import type { SequenceMaterials } from "./sequence-calibration";
import {
  SEQUENCE_CALIBRATION_ACCEPTANCE,
  SEQUENCE_FIXTURES,
  type SequenceCalibrationFixture,
} from "./sequence-fixtures";

/**
 * The OFFLINE quality oracle for ordinary CI. It identifies the fixture only from the media bytes it receives (the
 * request carries no fixture id or truth, and tests prove that), then answers as a chosen kind of analyzer. It says
 * nothing about a real model.
 */
export type OracleBehaviour =
  | "truthful"
  | "always_pass"
  | "warn_on_conflict"
  | "fail_on_positive"
  | "warn_on_positive"
  | "unchecked"
  | "missing_answer"
  | "one_sided"
  | "bad_timestamp"
  | "out_of_window"
  | "direction_still_only"
  | "direction_one_side_temporal"
  | "direction_short_interval"
  | "malformed"
  | "malformed_then_truthful"
  | { error: GeminiTransportError };

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

const inlineChecksums = (req: GeminiRequest) =>
  req.turns[0]!.parts.flatMap((p) =>
    p.type === "inline" && p.mimeType.startsWith("video/")
      ? [sha256(Buffer.from(p.dataBase64, "base64"))]
      : [],
  );

const answerOf = (req: GeminiRequest) => {
  const data = req.turns[0]!.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).find((t) =>
    t.startsWith("DATA"),
  )!;
  return JSON.parse(data.slice(data.indexOf("{"))) as { criteria: Array<{ criterionId: string }> };
};

/** Valid sided evidence: both stills (they are at the cut, so inside every pre-registered window). */
const sided = [
  { input: "left:last", timestampMs: null, endMs: null, observation: "The left edge frame." },
  { input: "right:first", timestampMs: null, endMs: null, observation: "The right edge frame." },
];

/** Valid temporal evidence: an interval of travel in each clip. */
const clipInterval = (input: "left:clip" | "right:clip", timestampMs = 500, endMs = 1500) => ({
  input,
  timestampMs,
  endMs,
  observation: "The direction of travel across this interval.",
});
const temporal = [clipInterval("left:clip"), clipInterval("right:clip")];
const needsTemporal = (f: SequenceCalibrationFixture) =>
  (SEQUENCE_CALIBRATION_ACCEPTANCE.temporalEvidence.families as readonly string[]).includes(f.family);

export function sequenceOracle(
  materials: SequenceMaterials,
  behaviour: OracleBehaviour,
  fixtures: readonly SequenceCalibrationFixture[] = SEQUENCE_FIXTURES,
): (req: GeminiRequest, n: number) => FakeStep {
  const byClip = new Map<string, SequenceCalibrationFixture>();
  for (const f of fixtures) {
    const m = materials.get(f.id)!;
    byClip.set(`${m.left.clip.checksum}|${m.right.clip.checksum}`, f);
  }
  return (req) => {
    if (typeof behaviour === "object") return { kind: "error", error: behaviour.error };
    const [l, r] = inlineChecksums(req);
    const f = byClip.get(`${l}|${r}`);
    if (!f) throw new Error("The oracle received media of no fixture.");
    const id = answerOf(req).criteria[0]!.criterionId;
    const isCorrection = req.turns.length > 1;
    const answer = (result: string, evidence: unknown[] = needsTemporal(f) ? temporal : sided) => ({
      kind: "json" as const,
      body: {
        criteria: [
          {
            criterionId: id,
            result,
            confidence: 0.9,
            summary: `Oracle ${result}.`,
            evidence,
            contradictions: result === "fail" ? ["Oracle contradiction."] : [],
            limitations: result === "unchecked" ? ["Oracle limitation."] : [],
          },
        ],
      },
    });
    switch (behaviour) {
      case "truthful":
        return answer(f.correct);
      case "always_pass":
        return answer("pass");
      case "warn_on_conflict":
        return answer(f.correct === "fail" ? "warn" : "pass");
      case "fail_on_positive":
        return answer("fail");
      case "warn_on_positive":
        return answer(f.correct === "pass" ? "warn" : "fail");
      case "unchecked":
        return answer("unchecked", []);
      case "missing_answer":
        return { kind: "json", body: { criteria: [] } };
      case "one_sided":
        return answer(f.correct, [sided[0]]);
      case "bad_timestamp":
        return answer(f.correct, [
          { input: "left:clip", timestampMs: 99_999, endMs: null, observation: "Past the clip." },
          sided[1],
        ]);
      case "out_of_window":
        // valid evidence, but at the far start of the left clip and the far end of the right clip
        return answer(f.correct, [
          { input: "left:clip", timestampMs: 0, endMs: 250, observation: "Far from the cut." },
          { input: "right:clip", timestampMs: 1650, endMs: 1900, observation: "Far from the cut." },
        ]);
      case "direction_still_only":
        return answer(f.correct, sided);
      case "direction_one_side_temporal":
        return answer(f.correct, needsTemporal(f) ? [clipInterval("left:clip"), sided[1]] : undefined);
      case "direction_short_interval":
        return answer(
          f.correct,
          needsTemporal(f)
            ? [clipInterval("left:clip", 500, 749), clipInterval("right:clip", 500, 749)]
            : undefined,
        );
      case "malformed":
        return { kind: "text", text: "not json" };
      case "malformed_then_truthful":
        return isCorrection ? answer(f.correct) : { kind: "text", text: "not json" };
    }
  };
}
