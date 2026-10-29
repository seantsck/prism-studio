import { describe, expect, it } from "vitest";
import { ctx, makeInput, mediaFor } from "@/continuity/analysis/__tests__/fixtures";
import { AnalysisBatchError } from "@/continuity/analysis/provider";
import { responseJsonSchemaFor, validateBatchResponse } from "@/domain/continuity/analysis/schema";
import { GeminiAnalysisProvider } from "../analyzer";
import { readGeminiConfig } from "../config";
import { FakeGeminiTransport, answerAll, type FakeStep } from "../fake-transport";
import { geminiResponseJsonSchema } from "../response-schema";
import type { GeminiRequest, GeminiTransport } from "../transport";

/**
 * The Gemini-facing structured-output schema (offline). Gemini refused the neutral schema with HTTP 400
 * INVALID_ARGUMENT for a one-criterion direct-video batch (diagnosed live, 2026-10-28); the compact, batch-aware
 * schema was accepted. These tests pin its constructs and prove local validation stays the stricter boundary.
 */
const cfg = readGeminiConfig({ PRISM_STUDIO_CONTINUITY_ANALYZERS: "gemini", GEMINI_API_KEY: "k" });

/** Every schema-keyword used anywhere in a schema node (property NAMES are not keywords). */
function keywords(node: unknown, out = new Set<string>()): Set<string> {
  if (!node || typeof node !== "object" || Array.isArray(node)) return out;
  for (const [k, v] of Object.entries(node)) {
    out.add(k);
    if (k === "properties") for (const child of Object.values(v as object)) keywords(child, out);
    else if (k === "items") keywords(v, out);
  }
  return out;
}
/** Every maxItems in the schema, by path. */
function maxItems(node: unknown, at = "$", out: Record<string, number> = {}): Record<string, number> {
  if (!node || typeof node !== "object" || Array.isArray(node)) return out;
  const n = node as Record<string, unknown>;
  if (typeof n.maxItems === "number") out[at] = n.maxItems;
  if (n.properties)
    for (const [k, v] of Object.entries(n.properties as object)) maxItems(v, `${at}.${k}`, out);
  if (n.items) maxItems(n.items, `${at}[]`, out);
  return out;
}
const drop = (node: unknown): unknown =>
  Array.isArray(node)
    ? node.map(drop)
    : node && typeof node === "object"
      ? Object.fromEntries(
          Object.entries(node)
            .filter(([k]) => !["maxItems", "minItems", "minimum", "maximum"].includes(k))
            .map(([k, v]) => [k, drop(v)]),
        )
      : node;

describe("Gemini response schema: compact and batch-aware", () => {
  for (const mode of ["direct_video", "image_set"] as const) {
    it(`${mode}: only the intended constructs; criteria.maxItems is the batch's criterion count`, () => {
      for (const n of [1, 3, 12]) {
        const s = geminiResponseJsonSchema(mode, n);
        expect([...keywords(s)].sort()).toEqual(
          [
            "additionalProperties",
            "description",
            "enum",
            "items",
            "maxItems",
            "properties",
            "required",
            "type",
          ].sort(),
        );
        // the ONLY count left is the root criteria array, and it is N (never the neutral 40)
        expect(maxItems(s)).toEqual({ "$.criteria": n });
        expect(JSON.stringify(s)).not.toMatch(/"(minimum|maximum|minItems)"/);
      }
    });

    it(`${mode}: the shape (types, nullable unions, enums, required, closed objects) is the neutral schema's`, () => {
      const s = geminiResponseJsonSchema(mode, 1) as { properties: { criteria: Record<string, unknown> } };
      const criteria = { ...s.properties.criteria };
      delete criteria.maxItems;
      expect({ ...s, properties: { criteria } }).toEqual(drop(responseJsonSchemaFor(mode)));
    });
  }

  it("a one-criterion calibration-shaped batch does not advertise 40 criteria", () => {
    expect(responseJsonSchemaFor("direct_video").properties.criteria.maxItems).toBe(40); // neutral, unchanged
    expect(geminiResponseJsonSchema("direct_video", 1).properties.criteria.maxItems).toBe(1);
  });

  it("refuses a non-positive or fractional criterion count", () => {
    for (const bad of [0, -1, 1.5, Number.NaN])
      expect(() => geminiResponseJsonSchema("image_set", bad)).toThrow();
  });
});

describe("direct-video: what the compact schema no longer encodes, local validation still rejects", () => {
  const vb = {
    criterionKeys: ["c1"],
    referenceInputIds: [],
    outputInputIds: ["video"],
    mode: "direct_video" as const,
  };
  const vmedia = [
    {
      inputId: "video",
      kind: "video" as const,
      role: "output_video" as const,
      label: "v",
      assetId: "a",
      checksum: "x",
      mime: "video/mp4",
      width: 640,
      height: 360,
      byteSize: 1,
      durationMs: 2000,
      atMs: null,
    },
  ];
  const ev = { input: "video", timestampMs: 500, endMs: null, observation: "Seen." };
  const a = (over: Record<string, unknown> = {}) => ({
    criterionId: "c1",
    result: "pass",
    confidence: 0.5,
    summary: "s",
    evidence: [ev],
    contradictions: [],
    limitations: [],
    ...over,
  });
  const ok = (criteria: unknown[]) => validateBatchResponse(JSON.stringify({ criteria }), vb, vmedia).ok;

  it("a valid one-criterion video answer passes (control)", () => expect(ok([a()])).toBe(true));
  for (const [name, criteria] of [
    ["confidence below 0", [a({ confidence: -0.1 })]],
    ["confidence above 1", [a({ confidence: 1.01 })]],
    ["more than 8 evidence items", [a({ evidence: Array.from({ length: 9 }, () => ev) })]],
    ["more than 6 contradictions", [a({ contradictions: Array.from({ length: 7 }, (_, i) => `c${i}`) })]],
    ["more than 6 limitations", [a({ limitations: Array.from({ length: 7 }, (_, i) => `l${i}`) })]],
    ["a duplicate criterion id", [a(), a()]],
    ["an unknown criterion id", [a({ criterionId: "other" })]],
    ["an unexpected key", [a({ score: 3 })]],
  ] as const)
    it(`rejects ${name}`, () => expect(ok([...criteria])).toBe(false));
});

describe("the analyzer sends the compact schema, and local validation stays stricter than it", () => {
  const input = makeInput();
  const batch = input.plan.batches[0]!;
  const capture = (step: (r: GeminiRequest) => FakeStep) => {
    const inner = new FakeGeminiTransport(step);
    const sent: GeminiRequest[] = [];
    const transport: GeminiTransport = {
      generate: (r) => {
        sent.push(r);
        return inner.generate(r);
      },
    };
    return { sent, provider: new GeminiAnalysisProvider({ config: cfg, transport }) };
  };
  const run = (p: GeminiAnalysisProvider) =>
    p.analyzeBatch({ batch, input, media: mediaFor(input), ctx: { ...ctx(), canCorrect: () => false } });
  const answer = (key: string, over: Record<string, unknown> = {}) => ({
    criterionId: key,
    result: "pass",
    confidence: 0.9,
    summary: "Consistent.",
    evidence: [{ input: "frame:0", timestampMs: null, observation: "Visible." }],
    contradictions: [],
    limitations: [],
    ...over,
  });

  it("the request carries geminiResponseJsonSchema(mode, the batch's criterion count)", async () => {
    const { sent, provider } = capture(answerAll());
    await run(provider);
    expect(sent[0]!.responseJsonSchema).toEqual(
      geminiResponseJsonSchema(batch.mode, batch.criterionKeys.length),
    );
  });

  for (const [name, over] of [
    ["confidence above 1", { confidence: 1.5 }],
    ["negative timestamp", { evidence: [{ input: "frame:0", timestampMs: -5, observation: "x" }] }],
    [
      "more than 8 evidence items",
      {
        evidence: Array.from({ length: 9 }, () => ({
          input: "frame:0",
          timestampMs: null,
          observation: "x",
        })),
      },
    ],
    ["more than 6 limitations", { limitations: Array.from({ length: 7 }, (_, i) => `l${i}`) }],
    ["an unknown input id", { evidence: [{ input: "not-sent", timestampMs: null, observation: "x" }] }],
  ] as const) {
    it(`an answer the compact schema allows but Prism forbids (${name}) is still rejected locally`, async () => {
      const { provider } = capture(() => ({
        kind: "json",
        body: { criteria: batch.criterionKeys.map((k, i) => (i === 0 ? answer(k, over) : answer(k))) },
      }));
      const err = await run(provider).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AnalysisBatchError);
      expect((err as AnalysisBatchError).category).toBe("schema_invalid");
    });
  }

  it("the schema-CORRECTION request carries the same compact batch-aware schema as the first request", async () => {
    const { sent, provider } = capture(
      (() => {
        let n = 0;
        return (r: GeminiRequest): FakeStep =>
          n++ === 0 ? { kind: "text", text: "{ not json" } : answerAll()(r);
      })(),
    );
    const out = await provider.analyzeBatch({ batch, input, media: mediaFor(input), ctx: ctx() });
    expect(out.correctionUsed).toBe(true);
    expect(sent).toHaveLength(2);
    const expected = geminiResponseJsonSchema(batch.mode, batch.criterionKeys.length);
    expect(sent[0]!.responseJsonSchema).toEqual(expected);
    expect(sent[1]!.responseJsonSchema).toEqual(expected);
  });

  it("more criteria than were sent is rejected locally (the schema count is an aid, not the check)", async () => {
    const { provider } = capture(() => ({
      kind: "json",
      body: { criteria: [...batch.criterionKeys.map((k) => answer(k)), answer("not-a-sent-criterion")] },
    }));
    const err = await run(provider).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnalysisBatchError);
  });
});
