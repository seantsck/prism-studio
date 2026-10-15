import { z } from "zod";
import {
  FINDING_RESULTS,
  type AnalysisBatch,
  type AnalysisMedia,
  type EvidenceSource,
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
  batch: Pick<AnalysisBatch, "criterionKeys" | "referenceInputIds" | "outputInputIds">,
  media: AnalysisMedia[],
): ValidationOutcome {
  if (raw == null || raw.trim() === "") return { ok: false, errors: ["The response was empty."] };
  if (raw.length > MAX_RESPONSE_CHARS)
    return { ok: false, errors: [`The response exceeded ${MAX_RESPONSE_CHARS} characters.`] };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, errors: ["The response was not valid JSON."] };
  }
  const parsed = analysisResponseSchema.safeParse(json);
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
    const evidence = [];
    for (const e of a.evidence) {
      if (!sentInputs.has(e.input)) {
        errors.push(
          `Evidence for "${a.criterionId.slice(0, 40)}" cites "${e.input.slice(0, 40)}", which was not an input of this request.`,
        );
        continue;
      }
      const m = allowedInputs.get(e.input);
      evidence.push({
        input: e.input,
        assetId: m?.assetId ?? null,
        atMs: e.timestampMs ?? m?.atMs ?? null,
        observation: e.observation,
        source: sourceOf(m),
      });
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
