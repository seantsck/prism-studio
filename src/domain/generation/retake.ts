import { fingerprint } from "../hash";
import type { GenerationAttempt } from "../schemas";
import type { IgnoredFeature } from "./compatibility";
import { parseFrozenProviderPrompt } from "./provider-prompt";
import { NEGATIVE_LABELS, type NegativeTag, type ReviewDecision } from "./reviews";
import {
  isAnimationAttempt,
  REJECTION_LABELS,
  type GenerationRequest,
  type RejectionCategory,
} from "./schemas";

/**
 * Rejected takes inform the next attempt.
 *
 * A creatively rejected clip is evidence about a specific REQUEST: this frame, this model, this prompt, this duration.
 * Sending the identical request again is another paid roll of the same instruction, and Prism never does that
 * silently: the earlier takes from the same Production Frame are shown with their verdicts, and re-sending a request
 * that is identical to a rejected take needs its own explicit acknowledgement (recorded on the new attempt).
 *
 * Pure: derived from the project's immutable attempts and the human verdicts on them. Nothing is stored, and nothing
 * here regenerates anything.
 */

/** The current human verdict on an attempt (the candidate reviews; `OutcomeRecord` has exactly this shape). */
export interface TakeVerdict {
  attemptId: string;
  decision: ReviewDecision;
  negativeTags: NegativeTag[];
}

type RequestLike = Pick<
  GenerationRequest,
  "provider" | "modelId" | "startFrameAssetId" | "endFrameAssetId" | "durationMs" | "aspectRatio"
> & { prompt: { positive: string }; providerOptions?: Record<string, unknown> };

/** The text a provider is actually sent: the frozen provider prompt when a policy produced one, else the plan prompt. */
export function sentPromptOf(request: RequestLike): { text: string; policy: string | null } {
  const frozen = parseFrozenProviderPrompt(request.providerOptions?.prismProviderPrompt);
  return frozen
    ? { text: frozen.text, policy: `${frozen.policy.id}@v${frozen.policy.version}` }
    : { text: request.prompt.positive, policy: null };
}

/**
 * What decides the picture in motion: the first (and last) frame, the model, the sent prompt, the duration and the
 * provider canvas. Deliberately NOT the seed (unset = a fresh sample each time), the resolution tier or native audio:
 * two requests with the same signature give the model the same instruction.
 */
export function takeSignature(request: RequestLike): string {
  return fingerprint({
    provider: request.provider,
    modelId: request.modelId,
    startFrameAssetId: request.startFrameAssetId,
    endFrameAssetId: request.endFrameAssetId,
    durationMs: request.durationMs,
    aspectRatio: request.aspectRatio,
    prompt: sentPromptOf(request).text,
  });
}

export interface PriorTake {
  attemptId: string;
  attemptNumber: number;
  provider: string;
  model: string;
  status: GenerationAttempt["status"];
  /** The human verdict: a candidate review, or the attempt's own rejection; `unreviewed` when neither exists. */
  decision: ReviewDecision;
  /** Why it was rejected, in the product's own labels (review tags first, then rejection categories). */
  reasons: string[];
  note: string;
  /** Which prompt policy produced the text it was sent ("visible-motion@v1"), null for a plan compilation. */
  promptPolicy: string | null;
  /** The provider was given exactly the request now being evaluated (same frame, model, prompt, duration). */
  identical: boolean;
}

type TakeAttempt = Pick<
  GenerationAttempt,
  | "id"
  | "shotId"
  | "attemptNumber"
  | "provider"
  | "model"
  | "status"
  | "request"
  | "reviewStatus"
  | "rejectionCategories"
  | "rejectionReason"
>;

/**
 * The Shot's earlier animation takes that started from the SAME Production Frame image as `request`, newest first,
 * each with its verdict and whether it was the identical request.
 */
export function priorTakes(args: {
  attempts: readonly TakeAttempt[];
  verdicts: readonly TakeVerdict[];
  shotId: string;
  request: RequestLike;
}): PriorTake[] {
  const { request } = args;
  if (!request.startFrameAssetId) return [];
  const verdictOf = new Map(args.verdicts.map((v) => [v.attemptId, v]));
  const signature = takeSignature(request);
  return args.attempts
    .filter((a) => a.shotId === args.shotId && isAnimationAttempt(a))
    .flatMap((a) => {
      const req = a.request as unknown as RequestLike | null;
      if (!req || req.startFrameAssetId !== request.startFrameAssetId || !req.prompt) return [];
      const review = verdictOf.get(a.id);
      const rejectedOnAttempt = a.reviewStatus === "rejected";
      const decision: ReviewDecision =
        review && review.decision !== "unreviewed"
          ? review.decision
          : rejectedOnAttempt
            ? "reject"
            : a.reviewStatus === "approved"
              ? "approve"
              : "unreviewed";
      const reasons = [
        ...(review?.decision === "reject" ? review.negativeTags.map((t) => NEGATIVE_LABELS[t]) : []),
        ...(rejectedOnAttempt
          ? (a.rejectionCategories as RejectionCategory[]).map((c) => REJECTION_LABELS[c])
          : []),
      ];
      return [
        {
          attemptId: a.id,
          attemptNumber: a.attemptNumber,
          provider: a.provider,
          model: a.model,
          status: a.status,
          decision,
          reasons: [...new Set(reasons)],
          note: rejectedOnAttempt ? a.rejectionReason.trim() : "",
          promptPolicy: sentPromptOf(req).policy,
          identical: takeSignature(req) === signature,
        },
      ];
    })
    .sort((a, b) => b.attemptNumber - a.attemptNumber);
}

export const ACK_IDENTICAL_RETAKE = "retake.identical_to_rejected";

/** The acknowledgement a request needs when a rejected take was produced by the identical request. */
export function retakeAcknowledgements(prior: readonly PriorTake[]): IgnoredFeature[] {
  const twins = prior.filter((t) => t.identical && t.decision === "reject" && t.status === "succeeded");
  if (twins.length === 0) return [];
  const t = twins[0]!;
  const why = t.reasons.length ? ` (rejected for ${t.reasons.join(", ").toLowerCase()})` : " (rejected)";
  const more = twins.length > 1 ? ` and ${twins.length - 1} more` : "";
  return [
    {
      id: ACK_IDENTICAL_RETAKE,
      feature: "retake",
      label: `Identical to rejected take #${t.attemptNumber}${more}${why}`,
      impact:
        "The same frame, model, prompt and duration would be sent again: another paid roll of the same instruction. Change the Production Frame, the Shot's direction or the model to give a different instruction, or accept the re-roll.",
    },
  ];
}

/** Acknowledgements that guard spend on an animation and must be confirmed on their own, never inside a list. */
export const PRE_SPEND_ACK_IDS: ReadonlySet<string> = new Set([
  "references.frame_lineage",
  "references.essential_missing",
  ACK_IDENTICAL_RETAKE,
]);
export const isPreSpendAcknowledgement = (id: string): boolean => PRE_SPEND_ACK_IDS.has(id);
