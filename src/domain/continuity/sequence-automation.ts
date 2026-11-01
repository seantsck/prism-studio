import type { ProjectData } from "@/domain/schemas";
import { analysisSpendBlockers, type AnalysisSpendPolicy } from "./analysis/cost";
import { projectBudgetBlockers, type ProjectQaPolicy } from "./automation";
import type { CutSide, CutTransition } from "./sequence";

/**
 * Automatic Sequence Continuity (Phase 3A.4F). Pure: when a cut has settled, which cuts come first and which of them fit
 * a wave. Nothing here reads, writes, derives, sends or spends.
 *
 * The orchestration is authenticated, idempotent and eventually automatic, like automatic Shot QA: a signed-in page finds
 * a wave due and asks for it. There is no timer: a cut that settles while nobody has Prism open is due at the next visit.
 */

/** A cut must be quiet this long before automatic QA spends on it. Manual review never waits. */
export const SEQUENCE_SETTLE_MS = 10 * 60 * 1000;
/** The stable nonce of an automatic submission (a manual review uses a fresh one, so a person can re-run). */
export const AUTO_SEQUENCE_NONCE = "auto-sequence-v1";

// ───────────────────────── settlement ─────────────────────────

/** The clock of each mutable row kind a cut's fingerprints can depend on. The database's `updated_at` values. */
export type SettlementTable = "items" | "shots" | "characters" | "looks" | "locations" | "props" | "assets";
export type CutSettlementClock = Record<SettlementTable, Readonly<Record<string, string>>>;

export const emptySettlementClock = (): CutSettlementClock => ({
  items: {},
  shots: {},
  characters: {},
  looks: {},
  locations: {},
  props: {},
  assets: {},
});

/**
 * THE CUT SETTLEMENT SOURCE MATRIX: everything that can change a cut's subject, criteria or reference fingerprint, and
 * what clocks it. Never the edit's revision or `updated_at`, or the Project's: a change far away must not reset this cut.
 *
 *   Edit item: picture, trim, position (a reorder moves every shifted item) ......... episode_edit_items.updated_at
 *   Shot: declared truth, Location, Scene, Character assignments, Look, Prop set ...... shots.updated_at
 *   Location View selection: set ...................................................... selected_at
 *   Location View selection: cleared, or its View deleted ............................. shots.updated_at (0047)
 *   Continuity Lock selection: set .................................................... selected_at
 *   Continuity Lock selection: cleared, or its Lock deleted ........................... shots.updated_at (0047)
 *   Prop removed from the Project ..................................................... shots.updated_at (0047)
 *   Character: name ................................................................... characters.updated_at
 *   Identity reference: any write, or its Asset deleted ............................... characters.updated_at (0047)
 *   Look: name, reference images ...................................................... character_looks.updated_at
 *   Location: name .................................................................... locations.updated_at
 *   Prop: name ........................................................................ props.updated_at
 *   Asset: checksum of the pinned clip or a reference image ........................... assets.updated_at
 *
 * Needs no clock, because it cannot change: a Location View and a Continuity Lock (immutable rows), the Production Frame
 * a clip was generated from (frozen in the attempt's package), the edit rate (no operation changes it). Scene fields
 * other than the Shot's `sceneId` do not enter the fingerprints.
 */
export interface SettlementSource {
  table: SettlementTable | "view_selection" | "lock_selection";
  id: string;
  /** a selection carries its own instant; every other source is looked up in the clock */
  at?: string;
}

function sideSources(data: ProjectData, side: CutSide): SettlementSource[] {
  const out: SettlementSource[] = [
    { table: "items", id: side.itemId },
    { table: "shots", id: side.shotId },
  ];
  const shot = data.shots.find((s) => s.id === side.shotId);
  if (shot) {
    if (shot.spatial.locationId) out.push({ table: "locations", id: shot.spatial.locationId });
    for (const a of shot.characters) {
      out.push({ table: "characters", id: a.characterId });
      if (a.lookId) out.push({ table: "looks", id: a.lookId });
      const lock = data.shotCharacterContinuitySelections?.find(
        (s) => s.shotId === shot.id && s.characterId === a.characterId,
      );
      if (lock) out.push({ table: "lock_selection", id: a.characterId, at: lock.selectedAt });
    }
    for (const id of shot.propIds) out.push({ table: "props", id });
    const view = data.shotLocationViewSelections?.find((s) => s.shotId === shot.id);
    if (view) out.push({ table: "view_selection", id: shot.id, at: view.selectedAt });
  }
  if (side.picture.kind === "video") out.push({ table: "assets", id: side.picture.assetId });
  for (const r of side.references) if (r.assetId) out.push({ table: "assets", id: r.assetId });
  return out;
}

export const cutSettlementSources = (data: ProjectData, cut: CutTransition): SettlementSource[] => [
  ...sideSources(data, cut.left),
  ...sideSources(data, cut.right),
];

export type CutSettlement =
  | { state: "settled"; changedAt: string }
  | { state: "settling"; changedAt: string; settlesAt: string }
  /** a source has no reliable clock: never treated as settled, and `now` is never invented as its change time */
  | { state: "unknown"; missing: string[] };

export function cutSettlement(args: {
  sources: readonly SettlementSource[];
  clock: CutSettlementClock;
  now: Date;
  settleMs?: number;
}): CutSettlement {
  const settleMs = args.settleMs ?? SEQUENCE_SETTLE_MS;
  const missing: string[] = [];
  let latest = -Infinity;
  for (const s of args.sources) {
    const at = s.at ?? (s.table in args.clock ? args.clock[s.table as SettlementTable][s.id] : undefined);
    const t = at ? Date.parse(at) : Number.NaN;
    if (Number.isNaN(t)) missing.push(`${s.table}:${s.id}`);
    else if (t > latest) latest = t;
  }
  if (missing.length > 0 || latest === -Infinity) return { state: "unknown", missing };
  const changedAt = new Date(latest).toISOString();
  // a future clock is not "quiet": clock skew waits rather than spends
  return args.now.getTime() - latest >= settleMs
    ? { state: "settled", changedAt }
    : { state: "settling", changedAt, settlesAt: new Date(latest + settleMs).toISOString() };
}

// ───────────────────────── priority and wave ─────────────────────────

/** Whether Prism's own criteria for this cut include an applicable semantic criterion it rates critical. */
export const cutIsCriticalCapable = (cut: Pick<CutTransition, "criteria">) =>
  cut.criteria.some(
    (c) => c.handler !== "deterministic" && c.applicability === "applies" && c.severity === "critical",
  );

/** Critical-capable cuts first, then edit order. Never model confidence or a past answer. */
export const compareCutPriority = (
  a: Pick<CutTransition, "criteria" | "index">,
  b: Pick<CutTransition, "criteria" | "index">,
) => Number(cutIsCriticalCapable(b)) - Number(cutIsCriticalCapable(a)) || a.index - b.index;

export type WaveStop = "complete" | "no_slots" | "batch_cap" | "unknown_cost" | "budget";

export interface WavePlan<T> {
  wave: T[];
  remaining: T[];
  stoppedBy: WaveStop;
  totalMaxUsd: number;
  /** why the next cut did not fit; empty when none was refused */
  reasons: string[];
}

/**
 * The longest prefix of the due cuts (already in priority order) that fits the free job slots, the batch cap and every
 * budget. Never reorders to fit more: a cut that does not fit stops the wave and stays due. A free analyzer spends
 * nothing, so only the model path checks cost (the same rule as a manual review).
 */
export function planSequenceWave<T extends { maxUsd: number | null }>(args: {
  due: readonly T[];
  freeSlots: number;
  policy: Pick<ProjectQaPolicy, "maxTransitionsPerBatch" | "maxCostPerRunUsd" | "maxCostPerDayUsd"> &
    ProjectQaPolicy;
  costed: boolean;
  paid: AnalysisSpendPolicy;
  projectSpentLast24hUsd: number;
  spentLast24hUsd: number;
}): WavePlan<T> {
  const limit = Math.min(args.policy.maxTransitionsPerBatch, Math.max(0, args.freeSlots));
  const wave: T[] = [];
  let total = 0;
  const done = (stoppedBy: WaveStop, reasons: string[] = []): WavePlan<T> => ({
    wave,
    remaining: args.due.slice(wave.length),
    stoppedBy,
    totalMaxUsd: total,
    reasons,
  });
  for (const cut of args.due) {
    if (wave.length >= limit)
      return done(wave.length >= args.policy.maxTransitionsPerBatch ? "batch_cap" : "no_slots");
    if (args.costed) {
      if (cut.maxUsd == null || !Number.isFinite(cut.maxUsd))
        return done("unknown_cost", ["A cut's worst-case cost cannot be estimated, so it is not submitted."]);
      // each cut is one run; the spent figures grow by what this wave has already taken
      const blockers = [
        ...projectBudgetBlockers({
          policy: args.policy,
          maxEstimateUsd: cut.maxUsd,
          projectSpentLast24hUsd: args.projectSpentLast24hUsd + total,
        }),
        ...analysisSpendBlockers({
          policy: args.paid,
          maxEstimateUsd: cut.maxUsd,
          spentLast24hUsd: args.spentLast24hUsd + total,
        }),
      ];
      if (blockers.length > 0)
        return done(
          "budget",
          blockers.map((b) => b.message),
        );
      total += cut.maxUsd;
    }
    wave.push(cut);
  }
  return done("complete");
}

// ───────────────────────── outcome ─────────────────────────

export type SequenceReconcileOutcome =
  | "not_ready"
  | "off"
  | "suggested"
  | "nothing_due"
  | "settling"
  | "queued"
  | "already_queued"
  | "capacity_blocked"
  | "budget_blocked"
  | "policy_blocked"
  | "failed";

export interface SequenceReconcileResult {
  outcome: SequenceReconcileOutcome;
  /** concrete reasons, never hidden behind "ok" */
  reasons: string[];
  totalCuts: number;
  dueCuts: number;
  settlingCuts: number;
  blockedCuts: number;
  queued: number;
  remainingDue: number;
  jobIds: string[];
}
