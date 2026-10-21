import type { ShotContext } from "./context";
import { computeShotParts, FRESHNESS_PARTS, PART_LABELS, type FreshnessPart } from "./fingerprint";
import { purposeOfRequest, type GenerationPurpose } from "./generation/schemas";
import {
  checkProductionImage,
  draftProductionFrame,
  shotProductionAspect,
  type DraftResult,
} from "./production-frame";
import type { Asset, GenerationAttempt } from "./schemas";

/**
 * Phase 2G.2 — using a GENERATED still image as the Shot's Production Frame. Pure.
 *
 * A generation attempt for the `production_frame` purpose is exploratory history. It becomes canonical only when a
 * human chooses it ("Use as Production Frame") and only while it still depicts the Shot's current intent:
 *
 *   1. it is this Shot's, this Project's, a succeeded `production_frame` attempt with a still-image output;
 *   2. the Shot has not changed since (the stale rule below);
 *   3. a PRODUCTION-SHAPED image exists: the selected delivery conform, or the provider original when it already
 *      matches the production aspect. A wrong-aspect provider original is never promoted and never silently cropped.
 *
 * The Production Frame is then drafted by the SAME `draftProductionFrame` as every other source, with
 * `source = generation_output`; `attempt.approved` plays no part (selection is the one canonical pointer).
 */

export interface GeneratedFrameCandidate {
  attempt: Pick<
    GenerationAttempt,
    "id" | "projectId" | "shotId" | "status" | "request" | "packageSnapshot" | "packageFingerprint"
  >;
  /** The provider original (the attempt's primary image output). */
  original: Asset | null;
  /** The attempt's selected delivery master (a conform, or the original itself); null when none was selected. */
  delivery: Asset | null;
}

export type GeneratedFrameBlockCode =
  | "other_project"
  | "other_shot"
  | "not_production_frame_candidate"
  | "not_succeeded"
  | "no_output"
  | "not_image"
  | "stale"
  | "needs_conform"
  | "bad_image";

/** "lighting" → "Lighting"; the selected frame's own part reads as "Production Frame". */
const changedPartLabel = (p: string): string =>
  p === "productionFrame" ? "Production Frame" : (PART_LABELS[p as FreshnessPart] ?? p);

export const SHOT_CHANGED_MESSAGE =
  "The Shot changed after this candidate was generated. Regenerate it from the current Production Frame intent before using it.";
export const NEEDS_CONFORM_MESSAGE = "Create the production conform first.";

export type GeneratedFramePromotion =
  | {
      available: true;
      /** Which stored image becomes the Production Frame. */
      image: { asset: Asset; role: "delivery_conform" | "provider_original" };
    }
  | { available: false; code: GeneratedFrameBlockCode; reason: string; changedParts: string[] };

const blocked = (
  code: GeneratedFrameBlockCode,
  reason: string,
  changedParts: string[] = [],
): GeneratedFramePromotion => ({ available: false, code, reason, changedParts });

/** The Asset id of the Production Frame a candidate used as an image reference (null when it used none). */
export function referencedProductionFrameAssetId(request: unknown): string | null {
  const refs = (request as { references?: Array<{ role?: string; assetId?: string }> } | null)?.references;
  return refs?.find((r) => r.role === "production_frame")?.assetId ?? null;
}

/**
 * Which of the Shot's production inputs differ from the ones this candidate was generated from.
 *
 * The comparison is the attempt's frozen `packageSnapshot.provenance.parts` against the current Shot's, over the 13
 * NAMED parts (the Shot's intent: camera, blocking, characters, Looks, location, props, lighting, action,
 * performance, continuity, story, timing, constraints) — the same parts `provenance.parts.overall` is built from.
 * The selected Production Frame's own part is deliberately NOT compared as part of the intent, because choosing
 * candidate A must not make its sibling B "stale" (they were generated for the same intent; B is still a valid
 * candidate, and the human may still choose it). It matters in exactly one way, handled here: a candidate that used
 * the Production Frame as its image reference is stale once ANOTHER frame became canonical (it was an edit of v1,
 * and v2 is now the basis).
 *
 * Returns null when nothing changed; `unknown` when the snapshot cannot be compared (never treated as fresh).
 */
export function generatedFrameStaleness(
  ctx: ShotContext,
  attempt: Pick<GeneratedFrameCandidate["attempt"], "id" | "request" | "packageSnapshot">,
): { changed: string[]; unknown: boolean } | null {
  const snap = (attempt.packageSnapshot as { provenance?: { parts?: Record<string, string> } } | null)
    ?.provenance?.parts;
  if (!snap || typeof snap !== "object") return { changed: [], unknown: true };
  const now = computeShotParts(ctx);
  const changed: string[] = FRESHNESS_PARTS.filter((p) => snap[p] !== undefined && snap[p] !== now[p]);
  const used = referencedProductionFrameAssetId(attempt.request);
  const selected = ctx.selectedProductionFrame;
  // A refinement of v1 is stale once ANOTHER frame is canonical. When the canonical frame IS this very candidate
  // (it was promoted already), using it again is the duplicate-promotion path, not a stale one.
  if (used && used !== (selected?.assetId ?? null) && selected?.sourceGenerationAttemptId !== attempt.id)
    changed.push("productionFrame");
  return changed.length > 0 ? { changed, unknown: false } : null;
}

/** Whether "Use as Production Frame" is available for a candidate right now, and if not, the truthful reason. */
export function generatedFramePromotion(
  ctx: ShotContext,
  c: GeneratedFrameCandidate,
): GeneratedFramePromotion {
  const a = c.attempt;
  if (a.projectId !== ctx.project.id)
    return blocked("other_project", "That generation belongs to a different project.");
  if (a.shotId !== ctx.shot.id) return blocked("other_shot", "That generation belongs to a different Shot.");
  if (purposeOfRequest((a.request ?? {}) as { purpose?: GenerationPurpose }) !== "production_frame")
    return blocked(
      "not_production_frame_candidate",
      "This generation was not made as a Production Frame candidate.",
    );
  if (a.status !== "succeeded")
    return blocked("not_succeeded", "Only a completed generation can become the Production Frame.");
  if (!c.original || c.original.projectId !== ctx.project.id)
    return blocked("no_output", "This generation has no image output in this project.");
  if (c.original.type !== "image")
    return blocked("not_image", "A Production Frame must be an image; this output is not.");

  const stale = generatedFrameStaleness(ctx, a);
  if (stale) {
    return blocked(
      "stale",
      stale.unknown
        ? `${SHOT_CHANGED_MESSAGE} (Prism cannot verify what this candidate was generated from.)`
        : `${SHOT_CHANGED_MESSAGE} (Changed: ${stale.changed.map(changedPartLabel).join(", ")}.)`,
      stale.changed,
    );
  }

  // image source: the selected production-shaped delivery conform first, else the provider original
  const aspect = shotProductionAspect(ctx.shot, ctx.bible);
  const order: Array<{ asset: Asset; role: "delivery_conform" | "provider_original" }> = [];
  if (c.delivery && c.delivery.id !== c.original.id && c.delivery.projectId === ctx.project.id)
    order.push({ asset: c.delivery, role: "delivery_conform" });
  order.push({ asset: c.original, role: "provider_original" });
  let firstProblem: { code: string; message: string } | null = null;
  for (const candidate of order) {
    const r = checkProductionImage(candidate.asset, aspect);
    if (r.ok) return { available: true, image: candidate };
    firstProblem ??= r.problem;
  }
  // every stored version is the wrong shape: the conform must be created, never a silent crop
  const originalProblem = checkProductionImage(c.original, aspect);
  if (!originalProblem.ok && originalProblem.problem.code === "wrong_aspect") {
    return blocked("needs_conform", NEEDS_CONFORM_MESSAGE);
  }
  return blocked("bad_image", firstProblem?.message ?? "This output is not usable as a Production Frame.");
}

/** Drafts the Production Frame for a promotable candidate through the one shared `draftProductionFrame`. */
export function draftGeneratedProductionFrame(
  ctx: ShotContext,
  c: GeneratedFrameCandidate,
  input: { id: string; now: string; userId: string | null },
):
  | {
      ok: true;
      draft: Extract<DraftResult, { ok: true }>["draft"];
      image: "delivery_conform" | "provider_original";
    }
  | { ok: false; reason: string; code: GeneratedFrameBlockCode | "bad_image" } {
  const promo = generatedFramePromotion(ctx, c);
  if (!promo.available) return { ok: false, reason: promo.reason, code: promo.code };
  const drafted = draftProductionFrame(ctx, {
    id: input.id,
    now: input.now,
    userId: input.userId,
    source: "generation_output",
    sourceGenerationAttemptId: c.attempt.id,
    asset: promo.image.asset,
  });
  if (!drafted.ok) return { ok: false, reason: drafted.problem.message, code: "bad_image" };
  return { ok: true, draft: drafted.draft, image: promo.image.role };
}
