import { responseJsonSchemaFor } from "@/domain/continuity/analysis/schema";
import type { AnalysisMode } from "@/domain/continuity/analysis/types";

/** Constraints dropped from the Gemini-facing schema: counting and numeric bounds (see below). */
const DROPPED = new Set(["maxItems", "minItems", "minimum", "maximum"]);

function strip(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strip);
  if (!node || typeof node !== "object") return node;
  return Object.fromEntries(
    Object.entries(node)
      .filter(([k]) => !DROPPED.has(k))
      .map(([k, v]) => [k, k === "enum" || k === "required" ? v : strip(v)]),
  );
}

/**
 * The structured-output schema SENT TO GEMINI (constrained decoding), derived from the provider-neutral schema.
 *
 * Gemini rejects a response schema whose constraint state is too large with HTTP 400 INVALID_ARGUMENT. Diagnosed live
 * on 2026-10-28 with a sacrificial synthetic clip: the neutral direct-video schema (criteria ≤ 40 objects, each with
 * evidence ≤ 8 objects and two string arrays ≤ 6, numeric bounds, nullable integers) was refused for a ONE-criterion
 * batch, while the identical request with a minimal schema was accepted. So this keeps the SHAPE (types, nullable
 * unions, enums, required, `additionalProperties: false`, descriptions) and drops the counting and numeric
 * constraints: every `maxItems`/`minItems`/`minimum`/`maximum`, with `criteria.maxItems` set to the batch's actual
 * criterion count instead of 40.
 *
 * Nothing is weakened: Prism's strict local validation (`validateBatchResponse`: Zod bounds, sent criterion ids, sent
 * inputs, timestamps within the clip, duplicates, evidence rules) runs on every answer and remains the correctness
 * boundary; this schema is only an output-generation aid. The OpenAI adapter keeps the neutral schema.
 */
export function geminiResponseJsonSchema(mode: AnalysisMode, criteriaCount: number) {
  if (!Number.isInteger(criteriaCount) || criteriaCount < 1)
    throw new Error("A Gemini response schema needs a positive integer criterion count.");
  const schema = strip(responseJsonSchemaFor(mode)) as {
    properties: { criteria: Record<string, unknown> };
  } & Record<string, unknown>;
  return {
    ...schema,
    properties: {
      ...schema.properties,
      criteria: { ...schema.properties.criteria, maxItems: criteriaCount },
    },
  };
}
