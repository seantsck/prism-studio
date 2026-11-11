import { z } from "zod";

/**
 * Phase 5B-S1: the PRODUCTION PROPOSAL — what Prism Story Intelligence proposes from a screenplay, treatment or outline.
 *
 * It is DATA, never an instruction to mutate the project: a provider returns it, Prism validates it strictly (this
 * file), persists it immutably and versioned, the creator reviews it, and deterministic application code (apply.ts)
 * creates Prism records only for what the creator selected. Every provider returns exactly this shape.
 *
 * Source traceability: every proposed Character, Location, Scene and Shot cites the 1-based LINE RANGES of the input
 * text it came from (the input is sent to the model with line numbers). Pages, for a PDF, are derived from the line
 * ranges by the stored page map. No source text is duplicated into the proposal.
 *
 * Unknowns stay unknown: the analyst instructions require "unknown" / "unspecified" / null rather than invented facts.
 */
export const PROPOSAL_SCHEMA_VERSION = "prism.production-proposal.v1" as const;

export const LIMITS = {
  characters: 200,
  locations: 200,
  scenes: 500,
  shots: 2000,
  sources: 40,
  beats: 30,
  shortText: 200,
  longText: 4000,
  list: 30,
} as const;

const CONFIDENCE = ["high", "medium", "low"] as const;
const INT_EXT = ["INT", "EXT", "INT/EXT", "unknown"] as const;
const BEAT_KINDS = ["beat", "emotional_turn", "key_action"] as const;

const short = z.string().max(LIMITS.shortText);
const long = z.string().max(LIMITS.longText);
const key = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z0-9_-]+$/);
const range = z
  .object({ startLine: z.number().int().min(1), endLine: z.number().int().min(1) })
  .strict()
  .refine((r) => r.endLine >= r.startLine, "endLine must be ≥ startLine");
const sources = z.array(range).max(LIMITS.sources);
const confidence = z.enum(CONFIDENCE);
const ambiguity = z
  .string()
  .max(LIMITS.shortText * 2)
  .nullable();

export const proposalSchema = z
  .object({
    story: z
      .object({
        title: short,
        logline: long,
        synopsis: long,
        tone: short,
        genre: short.nullable(),
        languages: z.array(short).max(LIMITS.list),
        notes: long,
      })
      .strict(),
    characters: z
      .array(
        z
          .object({
            key,
            name: short.min(1),
            role: short,
            description: long,
            ageRange: short.nullable(),
            personality: long,
            relationships: z
              .array(z.object({ characterKey: key, relation: short }).strict())
              .max(LIMITS.list),
            lookSuggestions: z.array(short).max(LIMITS.list),
            visualNotes: long,
            sources,
            confidence,
            ambiguity,
          })
          .strict(),
      )
      .max(LIMITS.characters),
    locations: z
      .array(
        z
          .object({
            key,
            name: short.min(1),
            description: long,
            intExt: z.enum(INT_EXT),
            timeStateNotes: short,
            recurringSet: z.boolean(),
            sources,
            confidence,
            ambiguity,
          })
          .strict(),
      )
      .max(LIMITS.locations),
    scenes: z
      .array(
        z
          .object({
            key,
            order: z.number().int().min(1),
            heading: short,
            locationKey: key.nullable(),
            timeOfDay: short,
            summary: long,
            purpose: long,
            characterKeys: z.array(key).max(LIMITS.list),
            beats: z
              .array(z.object({ kind: z.enum(BEAT_KINDS), description: short }).strict())
              .max(LIMITS.beats),
            sources,
            confidence,
            ambiguity,
          })
          .strict(),
      )
      .max(LIMITS.scenes),
    shots: z
      .array(
        z
          .object({
            key,
            sceneKey: key,
            order: z.number().int().min(1),
            purpose: short,
            characterKeys: z.array(key).max(LIMITS.list),
            locationKey: key.nullable(),
            visualIntent: long,
            sources,
          })
          .strict(),
      )
      .max(LIMITS.shots),
  })
  .strict();
export type ProductionProposal = z.infer<typeof proposalSchema>;
export type ProposalCharacter = ProductionProposal["characters"][number];
export type ProposalLocation = ProductionProposal["locations"][number];
export type ProposalScene = ProductionProposal["scenes"][number];
export type ProposalShot = ProductionProposal["shots"][number];
export type SourceRange = { startLine: number; endLine: number };

// ───────────────────────── strict JSON Schema (Structured Outputs) ─────────────────────────
// Every property is required; optional facts are nullable; no additional properties. Only the keywords the verified
// continuity schema already relies on are used (type, enum, items, maxItems, minimum, required,
// additionalProperties): string lengths and key patterns are enforced by `proposalSchema` after the answer arrives.
// Kept in lockstep with `proposalSchema` (a test walks both).
const S = () => ({ type: "string" });
const NS = () => ({ type: ["string", "null"] });
const I = (minimum = 1) => ({ type: "integer", minimum });
const E = (values: readonly string[]) => ({ type: "string", enum: [...values] });
const A = (items: unknown, maxItems: number) => ({ type: "array", items, maxItems });
const O = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const KEY = { type: "string" };
const NKEY = { type: ["string", "null"] };
const RANGE = O({ startLine: I(), endLine: I() });
const SOURCES = A(RANGE, LIMITS.sources);

export const PROPOSAL_JSON_SCHEMA = O({
  story: O({
    title: S(),
    logline: S(),
    synopsis: S(),
    tone: S(),
    genre: NS(),
    languages: A(S(), LIMITS.list),
    notes: S(),
  }),
  characters: A(
    O({
      key: KEY,
      name: S(),
      role: S(),
      description: S(),
      ageRange: NS(),
      personality: S(),
      relationships: A(O({ characterKey: KEY, relation: S() }), LIMITS.list),
      lookSuggestions: A(S(), LIMITS.list),
      visualNotes: S(),
      sources: SOURCES,
      confidence: E(CONFIDENCE),
      ambiguity: NS(),
    }),
    LIMITS.characters,
  ),
  locations: A(
    O({
      key: KEY,
      name: S(),
      description: S(),
      intExt: E(INT_EXT),
      timeStateNotes: S(),
      recurringSet: { type: "boolean" },
      sources: SOURCES,
      confidence: E(CONFIDENCE),
      ambiguity: NS(),
    }),
    LIMITS.locations,
  ),
  scenes: A(
    O({
      key: KEY,
      order: I(),
      heading: S(),
      locationKey: NKEY,
      timeOfDay: S(),
      summary: S(),
      purpose: S(),
      characterKeys: A(KEY, LIMITS.list),
      beats: A(O({ kind: E(BEAT_KINDS), description: S() }), LIMITS.beats),
      sources: SOURCES,
      confidence: E(CONFIDENCE),
      ambiguity: NS(),
    }),
    LIMITS.scenes,
  ),
  shots: A(
    O({
      key: KEY,
      sceneKey: KEY,
      order: I(),
      purpose: S(),
      characterKeys: A(KEY, LIMITS.list),
      locationKey: NKEY,
      visualIntent: S(),
      sources: SOURCES,
    }),
    LIMITS.shots,
  ),
});

// ───────────────────────── validation (shape + references + traceability) ─────────────────────────

export type ProposalValidation = { ok: true; proposal: ProductionProposal } | { ok: false; errors: string[] };

/**
 * The ONE gate every provider answer passes before anything is persisted: JSON → strict schema → referential
 * integrity (unique keys, every reference resolves, Scene order is 1..n without gaps) → every source range lies inside
 * the input. Errors are short and contain no source text. A malformed answer is never partially persisted.
 */
export function validateProposal(raw: unknown, sourceLineCount: number): ProposalValidation {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return { ok: false, errors: ["The answer is not valid JSON."] };
    }
  }
  const parsed = proposalSchema.safeParse(value);
  if (!parsed.success)
    return {
      ok: false,
      errors: parsed.error.issues.slice(0, 20).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    };
  const p = parsed.data;
  const errors: string[] = [];
  const unique = (name: string, keys: string[]) => {
    const seen = new Set<string>();
    for (const k of keys) {
      if (seen.has(k)) errors.push(`${name}: duplicate key "${k}"`);
      seen.add(k);
    }
    return seen;
  };
  const chars = unique(
    "characters",
    p.characters.map((c) => c.key),
  );
  const locs = unique(
    "locations",
    p.locations.map((l) => l.key),
  );
  const scenes = unique(
    "scenes",
    p.scenes.map((s) => s.key),
  );
  unique(
    "shots",
    p.shots.map((s) => s.key),
  );
  const ref = (where: string, set: Set<string>, k: string | null) => {
    if (k !== null && !set.has(k)) errors.push(`${where}: unknown reference "${k}"`);
  };
  for (const c of p.characters)
    for (const r of c.relationships) ref(`character ${c.key}`, chars, r.characterKey);
  for (const s of p.scenes) {
    ref(`scene ${s.key}`, locs, s.locationKey);
    for (const k of s.characterKeys) ref(`scene ${s.key}`, chars, k);
  }
  for (const s of p.shots) {
    ref(`shot ${s.key}`, scenes, s.sceneKey);
    ref(`shot ${s.key}`, locs, s.locationKey);
    for (const k of s.characterKeys) ref(`shot ${s.key}`, chars, k);
  }
  const orders = p.scenes.map((s) => s.order).sort((a, b) => a - b);
  if (orders.some((o, i) => o !== i + 1)) errors.push("scenes: order must run 1..n without gaps or repeats");
  const inRange = (where: string, rs: SourceRange[]) => {
    for (const r of rs)
      if (r.endLine > sourceLineCount)
        errors.push(`${where}: source lines ${r.startLine}-${r.endLine} are outside the input`);
  };
  for (const c of p.characters) inRange(`character ${c.key}`, c.sources);
  for (const l of p.locations) inRange(`location ${l.key}`, l.sources);
  for (const s of p.scenes) inRange(`scene ${s.key}`, s.sources);
  for (const s of p.shots) inRange(`shot ${s.key}`, s.sources);
  return errors.length ? { ok: false, errors: errors.slice(0, 20) } : { ok: true, proposal: p };
}

/** Counts for the "Proposal ready" summary. */
export const proposalCounts = (p: ProductionProposal) => ({
  characters: p.characters.length,
  locations: p.locations.length,
  scenes: p.scenes.length,
  shots: p.shots.length,
});
