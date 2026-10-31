import { createHash } from "node:crypto";
import {
  ANALYSIS_SCHEMA_VERSION,
  PROMPT_VERSIONS,
  SEQUENCE_RUBRIC_VERSION,
} from "@/domain/continuity/analysis/types";
import type { ContinuityCategory, ContinuitySeverity } from "@/domain/continuity/model";
import {
  CUT_EDGE_POLICY,
  SEQUENCE_RULES_VERSION,
  SEMANTIC_CUT_FAMILIES,
  type SemanticCutFamily,
} from "@/domain/continuity/sequence";
import { GEMINI_SEQUENCE_ANALYSIS_VERSION } from "../providers/gemini/config";

/**
 * Sequence Continuity calibration (Phase 3A.4E): the FROZEN experiment. Deterministic synthetic parent clips with known
 * cross-cut truth (abstract shapes only: no project media, copyrighted footage or real person), one positive and one
 * conflict fixture per production semantic family, and a PRE-REGISTERED per-family acceptance rule.
 *
 * Everything here is fixed BEFORE any live answer is seen. Changing a fixture's truth, pixels, window or the rule after
 * a live run is a NEW calibration version, never a re-grade. The calibration version identifies this experiment; it is
 * independent of `temporal-calibration-v2` and changes no analyzer, prompt, rubric, schema or edge policy identity.
 *
 * Pixels state only what they show (the 3A.3 v1 lesson: never claim an event the render does not contain). The
 * criterion text is production's own (`expected`, `sourceRef`), checked against `buildEpisodeCuts` by a test.
 */
export const SEQUENCE_CALIBRATION_VERSION = "sequence-calibration-v1";

/** One observation per fixture per trial; never batched across families or trials. */
export const SEQUENCE_CALIBRATION_PLAN = {
  fixtures: 20,
  trials: 3,
  qualityRequests: 60,
  /** Every quality request may use the analyzer's one schema correction; nothing else can add a request. */
  maxTransportRequests: 120,
} as const;

/** The proxies are named in the production criterion text, like a real Character or Prop. */
const CHARACTER = "Proxy figure";
const PROP = "Yellow baton";

/**
 * PRE-REGISTERED acceptance (fixed before any live call). Per family, independently:
 *  - every positive trial must answer `pass`; every conflict trial must answer `fail` (`warn` is wrong on a conflict);
 *  - `unchecked`, a missing answer and an answer still invalid after the correction are wrong;
 *  - every judgement must satisfy the production sequence validator: LEFT and RIGHT edge evidence, each clip's times
 *    bounded by that clip;
 *  - a fixture with an evidence window needs, on each windowed side, at least one cited edge input lying ENTIRELY inside
 *    the window ± `eventToleranceMs` (the 4 fps sampling precision + `eventSlackMs`; an edge still counts at its own
 *    instant, a reference never counts). A fixture without a window takes evidence anywhere in the clips;
 *  - 3/3 per fixture, so 6/6 per family: no majority, no "close enough";
 *  - CORRECTIONS: the real provider path keeps its one schema correction. A corrected answer that then validates is a
 *    valid trial, but the family's decision and the report disclose it and `ownerReviewRequired` is set: the owner
 *    reviews it before any production enablement;
 *  - an aborted run accepts nothing (the pre-registered test did not finish), matching 3A.3.
 * A decision is EVIDENCE only: nothing here or in the runner changes `GEMINI_CROSS_CUT_ACCEPTED_FAMILIES`.
 */
export const SEQUENCE_CALIBRATION_ACCEPTANCE = {
  trials: SEQUENCE_CALIBRATION_PLAN.trials,
  minCorrectPerFixture: 3,
  correctPerFamily: 6,
  positiveExpected: "pass",
  conflictExpected: "fail",
  samplingPrecisionMs: Math.round(1000 / CUT_EDGE_POLICY.fps),
  eventSlackMs: 250,
  eventToleranceMs: Math.round(1000 / CUT_EDGE_POLICY.fps) + 250,
  windowRule: "at least one cited edge input per windowed side lies entirely inside window ± tolerance",
  correctionRule: "a validated corrected answer is a valid trial, disclosed, and requires owner review",
  abortRule: "an aborted run accepts no family",
} as const;

/** Exact production text per family (`buildCriteria`), with the proxies as the Character and Prop names. */
export const FAMILY_CRITERIA: Record<
  SemanticCutFamily,
  {
    key: string;
    category: ContinuityCategory;
    severity: ContinuitySeverity;
    title: string;
    expected: string;
    sourceRef: string;
  }
> = {
  screen_direction: {
    key: "cut:screen_direction",
    category: "screen_direction",
    severity: "major",
    title: "Screen direction across the cut",
    expected: "The subject's direction of travel / facing carries across the cut.",
    sourceRef: "Shot spatial continuity",
  },
  eyeline: {
    key: "cut:eyeline",
    category: "eyelines",
    severity: "major",
    title: "Eyeline match across the cut",
    expected: "A's look direction matches B's subject position (eyeline match).",
    sourceRef: "Shot spatial continuity",
  },
  axis: {
    key: "cut:axis",
    category: "camera",
    severity: "major",
    title: "Camera axis (180°)",
    expected: "The camera stays on the same side of the line of action.",
    sourceRef: "Shot camera / blocking",
  },
  character_appearance: {
    key: "cut:character_appearance:proxy",
    category: "identity",
    severity: "major",
    title: `${CHARACTER}: same person across the cut`,
    expected: `${CHARACTER} is recognisably the same person on both sides.`,
    sourceRef: `Character ${CHARACTER}`,
  },
  wardrobe: {
    key: "cut:wardrobe:proxy",
    category: "wardrobe",
    severity: "major",
    title: `${CHARACTER}: wardrobe continues`,
    expected: `${CHARACTER}'s costume, hair, makeup and jewellery carry across the cut.`,
    sourceRef: "Look none",
  },
  prop: {
    key: "cut:prop:baton",
    category: "props",
    severity: "major",
    title: `Prop ${PROP} continues`,
    expected: `${PROP} persists, stays in the same place or hand, and keeps its state.`,
    sourceRef: `Prop ${PROP}`,
  },
  object_continuity: {
    key: "cut:object_continuity",
    category: "props",
    severity: "minor",
    title: "Objects continue across the cut",
    expected: "No salient object disappears, appears or jumps position unexpectedly.",
    sourceRef: "Shot continuity",
  },
  geography: {
    key: "cut:geography",
    category: "geography",
    severity: "major",
    title: "Geography / blocking continues",
    expected: "Relative Character positions and the set geography stay consistent.",
    sourceRef: "Shot geography",
  },
  lighting: {
    key: "cut:lighting",
    category: "lighting",
    severity: "minor",
    title: "Lighting continues",
    expected: "Key direction, colour and time-of-day look are continuous.",
    sourceRef: "Shot lighting",
  },
  action_match: {
    key: "cut:action_match",
    category: "action_continuity",
    severity: "major",
    title: "Action match across the cut",
    expected: "B's action continues A's (match on action, pose, position).",
    sourceRef: "Shot action",
  },
};

export interface SequenceRenderSpec {
  /** Parent clip length. Edge windows are cut from it by the real production extraction, never rendered directly. */
  durationMs: number;
  /** ffmpeg lavfi graph (argument arrays only: no shell). */
  video: string;
  /** A tone on every parent, so the real extraction's audio stripping is exercised. */
  audio: string;
}

export interface SequenceCalibrationFixture {
  id: string;
  family: SemanticCutFamily;
  control: "positive" | "conflict";
  /** What the pixels are (for the report; never sent). */
  description: string;
  /** Pre-registered correct answer (never sent). */
  correct: "pass" | "fail";
  /** Why the pixels prove `correct` (for the report; never sent). */
  notes: string;
  left: SequenceRenderSpec;
  right: SequenceRenderSpec;
  /** The used source interval of each parent; the cut sits at left.outMs | right.inMs. */
  cut: { left: { inMs: number; outMs: number }; right: { inMs: number; outMs: number } };
  /** Clip-local evidence windows (ms from each clip's start), for fixtures whose evidence is time-specific. */
  evidenceWindows?: { left?: [number, number]; right?: [number, number] };
}

const D = 5; // seconds per parent: longer than the used interval, so trimming is real
const W = 640;
const H = 360;
const TONE = `sine=frequency=330:sample_rate=48000:duration=${D}`;
/** Used source interval of every parent: left window [2500, 4500] of A, right window [500, 2500] of B. */
const CUT = { left: { inMs: 500, outMs: 4500 }, right: { inMs: 500, outMs: 4500 } } as const;

const bg = (c = "0x2a2a2a") => `color=c=${c}:s=${W}x${H}:d=${D}:r=24`;
const fill = (x: number, y: number, w: number, h: number, c: string) =>
  `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${c}:t=fill`;
const scene = (boxes: string[], c?: string) => [bg(c), ...boxes].join(",");
/** A background with one solid block moved by `x(t)` (ffmpeg `overlay` evaluates per frame). */
const moving = (block: string, s: number, x: string, y: number, boxes: string[] = []) =>
  `${scene(boxes)}[b];color=c=${block}:s=${s}x${s}:d=${D}:r=24[s];[b][s]overlay=x='${x}':y=${y}`;
const spec = (video: string): SequenceRenderSpec => ({ durationMs: D * 1000, video, audio: TONE });

function fixture(
  family: SemanticCutFamily,
  control: "positive" | "conflict",
  o: Pick<SequenceCalibrationFixture, "description" | "notes" | "evidenceWindows"> & {
    left: string;
    right: string;
  },
): SequenceCalibrationFixture {
  return {
    id: `${family.replace(/_/g, "-")}-${control}`,
    family,
    control,
    description: o.description,
    correct: control === "positive" ? "pass" : "fail",
    notes: o.notes,
    left: spec(o.left),
    right: spec(o.right),
    cut: { left: { ...CUT.left }, right: { ...CUT.right } },
    ...(o.evidenceWindows ? { evidenceWindows: o.evidenceWindows } : {}),
  };
}

// ── proxies ──
/** A face proxy: a head with two white eyes whose pupils sit at the side it looks toward. */
const face = (x: number, looks: "left" | "right", head: string) => {
  const pupil = looks === "right" ? 18 : 0;
  return [
    fill(x, 110, 130, 140, head),
    fill(x + 15, 145, 36, 28, "white"),
    fill(x + 79, 145, 36, 28, "white"),
    fill(x + 15 + pupil, 145, 18, 28, "black"),
    fill(x + 79 + pupil, 145, 18, 28, "black"),
  ];
};
/** Identity is structure only: head geometry, marks and hair. The torso (wardrobe) is the same for both identities. */
const figureA = [
  fill(280, 60, 80, 80, "0xd8b890"),
  fill(280, 40, 80, 20, "0x2b1a10"),
  fill(295, 85, 12, 12, "black"),
  fill(333, 85, 12, 12, "black"),
  fill(310, 118, 20, 6, "0x803020"),
];
const figureB = [
  fill(300, 30, 40, 110, "0xd8b890"),
  fill(308, 50, 8, 8, "black"),
  fill(324, 50, 8, 8, "black"),
  fill(308, 80, 24, 24, "0x803020"),
  fill(290, 30, 10, 110, "0x2b1a10"),
  fill(340, 30, 10, 110, "0x2b1a10"),
];
const torso = (c: string) => [fill(250, 140, 140, 180, c)];
const stripes = [
  fill(250, 170, 140, 14, "white"),
  fill(250, 220, 140, 14, "white"),
  fill(250, 270, 140, 14, "white"),
];
const baton = (x: number) => [fill(x, 120, 18, 150, "yellow")];
const arms = [fill(200, 170, 50, 26, "0xd8b890"), fill(390, 170, 50, 26, "0xd8b890")];
const figureWithArms = [...figureA, ...torso("0x3050a0"), ...arms];
const ground = [fill(0, 300, W, 60, "0x503820")];
/** Key light: the lit half and the shadow half of a block subject, with a wall glow on the lit side. */
const lit = (key: "left" | "right", bright: string, dark: string, glow: string, wall: string) =>
  scene(
    key === "left"
      ? [fill(0, 0, 200, H, glow), fill(240, 90, 80, 180, bright), fill(320, 90, 80, 180, dark)]
      : [fill(440, 0, 200, H, glow), fill(240, 90, 80, 180, dark), fill(320, 90, 80, 180, bright)],
    wall,
  );
/** The action: a block pushed along a tick-marked track; `p(t)` percent of the way. x = 40 + 5·p. */
const TICKS = Array.from({ length: 11 }, (_, i) => fill(40 + 50 * i + 28, 255, 4, 30, "0xa0a0a0"));
const TRACK = [fill(40, 268, 560, 4, "0xa0a0a0"), ...TICKS];
const pushed = (percentAt: number, atSec: number) =>
  moving("0xff7f00", 60, `40+5*(${percentAt}+15*(t-${atSec}))`, 195, TRACK);

/**
 * The fixture table: 10 families × (positive, conflict). `pass` needs no contradiction in the evaluated evidence; each
 * conflict is deliberate and unmistakable under compressed synthetic video.
 */
export const SEQUENCE_FIXTURES: readonly SequenceCalibrationFixture[] = [
  fixture("screen_direction", "positive", {
    description:
      "A red square travels left to right up to the cut; after it, the same square keeps travelling right.",
    notes: "x(t) rises on both sides (80 px/s) and continues from the same x. Nothing exits the frame.",
    left: moving("red", 70, "20+80*t", 145),
    right: moving("red", 70, "380+80*(t-0.5)", 145),
  }),
  fixture("screen_direction", "conflict", {
    description:
      "A red square travels left to right up to the cut; after it, the same square travels right to left.",
    notes:
      "x(t) rises on the left clip and falls on the right clip, from the same x. Nothing exits the frame.",
    left: moving("red", 70, "20+80*t", 145),
    right: moving("red", 70, "380-80*(t-0.5)", 145),
  }),

  fixture("eyeline", "positive", {
    description:
      "A tan face on the left of frame looks screen-right; the reverse angle's pale blue face, on the right of frame, looks screen-left.",
    notes:
      "The pupils are on the side each face looks to: the two faces look toward each other across the cut.",
    left: scene(face(120, "right", "0xd8b890")),
    right: scene(face(390, "left", "0x90b0e0")),
  }),
  fixture("eyeline", "conflict", {
    description:
      "A tan face on the left of frame looks screen-right; the reverse angle's pale blue face, on the right of frame, also looks screen-right, away.",
    notes: "B's pupils point away from where A's face is: the look does not meet B's subject position.",
    left: scene(face(120, "right", "0xd8b890")),
    right: scene(face(390, "right", "0x90b0e0")),
  }),

  fixture("axis", "positive", {
    description:
      "A red and a blue subject joined by a white line of action; red stays screen-left of blue in a closer framing after the cut.",
    notes:
      "The left/right order of the two distinct subjects is the same on both sides: the camera stayed on its side.",
    left: scene([
      fill(100, 180, 440, 4, "white"),
      fill(100, 145, 70, 70, "red"),
      fill(470, 145, 70, 70, "blue"),
    ]),
    right: scene([
      fill(60, 180, 520, 4, "white"),
      fill(60, 120, 120, 120, "red"),
      fill(460, 120, 120, 120, "blue"),
    ]),
  }),
  fixture("axis", "conflict", {
    description:
      "The same two subjects and line; after the cut the order is reversed, blue screen-left of red, as if the camera crossed the line.",
    notes: "The red/blue left-right order flips across the cut with no movement in either clip.",
    left: scene([
      fill(100, 180, 440, 4, "white"),
      fill(100, 145, 70, 70, "red"),
      fill(470, 145, 70, 70, "blue"),
    ]),
    right: scene([
      fill(60, 180, 520, 4, "white"),
      fill(60, 120, 120, 120, "blue"),
      fill(460, 120, 120, 120, "red"),
    ]),
  }),

  fixture("character_appearance", "positive", {
    description:
      "The same humanoid proxy on both sides: square head, short hair block, two wide-set eyes, a small mouth mark.",
    notes:
      "Identical head structure and marks on both sides; the torso is the same blue. Identity does not rest on colour of clothing.",
    left: scene([...figureA, ...torso("0x3050a0")]),
    right: scene([...figureA, ...torso("0x3050a0")]),
  }),
  fixture("character_appearance", "conflict", {
    description:
      "The proxy's head structure changes across the cut: a tall narrow head, close-set eyes, a large mark, long side hair. The torso does not change.",
    notes:
      "Only identity-defining structure changes (head geometry, marks, hair); the clothing stays the same blue torso.",
    left: scene([...figureA, ...torso("0x3050a0")]),
    right: scene([...figureB, ...torso("0x3050a0")]),
  }),

  fixture("wardrobe", "positive", {
    description: "The same proxy wears the same red garment with white stripes on both sides.",
    notes: "Same head, same garment colour and pattern.",
    left: scene([...figureA, ...torso("0xb02020"), ...stripes]),
    right: scene([...figureA, ...torso("0xb02020"), ...stripes]),
  }),
  fixture("wardrobe", "conflict", {
    description:
      "The same proxy (same head) wears a red striped garment before the cut and a plain green garment after it.",
    notes: "The head is pixel-identical; only the garment's colour and pattern change.",
    left: scene([...figureA, ...torso("0xb02020"), ...stripes]),
    right: scene([...figureA, ...torso("0x20a040")]),
  }),

  fixture("prop", "positive", {
    description:
      "The proxy holds a yellow baton upright at the arm on screen-right, on both sides of the cut.",
    notes: "Same prop, same hand, same upright state.",
    left: scene([...figureWithArms, ...baton(420)]),
    right: scene([...figureWithArms, ...baton(420)]),
  }),
  fixture("prop", "conflict", {
    description:
      "The proxy holds the yellow baton at the arm on screen-right before the cut and at the arm on screen-left after it.",
    notes: "The pre-registered break is a hand change: the baton is present on both sides, at opposite arms.",
    left: scene([...figureWithArms, ...baton(420)]),
    right: scene([...figureWithArms, ...baton(202)]),
  }),

  fixture("object_continuity", "positive", {
    description: "A magenta cube stands on the floor at screen-right on both sides of the cut.",
    notes: "Same salient object, same position, same state.",
    left: scene([...ground, fill(430, 210, 90, 90, "magenta")]),
    right: scene([...ground, fill(430, 210, 90, 90, "magenta")]),
  }),
  fixture("object_continuity", "conflict", {
    description:
      "A magenta cube stands on the floor at screen-right before the cut; after the cut the floor is empty.",
    notes: "The cube is in every left frame and in no right frame, so either whole clip is valid evidence.",
    left: scene([...ground, fill(430, 210, 90, 90, "magenta")]),
    right: scene(ground),
  }),

  fixture("geography", "positive", {
    description:
      "A green tower at screen-left, a blue building at screen-right and a white figure beside the tower, on both sides.",
    notes:
      "Both landmarks and the figure keep their sides and relative layout, in a slightly closer framing after the cut.",
    left: scene([
      ...ground,
      fill(50, 60, 90, 240, "0x20a040"),
      fill(460, 140, 140, 160, "0x2050c0"),
      fill(170, 220, 40, 80, "white"),
    ]),
    right: scene([
      ...ground,
      fill(30, 40, 110, 260, "0x20a040"),
      fill(480, 120, 160, 180, "0x2050c0"),
      fill(170, 210, 50, 90, "white"),
    ]),
  }),
  fixture("geography", "conflict", {
    description:
      "The same set after the cut is mirrored: the tower and the figure are at screen-right, the building at screen-left.",
    notes:
      "The landmarks swap sides. The colours and shapes stay the same, so the break is spatial, not a colour difference.",
    left: scene([
      ...ground,
      fill(50, 60, 90, 240, "0x20a040"),
      fill(460, 140, 140, 160, "0x2050c0"),
      fill(170, 220, 40, 80, "white"),
    ]),
    right: scene([
      ...ground,
      fill(500, 60, 90, 240, "0x20a040"),
      fill(40, 140, 140, 160, "0x2050c0"),
      fill(430, 220, 40, 80, "white"),
    ]),
  }),

  fixture("lighting", "positive", {
    description:
      "A block subject lit warm from screen-left (bright warm left half, dark right half, warm wall glow on the left), on both sides.",
    notes: "Same key side and same colour on both sides.",
    left: lit("left", "0xffd890", "0x403018", "0x806838", "0x302818"),
    right: lit("left", "0xffd890", "0x403018", "0x806838", "0x302818"),
  }),
  fixture("lighting", "conflict", {
    description: "Warm key from screen-left before the cut; cold blue key from screen-right after it.",
    notes: "The bright half, the wall glow and the colour temperature all change across the cut.",
    left: lit("left", "0xffd890", "0x403018", "0x806838", "0x302818"),
    right: lit("right", "0x90c8ff", "0x101830", "0x385080", "0x101828"),
  }),

  fixture("action_match", "positive", {
    description:
      "An orange block is pushed along a tick-marked track, reaching 60% at the cut; after the cut it starts at 65% and keeps going.",
    notes: "15 %/s on both sides: 30→60% on the left clip, then 65→95%: the phase continues across the cut.",
    evidenceWindows: { left: [1500, 2000], right: [0, 500] },
    left: pushed(60, 4.5),
    right: pushed(65, 0.5),
  }),
  fixture("action_match", "conflict", {
    description:
      "The same push reaches 60% at the cut; after the cut the block restarts at 10% of the track.",
    notes:
      "The phase jumps backward from 60% to 10% at the cut: the evidence is the frames either side of it.",
    evidenceWindows: { left: [1500, 2000], right: [0, 500] },
    left: pushed(60, 4.5),
    right: pushed(10, 0.5),
  }),
];

/**
 * A Scene-boundary cut (planner control, not a quality fixture). These are the semantic criteria of a real cut across
 * Scenes with no shared Character (a test proves it against `buildEpisodeCuts`): Prism owns the `n_a`, so the plan
 * submits nothing, no request exists and nothing is graded.
 */
export const INTER_SCENE_CONTROL_FAMILIES: readonly SemanticCutFamily[] = [
  "screen_direction",
  "eyeline",
  "axis",
  "object_continuity",
  "geography",
  "lighting",
  "action_match",
];

/** Checksums of the rendered and derived media of one fixture (what the hash binds the pixels with). */
export interface SequenceFixtureChecksums {
  leftParent: string;
  rightParent: string;
  leftClip: string;
  rightClip: string;
  leftStill: string;
  rightStill: string;
}

/** Everything quality-relevant except the rendered bytes: identical across machines. */
export function sequenceCalibrationDefinition(fixtures = SEQUENCE_FIXTURES) {
  return {
    calibrationVersion: SEQUENCE_CALIBRATION_VERSION,
    plan: SEQUENCE_CALIBRATION_PLAN,
    acceptance: SEQUENCE_CALIBRATION_ACCEPTANCE,
    families: [...SEMANTIC_CUT_FAMILIES],
    criteria: FAMILY_CRITERIA,
    edgePolicy: CUT_EDGE_POLICY,
    rulesVersion: SEQUENCE_RULES_VERSION,
    analyzerVersion: GEMINI_SEQUENCE_ANALYSIS_VERSION,
    promptVersion: PROMPT_VERSIONS.sequence_transition,
    rubricVersion: SEQUENCE_RUBRIC_VERSION,
    schemaVersion: ANALYSIS_SCHEMA_VERSION,
    fixtures,
  };
}
export type SequenceCalibrationDefinition = ReturnType<typeof sequenceCalibrationDefinition>;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** sha256 of the definition: changes with any truth, recipe, window, rule or version change. */
export const sequenceDefinitionHash = (
  definition: SequenceCalibrationDefinition = sequenceCalibrationDefinition(),
) => sha256(JSON.stringify(definition));

/**
 * The CALIBRATION INPUT HASH: the definition plus every rendered and derived checksum, in fixture order. Computed
 * before any transport can exist. The pixels depend on the ffmpeg build, which is recorded beside the hash: another
 * build yields another hash, which is what refuses a live run.
 */
export function sequenceInputHash(
  checksums: Readonly<Record<string, SequenceFixtureChecksums>>,
  definition: SequenceCalibrationDefinition = sequenceCalibrationDefinition(),
): string {
  return sha256(
    JSON.stringify({
      definition,
      media: definition.fixtures.map((f) => ({ id: f.id, ...checksums[f.id] })),
    }),
  );
}
