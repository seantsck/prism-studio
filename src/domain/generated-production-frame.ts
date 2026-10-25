import type { ShotContext } from "./context";
import { computeShotParts, FRESHNESS_PARTS, PART_LABELS, type FreshnessPart } from "./fingerprint";
import { parseGenerationPurpose, purposeOfRequest, type GenerationPurpose } from "./generation/schemas";
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
 *   2. its CANDIDATE INPUT BASIS (what it was actually generated from, frozen on the attempt) still holds;
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

/** The input-basis component that names the Production Frame a candidate used as its image reference. */
export const PRODUCTION_FRAME_REFERENCE = "productionFrameReference" as const;

/** "lighting" → "Lighting changed"; the referenced frame reads as "Production Frame reference changed". */
export const changedPartText = (p: string): string =>
  p === PRODUCTION_FRAME_REFERENCE
    ? "Production Frame reference changed"
    : `${PART_LABELS[p as FreshnessPart] ?? p} changed`;

export const SHOT_CHANGED_MESSAGE =
  "The Shot changed after this candidate was generated. Regenerate it from the current Production Frame intent before using it.";
export const REFERENCE_CHANGED_MESSAGE =
  "This candidate was generated from a Production Frame that is no longer the canonical one. Regenerate it from the current Production Frame before using it.";
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

/**
 * THE CANDIDATE INPUT BASIS (Phase 2G.2): what a Production Frame candidate was ACTUALLY generated from, reconstructed
 * only from the attempt's own frozen records, never from whatever happens to be selected today.
 *
 * Three related but distinct identities exist; this is the third:
 *   1. `GenerationPackage.provenance.fingerprint`   exact frozen package identity (attempts, sets, exports keep it)
 *   2. `GenerationPackage.provenance.parts.overall` the Shot's production-input identity: the 13 named parts PLUS the
 *                                                   currently selected Production Frame (2G.1)
 *   3. the candidate input basis (this)             the 13 named parts the candidate was generated from, plus the
 *                                                   Production Frame ONLY IF that frame was one of its image inputs
 * A candidate is NOT judged by (2): `parts.overall` changes whenever ANY frame is selected, so selecting sibling A
 * would wrongly stale B and C, which were generated from the same Shot truth and never saw A.
 */
export interface CandidateInputBasis {
  /** The 13 named Shot part fingerprints frozen in `packageSnapshot.provenance.parts` (null = not recorded). */
  namedParts: Partial<Record<FreshnessPart, string>> | null;
  /**
   * The Production Frame this candidate received as an image reference, or null when it used none. `assetId` comes from
   * the frozen request (what was actually sent); the frame identity comes from the frozen package snapshot. Phase 2H:
   * for an `animate_production_frame` attempt it is the request's START FRAME (the frame is never also a reference).
   */
  productionFrameReference: { assetId: string; frameId: string | null; version: number | null } | null;
  /**
   * Phase 2G.3: the canonical Location View this candidate received as an image reference, or null when none was SENT
   * (no view selected, the view's image went under a more specific role, or the model took no images). Read from the
   * frozen request only, never inferred from today's selection. The view's identity is also inside the frozen
   * `location` part, so choosing another view stales the candidate through `namedParts`.
   */
  locationViewReference: { assetId: string; viewId: string | null } | null;
  /**
   * Phase 2G.4: per Character, the Character Continuity Lock this candidate was generated under (from the frozen
   * package snapshot) and which of the Lock's images were actually SENT (from the frozen request; an image that went
   * under a more specific role, or a model that took no images, sends none). Empty when no Lock was selected. Each
   * Lock's identity is also inside the frozen `characters` / `looks` parts, so choosing another Lock stales the
   * candidate through `namedParts`, while editing the live library under the SAME Lock does not.
   */
  characterContinuityReferences: Array<{
    characterId: string;
    lockId: string;
    lockFingerprint: string;
    sentAssetIds: string[];
  }>;
}

/** Reconstructs a candidate's input basis from its frozen request and package snapshot alone. */
export function candidateInputBasis(
  attempt: Pick<GeneratedFrameCandidate["attempt"], "request" | "packageSnapshot">,
): CandidateInputBasis {
  const snap = attempt.packageSnapshot as {
    provenance?: { parts?: Record<string, string> };
    references?: {
      productionFrame?: { frameId?: string; assetId?: string; version?: number };
      locationView?: { viewId?: string; assetId?: string };
      characterContinuity?: Array<{
        characterId?: string;
        lockId?: string;
        lockFingerprint?: string;
        references?: Array<{ assetId?: string }>;
      }>;
    };
  } | null;
  const parts = snap?.provenance?.parts;
  const namedParts =
    parts && typeof parts === "object"
      ? (Object.fromEntries(
          FRESHNESS_PARTS.filter((p) => typeof parts[p] === "string").map((p) => [p, parts[p]!]),
        ) as Partial<Record<FreshnessPart, string>>)
      : null;
  const request = attempt.request as {
    purpose?: unknown;
    startFrameAssetId?: unknown;
    references?: Array<{ role?: string; assetId?: string }>;
  } | null;
  const refs = request?.references;
  // an animation's Production Frame is its exact first frame (2H); a still candidate's is a reference image (2G.2)
  const animatedFrom =
    parseGenerationPurpose(request?.purpose) === "animate_production_frame" &&
    typeof request?.startFrameAssetId === "string"
      ? request.startFrameAssetId
      : null;
  const usedAssetId = animatedFrom ?? refs?.find((r) => r.role === "production_frame")?.assetId ?? null;
  const viewAssetId = refs?.find((r) => r.role === "location_view")?.assetId ?? null;
  const lv = snap?.references?.locationView;
  const pf = snap?.references?.productionFrame;
  const sentCharacterImages = new Set(
    (refs ?? [])
      .filter((r) => r.role === "identity" || r.role === "character_look")
      .flatMap((r) => (r.assetId ? [r.assetId] : [])),
  );
  const characterContinuityReferences = (snap?.references?.characterContinuity ?? []).flatMap((l) =>
    l.characterId && l.lockId && l.lockFingerprint
      ? [
          {
            characterId: l.characterId,
            lockId: l.lockId,
            lockFingerprint: l.lockFingerprint,
            sentAssetIds: (l.references ?? []).flatMap((r) =>
              r.assetId && sentCharacterImages.has(r.assetId) ? [r.assetId] : [],
            ),
          },
        ]
      : [],
  );
  return {
    namedParts: namedParts && Object.keys(namedParts).length > 0 ? namedParts : null,
    productionFrameReference: usedAssetId
      ? {
          assetId: usedAssetId,
          frameId: pf && pf.assetId === usedAssetId ? (pf.frameId ?? null) : null,
          version: pf && pf.assetId === usedAssetId ? (pf.version ?? null) : null,
        }
      : null,
    locationViewReference: viewAssetId
      ? { assetId: viewAssetId, viewId: lv && lv.assetId === viewAssetId ? (lv.viewId ?? null) : null }
      : null,
    characterContinuityReferences,
  };
}

/**
 * Which parts of a candidate's input basis no longer hold. Named parts: any frozen part that differs from the Shot now.
 * Production Frame reference: only when the candidate USED one, and another frame is canonical now (it was an edit of
 * v1 and v2 is now the basis). When the canonical frame IS this very candidate, using it again is the
 * duplicate-promotion path, not staleness.
 *
 * Returns null when the basis holds; `unknown` when the basis cannot be reconstructed (never treated as fresh).
 */
export function candidateInputStaleness(
  ctx: ShotContext,
  attempt: Pick<GeneratedFrameCandidate["attempt"], "id" | "request" | "packageSnapshot">,
): { changed: string[]; unknown: boolean } | null {
  const basis = candidateInputBasis(attempt);
  if (!basis.namedParts) return { changed: [], unknown: true };
  const now = computeShotParts(ctx);
  const changed: string[] = FRESHNESS_PARTS.filter(
    (p) => basis.namedParts![p] !== undefined && basis.namedParts![p] !== now[p],
  );
  const ref = basis.productionFrameReference;
  const selected = ctx.selectedProductionFrame;
  if (ref && selected?.sourceGenerationAttemptId !== attempt.id) {
    const stillCanonical = ref.frameId ? selected?.id === ref.frameId : selected?.assetId === ref.assetId;
    if (!stillCanonical) changed.push(PRODUCTION_FRAME_REFERENCE);
  }
  return changed.length > 0 ? { changed, unknown: false } : null;
}

/** The generation attempt behind the Shot's CURRENT Production Frame (null when none, or not generated). */
export function currentProductionFrameAttemptId(ctx: ShotContext): string | null {
  return ctx.selectedProductionFrame?.sourceGenerationAttemptId ?? null;
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

  const stale = candidateInputStaleness(ctx, a);
  if (stale) {
    // only the referenced frame moved (the Shot itself did not change): say exactly that
    const lead =
      !stale.unknown && stale.changed.every((p) => p === PRODUCTION_FRAME_REFERENCE)
        ? REFERENCE_CHANGED_MESSAGE
        : SHOT_CHANGED_MESSAGE;
    return blocked(
      "stale",
      stale.unknown
        ? `${SHOT_CHANGED_MESSAGE} (Prism cannot verify what this candidate was generated from.)`
        : `${lead} (${stale.changed.map(changedPartText).join("; ")}.)`,
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
