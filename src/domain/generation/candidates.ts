import type { CompatibilityReport } from "./compatibility";
import type { ModelFit } from "./models/matrix";
import type { GenerationPackage } from "../generation-package";
import { parseGenerationPurpose, type GenerationPurpose } from "./schemas";

/**
 * Candidate sets (Phase 2E): an intentional comparison experiment. One shared production package, several
 * models, each candidate its own attempt + job. Provider-independent: nothing here assumes Runway.
 */
export const CANDIDATE_SET_STATUSES = ["open", "decided", "archived"] as const;
export type CandidateSetStatus = (typeof CANDIDATE_SET_STATUSES)[number];

/**
 * The generation PURPOSE of a candidate set (Phase 2G.2), machine-readable in the set's frozen recommendation JSON
 * (`generationPurpose`). No schema change: a set without it (or with an unknown value) is a `shot_output` set (every
 * set before 2G.2). `animate_production_frame` (2H): video candidates animating the Shot's canonical Production Frame.
 * Distinct from the free-text `purpose` column, which is the filmmaker's own note about the experiment.
 */
export function candidateSetPurpose(set: {
  recommendation: Record<string, unknown> | null;
}): GenerationPurpose {
  return parseGenerationPurpose(set.recommendation?.generationPurpose);
}

export const MAX_CANDIDATES_DEFAULT = 6;
export const CANDIDATE_LABELS = ["A", "B", "C", "D", "E", "F", "G", "H"] as const;

export interface CandidateSet {
  id: string;
  projectId: string;
  shotId: string;
  title: string;
  purpose: string;
  status: CandidateSetStatus;
  /** Frozen production truth fingerprint every candidate was built from (the SAME package). */
  packageFingerprint: string;
  estimatedTotalUsd: number | null;
  /** Server ceiling that applied at creation (never a client value). */
  ceilingUsd: number | null;
  preferredAttemptId: string | null;
  preferredBy: string | null;
  preferredAt: string | null;
  promotedAttemptId: string | null;
  promotedBy: string | null;
  promotedAt: string | null;
  /** Frozen recommendation shown at creation (engine version, profile, scores) and what was chosen. */
  recommendation: Record<string, unknown> | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export type MemberSubmitState = "planned" | "submitted" | "failed";

export interface CandidateMember {
  id: string;
  candidateSetId: string;
  projectId: string;
  label: string;
  position: number;
  provider: string;
  model: string;
  /** null until the attempt exists (or forever, when submission failed). */
  attemptId: string | null;
  submitState: MemberSubmitState;
  submitError: string;
  inputMode: "keyframes" | "references" | null;
  tierId: string | null;
  nativeAudio: boolean;
  estimateUsd: number | null;
  /** What the candidate would receive/adapt, frozen at planning (the "preview"). */
  plan: Record<string, unknown>;
  createdAt: string;
}

export interface CandidateSetEvent {
  id: string;
  candidateSetId: string;
  projectId: string;
  kind: "created" | "preferred_set" | "preferred_cleared" | "promoted" | "status_changed";
  payload: Record<string, unknown>;
  actor: string | null;
  at: string;
}

// ───────────────────────── rollup ─────────────────────────

export interface MemberExecution {
  submitState: MemberSubmitState;
  /** Attempt execution status ("queued" | "running" | "succeeded" | "failed" | "cancelled") or null. */
  attemptStatus: string | null;
}

export interface SetRollup {
  total: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  active: number;
  notSubmitted: number;
  /** All candidates reached a terminal state. */
  settled: boolean;
  label: string;
}

/** One candidate failing never fails the set: the rollup counts, it never throws or aborts. */
export function rollupSet(members: readonly MemberExecution[]): SetRollup {
  let succeeded = 0;
  let failed = 0;
  let cancelled = 0;
  let active = 0;
  let notSubmitted = 0;
  for (const m of members) {
    if (m.submitState === "failed") notSubmitted += 1;
    else if (m.submitState === "planned" || !m.attemptStatus) active += 1;
    else if (m.attemptStatus === "succeeded") succeeded += 1;
    else if (m.attemptStatus === "failed") failed += 1;
    else if (m.attemptStatus === "cancelled") cancelled += 1;
    else active += 1;
  }
  const total = members.length;
  const settled = active === 0;
  const label = settled
    ? `${succeeded}/${total} completed${failed + notSubmitted > 0 ? `, ${failed + notSubmitted} failed` : ""}${cancelled > 0 ? `, ${cancelled} cancelled` : ""}`
    : `${succeeded}/${total} completed, ${active} in progress`;
  return { total, succeeded, failed, cancelled, active, notSubmitted, settled, label };
}

// ───────────────────────── spend ─────────────────────────

export interface SetSpendBlocker {
  code:
    | "set.empty"
    | "set.too_many"
    | "set.paid_disabled"
    | "set.no_limit"
    | "set.unknown_cost"
    | "set.over_limit";
  message: string;
}

export interface SetSpendPlan {
  totalUsd: number | null;
  paidCount: number;
  blockers: SetSpendBlocker[];
}

/**
 * Total maximum estimated spend for a candidate set against the SERVER ceilings. Free (mock) candidates cost
 * nothing and need no paid gate; paid candidates need the generation spend gate AND a set ceiling.
 */
export function planSetSpend(args: {
  candidates: Array<{ billsMoney: boolean; estimateUsd: number | null; displayName: string }>;
  paidEnabled: boolean;
  /** PRISM_STUDIO_MAX_CANDIDATE_SET_USD (null = not configured, which blocks paid sets). */
  maxSetUsd: number | null;
  /** The per-generation ceiling (PRISM_STUDIO_MAX_GENERATION_USD) still applies to every candidate. */
  maxPerGenerationUsd: number | null;
  maxCandidates: number;
}): SetSpendPlan {
  const blockers: SetSpendBlocker[] = [];
  const { candidates } = args;
  if (candidates.length === 0) {
    return {
      totalUsd: 0,
      paidCount: 0,
      blockers: [{ code: "set.empty", message: "Select at least one model." }],
    };
  }
  if (candidates.length > args.maxCandidates) {
    blockers.push({
      code: "set.too_many",
      message: `A candidate set holds at most ${args.maxCandidates} candidates; ${candidates.length} selected.`,
    });
  }
  const paid = candidates.filter((c) => c.billsMoney);
  let total = 0;
  let unknown = false;
  for (const c of paid) {
    if (c.estimateUsd == null) unknown = true;
    else total += c.estimateUsd;
  }
  total = Math.round(total * 10_000) / 10_000;
  if (paid.length > 0) {
    if (!args.paidEnabled) {
      blockers.push({
        code: "set.paid_disabled",
        message: "Paid generation is switched off on this server (PRISM_STUDIO_ALLOW_PAID_GENERATION).",
      });
    } else if (args.maxSetUsd == null) {
      blockers.push({
        code: "set.no_limit",
        message: "No candidate-set spend ceiling is configured (PRISM_STUDIO_MAX_CANDIDATE_SET_USD).",
      });
    } else if (unknown) {
      blockers.push({
        code: "set.unknown_cost",
        message:
          "At least one candidate has an unknown cost, so the set cannot be checked against its ceiling.",
      });
    } else if (total > args.maxSetUsd) {
      blockers.push({
        code: "set.over_limit",
        message: `Estimated total $${total.toFixed(2)} exceeds the candidate-set ceiling of $${args.maxSetUsd.toFixed(2)}.`,
      });
    }
  }
  return { totalUsd: unknown ? null : total, paidCount: paid.length, blockers };
}

// ───────────────────────── fair comparison ─────────────────────────

export interface ComparisonDisclosure {
  /** Production truth every candidate shares. */
  same: string[];
  /** What necessarily differs because of provider capabilities. Never hidden. */
  different: string[];
  /** true only when nothing differs between candidates (rare; mock models). */
  identical: boolean;
}

interface DisclosureCandidate {
  label: string;
  displayName: string;
  fit: Pick<ModelFit, "packaging" | "tierId" | "nativeAudio" | "inputMode" | "referencesUsed"> & {
    quality?: string | null;
    compatibility: Pick<CompatibilityReport, "used" | "adaptation">;
  };
}

/** Plain statement of what is the same and what differs, so no experiment is claimed to be "identical". */
export function describeComparison(
  pkg: GenerationPackage,
  candidates: DisclosureCandidate[],
  purpose: GenerationPurpose = "shot_output",
): ComparisonDisclosure {
  const still = purpose === "production_frame";
  const animate = purpose === "animate_production_frame";
  const same: string[] = [];
  if (pkg.characters.length > 0)
    same.push(
      `Character${pkg.characters.length > 1 ? "s" : ""}: ${pkg.characters.map((c) => c.name).join(", ")}`,
    );
  const looks = pkg.characters.flatMap((c) => (c.look ? [c.look.name] : []));
  if (looks.length) same.push(`Look: ${[...new Set(looks)].join(", ")}`);
  if (pkg.set) same.push(`Location: ${pkg.set.name}`);
  // an animation starts from the Production Frame and never sends the Storyboard it supersedes
  if (pkg.references.approvedStoryboardFrame && !animate) same.push("Approved storyboard frame");
  if (pkg.references.productionFrame)
    same.push(
      animate
        ? `Exact first frame: Production Frame v${pkg.references.productionFrame.version}`
        : "Current Production Frame",
    );
  const takes = pkg.performance.filter((p) => p.selectedTake).length;
  if (takes > 0 && !still) same.push(`Performance: ${takes} selected take(s)`);
  const move = pkg.camera.movement.trim();
  if (move || pkg.camera.shotSize.trim())
    same.push(`Camera intent: ${[pkg.camera.shotSize, move].filter(Boolean).join(", ")}`);
  same.push(
    still
      ? `Production frame ${pkg.style.aspectRatio || "ratio unset"} (one still image per candidate)`
      : `Production ${pkg.style.aspectRatio || "ratio unset"} · ${(pkg.timing.durationMs / 1000).toFixed(1)} s`,
  );

  const different: string[] = [];
  const distinct = <T>(f: (c: DisclosureCandidate) => T) =>
    new Set(candidates.map((c) => JSON.stringify(f(c))));
  const list = (f: (c: DisclosureCandidate) => string) =>
    candidates.map((c) => `${c.label} ${f(c)}`).join(" · ");

  if (distinct((c) => c.fit.compatibility.used.aspectRatio).size > 1)
    different.push(`Provider ratio: ${list((c) => c.fit.compatibility.used.aspectRatio ?? "native")}`);
  if (!still && distinct((c) => c.fit.compatibility.used.durationMs).size > 1)
    different.push(
      `Generated duration: ${list((c) => `${((c.fit.compatibility.used.durationMs ?? 0) / 1000).toFixed(1)} s`)}`,
    );
  if (distinct((c) => c.fit.referencesUsed.used).size > 1)
    different.push(`Reference images used: ${list((c) => String(c.fit.referencesUsed.used))}`);
  if (!still && distinct((c) => Boolean(c.fit.compatibility.used.startFrameAssetId)).size > 1)
    different.push(
      `Start frame as exact first frame: ${list((c) => (c.fit.compatibility.used.startFrameAssetId ? "yes" : "no"))}`,
    );
  if (!still && distinct((c) => c.fit.compatibility.used.audioAssetIds.length).size > 1)
    different.push(
      `Performed audio supplied: ${list((c) => (c.fit.compatibility.used.audioAssetIds.length ? "yes" : "no"))}`,
    );
  if (distinct((c) => c.fit.tierId).size > 1)
    different.push(`Resolution tier: ${list((c) => c.fit.tierId ?? "—")}`);
  if (still && distinct((c) => c.fit.quality ?? null).size > 1)
    different.push(`Quality: ${list((c) => c.fit.quality ?? "n/a")}`);
  if (distinct((c) => c.fit.nativeAudio).size > 1)
    different.push(`Provider-generated audio: ${list((c) => (c.fit.nativeAudio ? "on" : "off"))}`);
  if (distinct((c) => c.fit.inputMode).size > 1)
    different.push(`Input mode: ${list((c) => c.fit.inputMode ?? "n/a")}`);
  if (candidates.length > 1) {
    different.push(
      "Model-specific prompt wording and provider request shape (prompt limits differ by model).",
    );
  }
  return { same, different, identical: different.length === 0 };
}
