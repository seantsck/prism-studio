import type { ShotContext } from "../context";
import { PART_LABELS, type FreshnessPart } from "../fingerprint";
import {
  candidateInputStaleness,
  changedPartText,
  PRODUCTION_FRAME_REFERENCE,
} from "../generated-production-frame";
import type { GenerationPackage } from "../generation-package";
import type { GenerationAttempt } from "../schemas";
import { isAnimationAttempt, parseGenerationPurpose, type GenerationRequest } from "./schemas";

/**
 * Phase 2H — Image-to-Video from the canonical Production Frame. Pure.
 *
 * `animate_production_frame` is a Shot-OUTPUT generation with one non-negotiable source rule:
 *
 *   THE SELECTED, CURRENT PRODUCTION FRAME IS THE EXACT FIRST-FRAME IMAGE SUPPLIED TO THE VIDEO MODEL.
 *
 * Never an approved or draft Storyboard, never a manual start-frame override that differs from it, never text-to-video,
 * never a stale frame, never the frame sent a second time as a reference. Everything here reads the frozen
 * GenerationPackage (v5 already freezes the selected frame by value) and the frozen request: no new state, no new
 * package version. Generic "Generate" keeps its historical start-frame precedence; only this workflow is stricter.
 */

export const ANIMATE_NO_PRODUCTION_FRAME = "Choose a Production Frame before animating this Shot.";
export const ANIMATE_OVERRIDE_CONFLICT =
  "This Shot has a manual start-frame override that differs from the canonical Production Frame. Clear the override or use the generic Generate workflow.";
export const ANIMATE_STALE_LEAD =
  "The selected Production Frame no longer matches the Shot. Update, reselect or create a current Production Frame before animating.";
export const ANIMATE_REQUIRES_EXACT_FIRST_FRAME =
  "Animate Production Frame requires exact first-frame conditioning.";
export const ANIMATE_REQUIRES_IMAGE_TO_VIDEO =
  "This workflow requires image-to-video from the canonical Production Frame.";
export const ANIMATE_NO_REFERENCE_MODE =
  "Reference mode would turn the Production Frame into a reference image instead of the exact first frame. Animate Production Frame always uses keyframe mode.";
/** Keyframe mode on a model whose first/last frames exclude reference images (Seedance, Hailuo...). */
export const ANIMATE_KEYFRAME_DISCLOSURE =
  "Character and Location reference images are not separately supplied because this model's exact first-frame mode excludes reference images. Their approved appearance is already represented by the Production Frame.";

export type AnimationSourceIssueCode =
  "no_production_frame" | "start_override_conflict" | "production_frame_stale";

export interface AnimationSourceIssue {
  code: AnimationSourceIssueCode;
  message: string;
  /** Only for `production_frame_stale`: the named parts that changed since the frame was made. */
  changedParts: FreshnessPart[];
}

/** The frozen identity of the frame an animation starts from (all from the package, nothing new stored). */
export interface AnimationSourceFrame {
  frameId: string;
  assetId: string;
  version: number;
  intentFingerprint: string;
  /** The image's checksum as described by value in the package (null when the Asset is not described). */
  checksum: string | null;
}

export type AnimationSource =
  | { ok: true; frame: AnimationSourceFrame }
  | { ok: false; frame: AnimationSourceFrame | null; issues: AnimationSourceIssue[] };

/**
 * May this Shot be animated from its Production Frame right now, and if not, every reason why. Hard source-integrity
 * rules (never acknowledgeable): a selected frame exists, it is fresh, and no different manual start frame is set.
 */
export function animationSource(pkg: GenerationPackage): AnimationSource {
  const pf = pkg.references.productionFrame;
  if (!pf)
    return {
      ok: false,
      frame: null,
      issues: [{ code: "no_production_frame", message: ANIMATE_NO_PRODUCTION_FRAME, changedParts: [] }],
    };
  const frame: AnimationSourceFrame = {
    frameId: pf.frameId,
    assetId: pf.assetId,
    version: pf.version,
    intentFingerprint: pf.intentFingerprint,
    checksum: pkg.assets[pf.assetId]?.checksum ?? null,
  };
  const issues: AnimationSourceIssue[] = [];
  // The package's start frame follows the generic precedence (explicit override → Production Frame → Storyboard).
  // With a frame selected, a different start frame can only be the Shot's explicit override: never ignored, never used.
  const start = pkg.references.startFrameAssetId;
  if (start && start !== pf.assetId)
    issues.push({ code: "start_override_conflict", message: ANIMATE_OVERRIDE_CONFLICT, changedParts: [] });
  if (pf.freshness === "stale") {
    const why = pkg.freshness.productionFrame?.messages.length
      ? pkg.freshness.productionFrame.messages
      : pf.changedParts.map((p) => `${PART_LABELS[p]} changed after this Production Frame was made.`);
    issues.push({
      code: "production_frame_stale",
      message: `${ANIMATE_STALE_LEAD} ${why.join(" ")}`.trim(),
      changedParts: [...pf.changedParts],
    });
  }
  return issues.length === 0 ? { ok: true, frame } : { ok: false, frame, issues };
}

/**
 * THE ADAPTER INVARIANT (§50). Checked before an attempt is created AND again by the worker right before the provider
 * call: for an `animate_production_frame` request the provider may only ever receive image-to-video whose start frame
 * is exactly the Production Frame frozen in the attempt's package. Returns the violations (empty = holds). Requests of
 * any other purpose are not this rule's business (empty).
 */
export function animationRequestViolations(
  request: Pick<GenerationRequest, "modality" | "startFrameAssetId" | "references"> & { purpose?: unknown },
  packageSnapshot: unknown,
): string[] {
  if (parseGenerationPurpose(request.purpose) !== "animate_production_frame") return [];
  const out: string[] = [];
  const frozen = (packageSnapshot as { references?: { productionFrame?: { assetId?: unknown } } } | null)
    ?.references?.productionFrame?.assetId;
  if (request.modality !== "image_to_video")
    out.push(`Animate Production Frame must be image-to-video (was ${request.modality}).`);
  if (!request.startFrameAssetId) out.push("Animate Production Frame has no start frame.");
  if (typeof frozen !== "string" || !frozen)
    out.push("The frozen package has no Production Frame to animate.");
  else if (request.startFrameAssetId && request.startFrameAssetId !== frozen)
    out.push("The start frame is not the frozen Production Frame.");
  if (
    request.references.some(
      (r) =>
        r.role === "production_frame" ||
        (request.startFrameAssetId && r.assetId === request.startFrameAssetId),
    )
  )
    out.push("The Production Frame is the start frame only; it must not also be sent as a reference.");
  return out;
}

/** What an animation attempt was animated FROM, read only from its own frozen records (§25, §41). */
export interface AnimationProvenance {
  frameId: string | null;
  version: number | null;
  /** The Production Frame image frozen in the package. */
  frameAssetId: string | null;
  checksum: string | null;
  intentFingerprint: string | null;
  /** What the frozen request actually supplied as the first frame. */
  startFrameAssetId: string | null;
  /**
   * Deterministic provenance check: the frozen request's start frame IS the frozen Production Frame Asset. This is
   * integrity of the inputs, not computer vision: it never claims the provider's first output frame matches pixels.
   */
  firstFrameMatches: boolean;
}

export function animationProvenance(
  attempt: Pick<GenerationAttempt, "request" | "packageSnapshot">,
): AnimationProvenance | null {
  if (!isAnimationAttempt(attempt)) return null;
  const snap = attempt.packageSnapshot as {
    references?: {
      productionFrame?: {
        frameId?: unknown;
        assetId?: unknown;
        version?: unknown;
        intentFingerprint?: unknown;
      };
    };
    assets?: Record<string, { checksum?: unknown }>;
  } | null;
  const pf = snap?.references?.productionFrame;
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  const frameAssetId = str(pf?.assetId);
  const start = str((attempt.request as { startFrameAssetId?: unknown } | null)?.startFrameAssetId);
  return {
    frameId: str(pf?.frameId),
    version: typeof pf?.version === "number" ? pf.version : null,
    frameAssetId,
    checksum: frameAssetId ? str(snap?.assets?.[frameAssetId]?.checksum) : null,
    intentFingerprint: str(pf?.intentFingerprint),
    startFrameAssetId: start,
    firstFrameMatches: Boolean(frameAssetId && start && frameAssetId === start),
  };
}

export interface AnimationFreshness {
  status: "fresh" | "stale" | "unknown";
  /** Named parts (or the frame reference) that no longer hold. */
  changed: string[];
  messages: string[];
}

/**
 * Is an animation still made from the Shot's current truth? The 2G.2 candidate input basis, unchanged: all 13 named
 * parts frozen in the package (camera, action, performance, timing, Character Lock, Location View...) plus the
 * Production Frame it started from. Selecting another frame stales it; editing a master Look under the SAME Character
 * Continuity Lock does not (the Lock is the frozen truth). History is never rewritten.
 */
export function animationFreshness(
  ctx: ShotContext,
  attempt: Pick<GenerationAttempt, "id" | "request" | "packageSnapshot">,
): AnimationFreshness {
  const stale = candidateInputStaleness(ctx, attempt);
  if (!stale) return { status: "fresh", changed: [], messages: [] };
  if (stale.unknown)
    return {
      status: "unknown",
      changed: [],
      messages: ["Prism cannot verify what this animation was generated from."],
    };
  return {
    status: "stale",
    changed: stale.changed,
    messages: stale.changed.map((p) =>
      p === PRODUCTION_FRAME_REFERENCE ? "The selected Production Frame changed" : changedPartText(p),
    ),
  };
}

// ───────────────────────── Sequence Board: derived animation state (§42) ─────────────────────────

export type ShotAnimationState = "not_animated" | "candidates" | "final_approved" | "stale";

export const SHOT_ANIMATION_LABEL: Record<ShotAnimationState, string> = {
  not_animated: "Not animated",
  candidates: "Animation candidates",
  final_approved: "Final video approved",
  stale: "Animation stale",
};

export interface ShotAnimationSummary {
  state: ShotAnimationState;
  /** Animation attempts of this Shot (any status). */
  attempts: number;
  succeeded: number;
  /** Succeeded animations still made from the Shot's current truth. */
  freshSucceeded: number;
  /** The Shot's approved animation output, if any (its freshness is reported, never silently revoked). */
  approvedAttemptId: string | null;
  approvedStale: boolean;
}

/**
 * Derived ONLY from existing attempts and their approval (no table, no cache). Animation attempts are Shot-output
 * attempts made by `animate_production_frame`; an approved one stays approved when the Shot changes, and is reported
 * as stale rather than silently unapproved.
 */
export function shotAnimationSummary(
  ctx: ShotContext,
  attempts: readonly Pick<
    GenerationAttempt,
    "id" | "shotId" | "status" | "approved" | "request" | "packageSnapshot"
  >[],
): ShotAnimationSummary {
  const mine = attempts.filter((a) => a.shotId === ctx.shot.id && isAnimationAttempt(a));
  const fresh = (a: (typeof mine)[number]) => animationFreshness(ctx, a).status === "fresh";
  const succeeded = mine.filter((a) => a.status === "succeeded");
  const approved = mine.find((a) => a.approved) ?? null;
  const approvedStale = approved ? !fresh(approved) : false;
  const freshSucceeded = succeeded.filter(fresh).length;
  const live = mine.filter((a) => a.status !== "failed" && a.status !== "cancelled");
  const state: ShotAnimationState =
    mine.length === 0
      ? "not_animated"
      : approved
        ? approvedStale
          ? "stale"
          : "final_approved"
        : live.length > 0 && live.every((a) => !fresh(a))
          ? "stale"
          : "candidates";
  return {
    state,
    attempts: mine.length,
    succeeded: succeeded.length,
    freshSucceeded,
    approvedAttemptId: approved?.id ?? null,
    approvedStale,
  };
}
