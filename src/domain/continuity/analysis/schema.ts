import { z } from "zod";
import {
  FINDING_RESULTS,
  type AnalysisBatch,
  type AnalysisMedia,
  type AnalysisMode,
  type EvidenceSource,
  type FindingEvidence,
  type NormalizedFinding,
} from "./types";

/**
 * Strict result schema for ANY analyzer response. Raw model JSON is never trusted: it is parsed, validated
 * against the batch it answers (criterion ids, input references, ranges, duplicates) and only then normalised.
 *
 * Providers may NOT return severity, expected values, approval status or aggregate scores: such keys are
 * rejected by `.strict()`.
 */

const MAX_RESPONSE_CHARS = 60_000;

export const evidenceItemSchema = z
  .object({
    input: z.string().min(1).max(80),
    timestampMs: z
      .number()
      .int()
      .min(0)
      .max(24 * 3600 * 1000)
      .nullable(),
    observation: z.string().min(1).max(500),
  })
  .strict();

export const criterionAnswerSchema = z
  .object({
    criterionId: z.string().min(1).max(200),
    result: z.enum(FINDING_RESULTS),
    confidence: z.number().min(0).max(1).nullable(),
    summary: z.string().min(1).max(700),
    evidence: z.array(evidenceItemSchema).max(8),
    contradictions: z.array(z.string().min(1).max(400)).max(6),
    limitations: z.array(z.string().min(1).max(300)).max(6),
  })
  .strict();

export const analysisResponseSchema = z.object({ criteria: z.array(criterionAnswerSchema).max(40) }).strict();
export type AnalysisResponse = z.infer<typeof analysisResponseSchema>;

/**
 * Direct-video answers (schema 2, Phase 3A.3): evidence may name an interval end. Kept SEPARATE from the still-image
 * schema so an image-set answer can never carry an invented time range (`.strict()` rejects `endMs` there).
 */
export const videoEvidenceItemSchema = z
  .object({
    input: z.string().min(1).max(80),
    timestampMs: z
      .number()
      .int()
      .min(0)
      .max(24 * 3600 * 1000)
      .nullable(),
    endMs: z
      .number()
      .int()
      .min(0)
      .max(24 * 3600 * 1000)
      .nullable(),
    observation: z.string().min(1).max(500),
  })
  .strict();

export const videoCriterionAnswerSchema = z
  .object({
    criterionId: z.string().min(1).max(200),
    result: z.enum(FINDING_RESULTS),
    confidence: z.number().min(0).max(1).nullable(),
    summary: z.string().min(1).max(700),
    evidence: z.array(videoEvidenceItemSchema).max(8),
    contradictions: z.array(z.string().min(1).max(400)).max(6),
    limitations: z.array(z.string().min(1).max(300)).max(6),
  })
  .strict();

export const videoAnalysisResponseSchema = z
  .object({ criteria: z.array(videoCriterionAnswerSchema).max(40) })
  .strict();

/**
 * JSON Schema handed to the provider's structured-output mode. Uses only the subset Gemini documents as
 * supported (type, enum, items, minItems/maxItems, minimum/maximum, required, additionalProperties).
 */
export const ANALYSIS_RESPONSE_JSON_SCHEMA = {
  type: "object",
  properties: {
    criteria: {
      type: "array",
      maxItems: 40,
      items: {
        type: "object",
        properties: {
          criterionId: {
            type: "string",
            description: "Exactly one of the criterionId values given in DATA.",
          },
          result: {
            type: "string",
            enum: ["pass", "warn", "fail", "unchecked"],
            description:
              "pass: visibly consistent with the expectation. warn: minor or possible deviation. fail: a clear visible conflict with the expectation. unchecked: cannot be judged from the supplied media (explain in limitations); NEVER use fail because you cannot evaluate.",
          },
          confidence: { type: ["number", "null"], minimum: 0, maximum: 1 },
          summary: { type: "string" },
          evidence: {
            type: "array",
            maxItems: 8,
            items: {
              type: "object",
              properties: {
                input: { type: "string", description: "An inputId from DATA.inputs." },
                timestampMs: { type: ["integer", "null"], minimum: 0 },
                observation: { type: "string" },
              },
              required: ["input", "timestampMs", "observation"],
              additionalProperties: false,
            },
          },
          contradictions: { type: "array", maxItems: 6, items: { type: "string" } },
          limitations: { type: "array", maxItems: 6, items: { type: "string" } },
        },
        required: [
          "criterionId",
          "result",
          "confidence",
          "summary",
          "evidence",
          "contradictions",
          "limitations",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["criteria"],
  additionalProperties: false,
} as const;

/** The provider structured-output schema for a direct-video batch: the image schema plus a nullable `endMs`. */
export const ANALYSIS_RESPONSE_JSON_SCHEMA_VIDEO = {
  ...ANALYSIS_RESPONSE_JSON_SCHEMA,
  properties: {
    criteria: {
      ...ANALYSIS_RESPONSE_JSON_SCHEMA.properties.criteria,
      items: {
        ...ANALYSIS_RESPONSE_JSON_SCHEMA.properties.criteria.items,
        properties: {
          ...ANALYSIS_RESPONSE_JSON_SCHEMA.properties.criteria.items.properties,
          evidence: {
            type: "array",
            maxItems: 8,
            items: {
              type: "object",
              properties: {
                input: { type: "string", description: "The video inputId from DATA.inputs." },
                timestampMs: {
                  type: ["integer", "null"],
                  minimum: 0,
                  description:
                    "Approximate moment, in ms from the start of the clip (within DATA.video.durationMs).",
                },
                endMs: {
                  type: ["integer", "null"],
                  minimum: 0,
                  description: "End of the observed interval in ms, or null for a single moment.",
                },
                observation: { type: "string" },
              },
              required: ["input", "timestampMs", "endMs", "observation"],
              additionalProperties: false,
            },
          },
        },
      },
    },
  },
} as const;

/** The structured-output schema for a batch's mode. */
export const responseJsonSchemaFor = (mode: AnalysisMode) =>
  mode === "direct_video" ? ANALYSIS_RESPONSE_JSON_SCHEMA_VIDEO : ANALYSIS_RESPONSE_JSON_SCHEMA;

export type ValidationOutcome =
  { ok: true; findings: NormalizedFinding[]; missing: string[] } | { ok: false; errors: string[] };

const sourceOf = (m: AnalysisMedia | undefined): EvidenceSource =>
  !m
    ? "metadata"
    : m.kind === "reference"
      ? "reference_image"
      : m.kind === "contact_sheet"
        ? "contact_sheet"
        : m.kind === "video"
          ? "video"
          : "output_frame";

/**
 * Validates a raw model answer against the batch it was asked about. Never "repairs" content: a violation is
 * an error, and the caller decides (at most one correction request, then fail visibly). Criteria the model
 * simply did not answer are reported in `missing` and become UNCHECKED upstream: nothing is invented.
 */
export function validateBatchResponse(
  raw: string | null | undefined,
  batch: Pick<AnalysisBatch, "criterionKeys" | "referenceInputIds" | "outputInputIds"> & {
    mode?: AnalysisMode;
  },
  media: AnalysisMedia[],
): ValidationOutcome {
  const temporal = batch.mode === "direct_video";
  if (raw == null || raw.trim() === "") return { ok: false, errors: ["The response was empty."] };
  if (raw.length > MAX_RESPONSE_CHARS)
    return { ok: false, errors: [`The response exceeded ${MAX_RESPONSE_CHARS} characters.`] };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, errors: ["The response was not valid JSON."] };
  }
  const parsed = (temporal ? videoAnalysisResponseSchema : analysisResponseSchema).safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.slice(0, 8).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    };
  }
  const errors: string[] = [];
  const wanted = new Set(batch.criterionKeys);
  const allowedInputs = new Map(media.map((m) => [m.inputId, m] as const));
  const sentInputs = new Set([...batch.referenceInputIds, ...batch.outputInputIds]);
  const seen = new Set<string>();
  const findings: NormalizedFinding[] = [];

  for (const a of parsed.data.criteria) {
    if (!wanted.has(a.criterionId)) {
      errors.push(
        `Unknown criterionId "${a.criterionId.slice(0, 60)}": only the criteria in DATA may be answered.`,
      );
      continue;
    }
    if (seen.has(a.criterionId)) {
      errors.push(`Duplicate answer for criterionId "${a.criterionId.slice(0, 60)}".`);
      continue;
    }
    seen.add(a.criterionId);
    const evidence: FindingEvidence[] = [];
    const who = `Evidence for "${a.criterionId.slice(0, 40)}"`;
    for (const e of a.evidence as Array<(typeof a.evidence)[number] & { endMs?: number | null }>) {
      if (!sentInputs.has(e.input)) {
        errors.push(`${who} cites "${e.input.slice(0, 40)}", which was not an input of this request.`);
        continue;
      }
      const m = allowedInputs.get(e.input);
      const problem = temporal ? videoEvidenceProblem(e, m) : stillEvidenceProblem(e, m);
      if (problem) {
        errors.push(`${who}: ${problem}`);
        continue;
      }
      evidence.push({
        input: e.input,
        assetId: m?.assetId ?? null,
        atMs: e.timestampMs ?? m?.atMs ?? null,
        ...(temporal ? { endMs: e.endMs ?? null } : {}),
        observation: e.observation,
        source: sourceOf(m),
      });
    }
    // a temporal judgement must say WHERE in the clip it was observed
    if (
      temporal &&
      a.result !== "unchecked" &&
      !evidence.some((x) => x.source === "video" && x.atMs != null)
    ) {
      errors.push(
        `Answer for "${a.criterionId.slice(0, 40)}" is ${a.result} but cites no timestamped evidence from the video.`,
      );
      continue;
    }
    findings.push({
      criterionKey: a.criterionId,
      result: a.result,
      confidence: a.confidence,
      summary: a.summary,
      evidence,
      contradictions: a.contradictions,
      limitations: a.limitations,
    });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, findings, missing: batch.criterionKeys.filter((k) => !seen.has(k)) };
}

/**
 * Direct-video evidence must point INTO the clip that was actually sent: a time, inside the duration, and an interval
 * that runs forward and ends inside the clip. (JSON cannot carry NaN/Infinity; integers are enforced by the schema.)
 */
/**
 * Direct-video evidence bounds, decided deliberately: both a moment and an interval end lie in the CLOSED range
 * [0, durationMs]. The recorded duration is treated as the clip's final instant, because provider timestamps are only
 * as precise as the sampling interval and an event in the last sample may be reported at the duration itself;
 * anything past it is rejected.
 */
function videoEvidenceProblem(
  e: { timestampMs: number | null; endMs?: number | null },
  m: AnalysisMedia | undefined,
): string | null {
  if (!m || m.kind !== "video") return "direct-video evidence must cite the video input.";
  if (e.timestampMs == null) return "video evidence needs timestampMs.";
  const duration = m.durationMs;
  if (duration == null || !Number.isFinite(duration)) return "the video duration is unknown.";
  if (e.timestampMs > duration)
    return `timestampMs ${e.timestampMs} is after the end of the clip (${duration} ms).`;
  if (e.endMs != null) {
    if (e.endMs < e.timestampMs) return `endMs ${e.endMs} is before timestampMs ${e.timestampMs}.`;
    if (e.endMs > duration) return `endMs ${e.endMs} is after the end of the clip (${duration} ms).`;
  }
  return null;
}

/** Still-image evidence may not invent time: a reference/contact sheet has none; a frame only its own position. */
function stillEvidenceProblem(
  e: { timestampMs: number | null },
  m: AnalysisMedia | undefined,
): string | null {
  if (e.timestampMs == null) return null;
  if (!m || m.kind === "reference" || m.kind === "contact_sheet")
    return `"${(m?.inputId ?? "?").slice(0, 40)}" is a still image: timestampMs must be null.`;
  if (m.kind === "output_frame" && m.atMs != null && e.timestampMs !== m.atMs)
    return `frame "${m.inputId.slice(0, 40)}" is at ${m.atMs} ms: timestampMs must be null or ${m.atMs}.`;
  return null;
}

/** The finding recorded for a criterion the provider could not or would not judge. */
export function uncheckedFinding(
  criterionKey: string,
  limitation: string,
  summary: string,
): NormalizedFinding {
  return {
    criterionKey,
    result: "unchecked",
    confidence: null,
    summary,
    evidence: [],
    contradictions: [],
    limitations: [limitation],
  };
}
