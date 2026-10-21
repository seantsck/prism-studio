import { z } from "zod";
import type { AcceptanceReport, Verdict } from "./report";

/**
 * The HUMAN half of real-reconstruction acceptance (M2D.3D1). Machine success is not enough: a person looks at the
 * reconstruction in Prism and answers each item. `critical` items decide FAIL; the others can only lower a PASS to
 * PASS_WITH_LIMITATIONS. Nothing here is a score.
 *
 * The control-pass limitation is an acknowledgement, not a test: a visible Gaussian splat still blocks exact M2C
 * depth/object/mask passes, and acceptance does not pretend otherwise.
 */

export const HUMAN_REVIEW_SCHEMA = "prism.reconstruction-human-review.v1" as const;

export const HUMAN_CHECKLIST = [
  // GEOMETRY
  {
    id: "geometry.recognizable",
    group: "GEOMETRY",
    critical: true,
    text: "Walls, floor and major furniture are recognizable.",
  },
  {
    id: "geometry.no_duplication",
    group: "GEOMETRY",
    critical: true,
    text: "No catastrophic duplication (doubled walls or objects).",
  },
  {
    id: "geometry.navigable",
    group: "GEOMETRY",
    critical: false,
    text: "The camera can move through the expected area.",
  },
  {
    id: "geometry.scale_calibratable",
    group: "GEOMETRY",
    critical: false,
    text: "Scale can be calibrated manually to a plausible value.",
  },
  // VISUAL
  { id: "visual.no_explosions", group: "VISUAL", critical: true, text: "No giant splat explosions." },
  {
    id: "visual.no_severe_holes",
    group: "VISUAL",
    critical: false,
    text: "No severe holes in the primary filming angles.",
  },
  { id: "visual.no_dominant_floaters", group: "VISUAL", critical: false, text: "No dominant floaters." },
  {
    id: "visual.orientation",
    group: "VISUAL",
    critical: false,
    text: "Not upside down or rotated (or corrected with the Set transform).",
  },
  {
    id: "visual.production_camera",
    group: "VISUAL",
    critical: true,
    text: "Acceptable appearance from the production camera.",
  },
  // CONTINUITY
  {
    id: "continuity.camera_moves",
    group: "CONTINUITY",
    critical: false,
    text: "The environment stays stable as the camera moves.",
  },
  {
    id: "continuity.mannequin",
    group: "CONTINUITY",
    critical: false,
    text: "Stable with a character mannequin inserted.",
  },
  {
    id: "continuity.framing",
    group: "CONTINUITY",
    critical: false,
    text: "Stable when the shot framing changes.",
  },
  // PRODUCTION
  { id: "production.master_frame", group: "PRODUCTION", critical: true, text: "A master frame renders." },
  { id: "production.previs", group: "PRODUCTION", critical: false, text: "Previs renders." },
  {
    id: "production.generation_package",
    group: "PRODUCTION",
    critical: true,
    text: "A GenerationPackage can reference it.",
  },
] as const;

export type ChecklistId = (typeof HUMAN_CHECKLIST)[number]["id"];

export const CONTROL_PASS_LIMITATION =
  "Known limitation (not a test item): a visible Gaussian splat still blocks exact M2C depth/object/mask control passes.";

const answer = z.enum(["pass", "fail", "not_applicable"]).nullable();

export const humanReviewSchema = z
  .object({
    schema: z.literal(HUMAN_REVIEW_SCHEMA),
    runId: z.string().max(80),
    /** initials or a role; never needed to be a full name */
    reviewer: z.string().max(40),
    reviewedAt: z.string().max(40),
    answers: z.record(z.string(), answer),
    controlPassLimitationAcknowledged: z.boolean(),
    notes: z.string().max(4000),
  })
  .strict();

export type HumanReview = z.infer<typeof humanReviewSchema>;

/** The template written next to a run's report; every answer starts unanswered (null). */
export function humanReviewTemplate(runId: string): HumanReview & { checklist: unknown; limitation: string } {
  return {
    schema: HUMAN_REVIEW_SCHEMA,
    runId,
    reviewer: "",
    reviewedAt: "",
    answers: Object.fromEntries(HUMAN_CHECKLIST.map((c) => [c.id, null])),
    controlPassLimitationAcknowledged: false,
    notes: "",
    // reference only (ignored when the review is read back)
    checklist: HUMAN_CHECKLIST.map((c) => ({
      id: c.id,
      group: c.group,
      critical: c.critical,
      question: c.text,
    })),
    limitation: CONTROL_PASS_LIMITATION,
  };
}

export function finalVerdict(
  report: Pick<AcceptanceReport, "mode" | "verdict" | "validation" | "runId">,
  review: HumanReview | null,
): { verdict: Verdict | "PENDING_HUMAN_REVIEW"; reasons: string[] } {
  const reasons: string[] = [];
  if (report.verdict.machine === "FAIL")
    return { verdict: "FAIL", reasons: ["The machine verdict is FAIL.", ...report.verdict.machineReasons] };
  if (report.mode !== "REAL_ROOM")
    return {
      verdict: report.verdict.machine,
      reasons: ["A smoke run is judged by the machine only (synthetic scene)."],
    };
  if (!review) return { verdict: "PENDING_HUMAN_REVIEW", reasons: ["No human review yet."] };
  if (review.runId !== report.runId)
    return { verdict: "PENDING_HUMAN_REVIEW", reasons: ["The review is for another run."] };
  const missing = HUMAN_CHECKLIST.filter(
    (c) => review.answers[c.id] === null || review.answers[c.id] === undefined,
  );
  if (missing.length)
    return { verdict: "PENDING_HUMAN_REVIEW", reasons: [`${missing.length} checklist item(s) unanswered.`] };
  if (!review.controlPassLimitationAcknowledged)
    return {
      verdict: "PENDING_HUMAN_REVIEW",
      reasons: ["The control-pass limitation has not been acknowledged."],
    };
  const failedCritical = HUMAN_CHECKLIST.filter((c) => c.critical && review.answers[c.id] === "fail");
  const naCritical = HUMAN_CHECKLIST.filter((c) => c.critical && review.answers[c.id] === "not_applicable");
  if (failedCritical.length || naCritical.length)
    return {
      verdict: "FAIL",
      reasons: [
        ...failedCritical.map((c) => `Critical: ${c.text}`),
        ...naCritical.map((c) => `Critical item cannot be "not applicable": ${c.text}`),
      ],
    };
  // PASS requires that Spark rendered it
  if (report.validation.sparkRender !== "pass") reasons.push("The Spark render check did not pass.");
  if (report.verdict.machine === "PASS_WITH_LIMITATIONS") reasons.push(...report.verdict.machineReasons);
  for (const c of HUMAN_CHECKLIST)
    if (!c.critical && review.answers[c.id] === "fail") reasons.push(`Limitation: ${c.text}`);
  reasons.push(CONTROL_PASS_LIMITATION);
  const limited = reasons.length > 1;
  return { verdict: limited ? "PASS_WITH_LIMITATIONS" : "PASS", reasons };
}
