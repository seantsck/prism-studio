import { buildShotContext, type ShotContext } from "../context";
import { frameAtMs, msAtFrame, type EditRate } from "../edit/edit-rate";
import type { EpisodeEditView, ItemView, ReplacementReason } from "../edit/view";
import { fingerprint } from "../hash";
import type { ProjectData } from "../schemas";
import {
  characterFacts,
  declared,
  declaredDiffers,
  describeTransitionTruth,
  locationFacts,
  transitionTruthOf,
  type TransitionFact,
  type TransitionTruthSide,
} from "../transition-truth";
import { frozenShotTruth } from "./criteria";
import type { ContinuityCategory, ContinuityResult, ContinuitySeverity, CriterionHandler } from "./model";
import type { ShotQaState } from "./shot-qa";
import { cutIntentEffective, type CutIntent } from "./cut-intent";

/**
 * Phase 3A.4A: the CUT domain of the Sequence Continuity Supervisor (docs/sequence-continuity-supervisor.md). Pure:
 * no database, provider, network, filesystem or media processing.
 *
 *   "Does Shot B continue Shot A correctly at the cut that actually exists in the Episode Edit?"
 *
 * The persisted Episode Edit is the ONLY authority for adjacency: a Cut is two adjacent edit ITEMS, addressed by
 * (edit, left item, right item). Shot order, `previousShotId` and the Sequence Board's planned order never decide a
 * cut; they are reported as facts. Everything here is advisory and derived on read: nothing approves, rejects,
 * regenerates, selects or edits anything, and nothing is persisted (3A.4C owns persistence).
 *
 * Deterministic cut criteria compare DECLARED truth and edit facts, never pixels. Semantic cut criteria are defined
 * here as domain descriptors only: no provider declares cross-cut capability yet (3A.4D), so every one of them is
 * `unchecked` (or `n_a` when it does not apply). Applicability (`n_a`) is Prism's decision, made here, before any
 * semantic planning; an analyzer is never asked whether a criterion applies.
 */

/**
 * Bump when cut-criteria construction or deterministic check semantics change. Stored in every transition run truth.
 * Independent of the Shot QA `CONTINUITY_RULES_VERSION` (3a.1), which this phase does not change.
 *   3a.4  Phase 3A.4A cut criteria.
 */
export const SEQUENCE_RULES_VERSION = "3a.4";

/**
 * `cut-edge-static-v1`: what a future semantic cut analysis would examine. 2,000 ms of the picture actually used on
 * each side of the cut, sampled statically at 4 fps, audio stripped, plus the exact last displayed frame of A and the
 * exact first displayed frame of B. A changed policy is a NEW id (v2), never a silent change to v1. 3A.4A computes the
 * descriptors only; nothing is extracted, derived or stored.
 */
export const CUT_EDGE_POLICY = {
  id: "cut-edge-static-v1",
  windowMs: 2000,
  fps: 4,
  audio: "stripped",
} as const;

// ───────────────────────── address ─────────────────────────

export interface TransitionAddress {
  editId: string;
  leftItemId: string;
  rightItemId: string;
}

/**
 * The cut's stable address: `cut-v1 | edit | left item | right item`. No timestamp, no edit revision, no Shot id and no
 * source: it survives trims and source replacement, and returns when the same two items become adjacent again (so a
 * frozen run of that cut can be current again when its fingerprints match).
 */
export const transitionKey = (a: TransitionAddress): string =>
  fingerprint(["cut-v1", a.editId, a.leftItemId, a.rightItemId]);

// ───────────────────────── edge windows ─────────────────────────

export interface EdgeInterval {
  startMs: number;
  endMs: number;
}

/** The end of A's used interval: `[max(sourceIn, sourceOut − W), sourceOut]`. */
export function leftEdgeWindow(sourceInMs: number, sourceOutMs: number): EdgeInterval {
  return { startMs: Math.max(sourceInMs, sourceOutMs - CUT_EDGE_POLICY.windowMs), endMs: sourceOutMs };
}

/** The start of B's used interval: `[sourceIn, min(sourceOut, sourceIn + W)]`. */
export function rightEdgeWindow(sourceInMs: number, sourceOutMs: number): EdgeInterval {
  return { startMs: sourceInMs, endMs: Math.min(sourceOutMs, sourceInMs + CUT_EDGE_POLICY.windowMs) };
}

/**
 * The source instant of A's LAST displayed frame: the first millisecond of the frame that contains the item's final
 * instant, quantised at the edit rate in ITEM-LOCAL time. Item-local so the cut's identity never depends on where the
 * cut sits in the Episode (an earlier item's trim must not move it); the edit rate still moves it.
 */
export function lastDisplayedFrameMs(sourceInMs: number, sourceOutMs: number, rate: EditRate): number {
  const local = msAtFrame(frameAtMs(sourceOutMs - sourceInMs - 1, rate), rate);
  return sourceInMs + local;
}

/** The source instant of B's FIRST displayed frame: its in-point (item-local frame 0). */
export const firstDisplayedFrameMs = (sourceInMs: number): number => sourceInMs;

export interface EdgeWindowDescriptor extends EdgeInterval {
  side: "left" | "right";
  policy: typeof CUT_EDGE_POLICY.id;
  parentAssetId: string;
  parentChecksum: string | null;
  durationMs: number;
  fps: number;
  audio: "stripped";
}

export interface EdgeStillDescriptor {
  side: "left" | "right";
  frame: "last_displayed" | "first_displayed";
  parentAssetId: string;
  parentChecksum: string | null;
  atMs: number;
}

// ───────────────────────── sides ─────────────────────────

export type CutPicture =
  | {
      kind: "video";
      attemptId: string;
      assetId: string;
      assetChecksum: string | null;
      sourceInMs: number;
      sourceOutMs: number;
    }
  | {
      kind: "production_frame";
      productionFrameId: string;
      assetId: string | null;
      assetChecksum: string | null;
    }
  | {
      kind: "storyboard_frame";
      storyboardFrameId: string;
      assetId: string | null;
      assetChecksum: string | null;
    }
  | { kind: "none" };

export interface CutReference {
  side: "left" | "right";
  role: "character_lock" | "identity" | "look" | "location_view" | "production_frame";
  /** the Character / Lock / View / Production Frame the reference belongs to */
  ref: string;
  assetId: string | null;
  checksum: string | null;
  /**
   * The applicable semantic criteria of this cut that could use the reference (sorted). A cut keeps only references
   * with at least one; empty only on a side's candidate list, before the cut's criteria are known.
   */
  usedBy: string[];
}

export interface CutSide {
  itemId: string;
  index: number;
  shotId: string;
  shotCode: string | null;
  /** the Shot's declared truth; null when the Shot no longer resolves (an integrity problem) */
  truth: TransitionTruthSide | null;
  storedPreviousShotId: string | null;
  /** declared truth the Sequence Board does not compare, used by cut criteria only */
  declaredExtra: {
    lighting: string;
    props: string;
    propIds: string[];
    geography: string;
    exitPoint: string;
    entryPoint: string;
  };
  picture: CutPicture;
  /** edit eligibility (from the Episode Edit view): an unusable source is a source-integrity failure */
  usable: boolean;
  violations: string[];
  /** the source no longer reflects the Shot's current truth, or a replacement is available (from the edit view) */
  currentness: { stale: boolean; reasons: string[]; replacement: ReplacementReason | null };
  window: EdgeWindowDescriptor | null;
  still: EdgeStillDescriptor | null;
  /** the references this cut's applicable semantic criteria could use (`referencesForCut`), in canonical order */
  references: CutReference[];
  /** the Shot's prop names, for criterion titles */
  propNames: Map<string, string>;
  /** the pinned attempt's Shot QA state, when the caller supplied it */
  shotQa: ShotQaState | null;
}

function pictureOf(data: ProjectData, view: ItemView): CutPicture {
  const v = view.item.visual;
  const checksum = (assetId: string | null) =>
    assetId ? (data.assets.find((a) => a.id === assetId)?.checksum ?? null) : null;
  if (v.kind === "video")
    return {
      kind: "video",
      attemptId: v.attemptId,
      assetId: v.assetId,
      assetChecksum: checksum(v.assetId),
      sourceInMs: v.sourceInMs,
      sourceOutMs: v.sourceOutMs,
    };
  if (v.kind === "production_frame") {
    const f = (data.productionFrames ?? []).find((x) => x.id === v.productionFrameId);
    return {
      kind: "production_frame",
      productionFrameId: v.productionFrameId,
      assetId: f?.assetId ?? null,
      assetChecksum: f?.assetChecksum ?? null,
    };
  }
  if (v.kind === "storyboard_frame") {
    const f = data.frames.find((x) => x.id === v.storyboardFrameId);
    return {
      kind: "storyboard_frame",
      storyboardFrameId: v.storyboardFrameId,
      assetId: f?.assetId ?? null,
      assetChecksum: checksum(f?.assetId ?? null),
    };
  }
  return { kind: "none" };
}

function currentnessOf(view: ItemView): CutSide["currentness"] {
  const reasons: string[] = [];
  const f = view.visual;
  if (f.kind === "video") {
    if (f.freshness.status === "stale")
      reasons.push(...(f.freshness.messages.length ? f.freshness.messages : ["The clip is stale."]));
    if (f.newerDeliveryMasterAssetId) reasons.push("A newer delivery master is selected for this clip.");
  } else {
    if (f.selectionChanged) reasons.push("The Shot now selects another Production Frame.");
    if (f.freshness && f.freshness.status === "stale")
      reasons.push(...(f.freshness.messages.length ? f.freshness.messages : ["The placeholder is stale."]));
  }
  if (view.replacement) reasons.push(`A replacement is available (${view.replacement.reason}).`);
  return { stale: reasons.length > 0, reasons, replacement: view.replacement?.reason ?? null };
}

/** A side's CANDIDATE references; `referencesForCut` keeps the ones the cut's applicable criteria could use. */
function referencesOf(
  data: ProjectData,
  ctx: ShotContext,
  side: "left" | "right",
  picture: CutPicture,
): CutReference[] {
  const checksum = (id: string) => ctx.assets.get(id)?.checksum ?? null;
  const refs: CutReference[] = [];
  for (const c of ctx.characters) {
    const ap = c.appearance;
    if (ap.lock) {
      // a Lock's fingerprint covers its frozen facts AND images: never today's library
      refs.push({
        side,
        role: "character_lock",
        ref: c.assignment.characterId,
        assetId: null,
        checksum: ap.lock.lockFingerprint,
        usedBy: [],
      });
      continue;
    }
    for (const id of ap.identityReferenceAssetIds)
      refs.push({
        side,
        role: "identity",
        ref: c.assignment.characterId,
        assetId: id,
        checksum: checksum(id),
        usedBy: [],
      });
    for (const id of ap.look?.referenceAssetIds ?? [])
      refs.push({
        side,
        role: "look",
        ref: c.assignment.characterId,
        assetId: id,
        checksum: checksum(id),
        usedBy: [],
      });
  }
  if (ctx.selectedLocationView)
    refs.push({
      side,
      role: "location_view",
      ref: ctx.selectedLocationView.id,
      assetId: ctx.selectedLocationView.assetId,
      checksum: ctx.selectedLocationView.assetChecksum,
      usedBy: [],
    });
  if (picture.kind === "video") {
    // the Production Frame the clip was GENERATED FROM (frozen in its package), never today's selection
    const attempt = data.attempts.find((a) => a.id === picture.attemptId);
    const pf = attempt ? frozenShotTruth(attempt).productionFrame : null;
    if (pf)
      refs.push({
        side,
        role: "production_frame",
        ref: pf.frameId,
        assetId: pf.assetId,
        checksum: pf.checksum,
        usedBy: [],
      });
  }
  return refs;
}

/** The semantic criteria a Location View image could inform: where things are and how the place is lit. */
const LOCATION_VIEW_USES = ["cut:axis", "cut:geography", "cut:lighting", "cut:object_continuity"];

/** Canonical reference order: never ProjectData insertion order. */
const compareReferences = (x: CutReference, y: CutReference) => {
  const key = (r: CutReference) => [r.side, r.role, r.ref, r.assetId ?? "", r.checksum ?? ""];
  const a = key(x);
  const b = key(y);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
};

/**
 * The references this cut's judgment depends on: a side's candidates, kept only when a currently APPLICABLE semantic
 * criterion could use them, so an unused reference never stales the cut. A Lock serves the shared Character's
 * appearance and wardrobe, an identity image the appearance, a Look image the wardrobe; a Location View serves the
 * place-bound families. The Production Frame a clip was generated from is general visual provenance of that side: any
 * applicable semantic criterion may use it. Deterministic criteria use no reference (they are recomputed on read).
 */
export function referencesForCut(
  criteria: readonly CutCriterion[],
  candidates: readonly CutReference[],
): CutReference[] {
  const applicable = criteria
    .filter((c) => c.handler !== "deterministic" && c.applicability === "applies")
    .map((c) => c.key);
  const uses = (r: CutReference): string[] => {
    if (r.role === "character_lock") return [`cut:character_appearance:${r.ref}`, `cut:wardrobe:${r.ref}`];
    if (r.role === "identity") return [`cut:character_appearance:${r.ref}`];
    if (r.role === "look") return [`cut:wardrobe:${r.ref}`];
    if (r.role === "location_view") return LOCATION_VIEW_USES;
    return applicable;
  };
  return candidates
    .map((r) => ({
      ...r,
      usedBy: uses(r)
        .filter((k) => applicable.includes(k))
        .sort(),
    }))
    .filter((r) => r.usedBy.length > 0)
    .sort(compareReferences);
}

function sideOf(
  data: ProjectData,
  view: ItemView,
  side: "left" | "right",
  rate: EditRate,
  shotQa: ReadonlyMap<string, ShotQaState> | undefined,
): CutSide {
  const shot = data.shots.find((s) => s.id === view.item.shotId) ?? null;
  const ctx = shot ? buildShotContext(data, shot.id) : null;
  const picture = pictureOf(data, view);
  let window: EdgeWindowDescriptor | null = null;
  let still: EdgeStillDescriptor | null = null;
  if (picture.kind === "video") {
    const w =
      side === "left"
        ? leftEdgeWindow(picture.sourceInMs, picture.sourceOutMs)
        : rightEdgeWindow(picture.sourceInMs, picture.sourceOutMs);
    const parent = { parentAssetId: picture.assetId, parentChecksum: picture.assetChecksum };
    window = {
      side,
      policy: CUT_EDGE_POLICY.id,
      ...parent,
      ...w,
      durationMs: w.endMs - w.startMs,
      fps: CUT_EDGE_POLICY.fps,
      audio: CUT_EDGE_POLICY.audio,
    };
    still =
      side === "left"
        ? {
            side,
            frame: "last_displayed",
            ...parent,
            atMs: lastDisplayedFrameMs(picture.sourceInMs, picture.sourceOutMs, rate),
          }
        : { side, frame: "first_displayed", ...parent, atMs: firstDisplayedFrameMs(picture.sourceInMs) };
  }
  return {
    itemId: view.item.id,
    index: view.index,
    shotId: view.item.shotId,
    shotCode: shot?.shotCode ?? null,
    truth: ctx && view.inEpisode ? transitionTruthOf(ctx) : null,
    storedPreviousShotId: shot?.continuity.previousShotId ?? null,
    declaredExtra: {
      lighting: declared(shot?.continuity.lighting),
      props: declared(shot?.continuity.props),
      propIds: [...(shot?.propIds ?? [])].sort(),
      geography: declared(shot?.continuity.geography),
      exitPoint: declared(shot?.spatial.exitPoint),
      entryPoint: declared(shot?.spatial.entryPoint),
    },
    picture,
    usable: view.visual.usable,
    violations: [...view.visual.violations],
    currentness: currentnessOf(view),
    window,
    still,
    references: ctx ? referencesOf(data, ctx, side, picture) : [],
    propNames: new Map((ctx?.props ?? []).map((p) => [p.id, p.name])),
    shotQa: picture.kind === "video" ? (shotQa?.get(picture.attemptId) ?? null) : null,
  };
}

// ───────────────────────── criteria ─────────────────────────

/** The semantic cross-cut families (3A.4D gives them a provider capability; 3A.4E calibrates each). */
export const SEMANTIC_CUT_FAMILIES = [
  "screen_direction",
  "eyeline",
  "axis",
  "character_appearance",
  "wardrobe",
  "prop",
  "object_continuity",
  "geography",
  "lighting",
  "action_match",
] as const;
export type SemanticCutFamily = (typeof SEMANTIC_CUT_FAMILIES)[number];

export interface CutCriterion {
  /** stable within a cut: `cut:<name>` or `cut:<name>:<id>` */
  key: string;
  category: ContinuityCategory;
  severity: ContinuitySeverity;
  title: string;
  sourceRef: string;
  expected: string;
  handler: CriterionHandler;
  /** semantic criteria only: the cross-cut family a future analyzer would need (no provider supports one yet) */
  family: SemanticCutFamily | null;
  /** Prism's applicability decision, made before any semantic planning */
  applicability: "applies" | "n_a";
  /** a deliberate discontinuity (cut intent) may cover this criterion; never true for integrity / edit facts */
  intentCoverable: boolean;
  position: number;
}

export interface CutFinding {
  criterionKey: string;
  result: ContinuityResult;
  /** which side the result is about, when one side explains it */
  side: "left" | "right" | "both" | null;
  /** the specific reason (always present for unchecked / n_a / warn / fail) */
  reason: string;
}

/** Not a criterion: informational differences that are never a defect (entries / exits, exit / entry points). */
export interface CutInfo {
  kind: "character_presence" | "exit_entry" | "edit_order";
  message: string;
}

/** Episode-level, informational: the edit's order differs from the planned Shot order. Never a defect. */
export const editOrderInfo = (view: Pick<EpisodeEditView, "orderDiffersFromSequence">): CutInfo | null =>
  view.orderDiffersFromSequence
    ? { kind: "edit_order", message: "Edit order differs from the planned sequence." }
    : null;

export const NOT_CALIBRATED = (family: SemanticCutFamily) =>
  `Cross-cut ${family.replace(/_/g, " ")} is not yet calibrated: no analyzer may judge it yet.`;
export const PLACEHOLDER_REASON = "Planning picture: a placeholder still is not the cut's final picture.";
export const SCENE_CHANGE_REASON = "Scene changes at this cut.";

function noPictureReason(left: CutSide, right: CutSide): string | null {
  const parts: string[] = [];
  for (const [s, side] of [
    ["left", left],
    ["right", right],
  ] as const) {
    if (side.picture.kind === "none") parts.push(`No picture on the ${s} of this cut.`);
    else if (side.picture.kind !== "video") parts.push(`${PLACEHOLDER_REASON} (${s})`);
  }
  return parts.length ? parts.join(" ") : null;
}

interface Built {
  criteria: CutCriterion[];
  findings: CutFinding[];
}

function buildCriteria(left: CutSide, right: CutSide, crossesScene: boolean, facts: TransitionFact[]): Built {
  const criteria: Omit<CutCriterion, "position">[] = [];
  const findings: CutFinding[] = [];
  const add = (c: Omit<CutCriterion, "position">, f: Omit<CutFinding, "criterionKey">) => {
    criteria.push(c);
    findings.push({ criterionKey: c.key, ...f });
  };
  const det = (
    key: string,
    category: ContinuityCategory,
    severity: ContinuitySeverity,
    title: string,
    sourceRef: string,
    expected: string,
    intentCoverable: boolean,
    applicability: "applies" | "n_a" = "applies",
  ): Omit<CutCriterion, "position"> => ({
    key,
    category,
    severity,
    title,
    sourceRef,
    expected,
    handler: "deterministic",
    family: null,
    applicability,
    intentCoverable,
  });
  const a = left.truth;
  const b = right.truth;

  // ── edit facts (never covered by intent: they are not creative decisions) ──
  const pictureGap = noPictureReason(left, right);
  add(
    det(
      "cut:picture",
      "other",
      "major",
      "Picture on both sides of the cut",
      "Episode Edit",
      "Both sides of the cut show a generated clip.",
      false,
    ),
    pictureGap
      ? { result: "unchecked", side: null, reason: pictureGap }
      : { result: "pass", side: "both", reason: "Both sides are generated clips." },
  );

  const broken = (["left", "right"] as const).filter(
    (s) => !(s === "left" ? left : right).usable || !(s === "left" ? a : b),
  );
  add(
    det(
      "cut:source_integrity",
      "other",
      "critical",
      "Pinned sources are valid",
      "Episode Edit eligibility",
      "Every pinned source still satisfies the edit's eligibility rules.",
      false,
    ),
    broken.length
      ? {
          result: "fail",
          side: broken.length === 2 ? "both" : broken[0],
          reason: broken
            .map((s) => {
              const side = s === "left" ? left : right;
              const why = side.violations.length
                ? side.violations.join(", ")
                : "the Shot is not in this Episode";
              return `The ${s} source is not usable (${why}).`;
            })
            .join(" "),
        }
      : { result: "pass", side: "both", reason: "Both pinned sources are valid." },
  );

  const shifted = (["left", "right"] as const).filter((s) => (s === "left" ? left : right).currentness.stale);
  add(
    det(
      "cut:source_currentness",
      "other",
      "major",
      "Pinned sources are current",
      "Episode Edit freshness",
      "Both pinned sources reflect their Shot's current truth.",
      false,
    ),
    shifted.length
      ? {
          result: "warn",
          side: shifted.length === 2 ? "both" : shifted[0],
          reason: shifted
            .map(
              (s) =>
                `${s === "left" ? "Left" : "Right"}: ${(s === "left" ? left : right).currentness.reasons.join(" ")}`,
            )
            .join(" "),
        }
      : { result: "pass", side: "both", reason: "Both pinned sources are current." },
  );

  if (left.shotQa !== null || right.shotQa !== null) {
    const critical = (["left", "right"] as const).filter(
      (s) => (s === "left" ? left : right).shotQa === "critical_mismatch",
    );
    add(
      det(
        "cut:shot_qa",
        "other",
        "minor",
        "Shot QA of each side",
        "Shot QA (3A.1)",
        "Neither side's pinned clip has a current critical Shot QA mismatch.",
        false,
      ),
      critical.length
        ? {
            result: "warn",
            side: critical.length === 2 ? "both" : critical[0],
            reason: critical
              .map((s) => `The ${s} clip has a critical Shot QA mismatch; review it in Shot QA.`)
              .join(" "),
          }
        : { result: "pass", side: "both", reason: "No critical Shot QA mismatch on either side." },
    );
  }

  if (b) {
    const ok = right.storedPreviousShotId === left.shotId;
    add(
      det(
        "cut:link",
        "other",
        "minor",
        "Planned continuity link",
        "Shot continuity (previous Shot)",
        `${right.shotCode ?? "B"} names ${left.shotCode ?? "A"} as its previous Shot.`,
        false,
      ),
      ok
        ? { result: "pass", side: "right", reason: "The stored previous-Shot link matches the edit." }
        : {
            result: "warn",
            side: "right",
            reason:
              right.storedPreviousShotId === null
                ? `${right.shotCode} has no stored previous Shot; the edit puts ${left.shotCode} before it.`
                : `${right.shotCode} stores a different previous Shot than ${left.shotCode}, which the edit puts before it.`,
          },
    );
  }

  if (!a || !b) return { criteria: criteria.map((c, position) => ({ ...c, position })), findings };

  const na = crossesScene ? "n_a" : "applies";
  const naFinding = { result: "n_a" as const, side: null, reason: SCENE_CHANGE_REASON };

  // ── declared truth (warn = a declared difference for a person to review; never a pixel claim, never a fail) ──
  const loc = locationFacts(a, b).filter((f) => f.severity === "change");
  const where = (t: TransitionTruthSide) =>
    `${t.location?.name ?? "no Location"}${t.locationView ? ` · View ${t.locationView.name}` : ""}`;
  add(
    det(
      "cut:location",
      "location_set",
      "major",
      "Location / View continues",
      "Shot Location / View",
      `The cut stays in the same place (A: ${where(a)}; B: ${where(b)}).`,
      true,
      na,
    ),
    crossesScene
      ? naFinding
      : loc.length
        ? { result: "warn", side: "both", reason: loc.map((f) => f.message).join(" ") }
        : { result: "pass", side: "both", reason: "Same declared Location / View." },
  );

  const inA = new Map(a.characters.map((c) => [c.characterId, c]));
  const shared = b.characters.filter((c) => inA.has(c.characterId));
  for (const to of shared) {
    const from = inA.get(to.characterId)!;
    const facts1 = characterFacts({ ...a, characters: [from] }, { ...b, characters: [to] });
    const change = facts1.filter((f) => f.severity === "change");
    const authority = (c: typeof to) =>
      c.lock ? `Lock "${c.lock.name}"` : `live · Look ${c.lookName ?? "none"}`;
    const lockedContradiction =
      !!from.lock && !!to.lock && from.lock.lockFingerprint !== to.lock.lockFingerprint;
    add(
      det(
        `cut:character:${to.characterId}`,
        "identity",
        lockedContradiction ? "critical" : "major",
        `${to.name}: appearance authority continues`,
        "Character Continuity Lock / Look",
        `${to.name} keeps the same appearance authority (A: ${authority(from)}; B: ${authority(to)}).`,
        true,
        na,
      ),
      crossesScene
        ? naFinding
        : from.issue || to.issue
          ? {
              result: "unchecked",
              side: from.issue ? "left" : "right",
              reason: `${to.name}: an invalid Continuity Lock selection is the Shot's integrity blocker.`,
            }
          : change.length
            ? { result: "warn", side: "both", reason: change.map((f) => f.message).join(" ") }
            : { result: "pass", side: "both", reason: `${to.name}: same Lock / Look.` },
    );
  }

  // only a field declared on BOTH sides is comparable: one side's screen direction and the other's facing direction
  // prove nothing (the shared facts only ever describe comparable fields)
  const both = (x: string, y: string) => x !== "" && y !== "";
  const direction = facts.filter((f) => f.category === "screen_direction");
  const directionComparable =
    both(a.continuity.screenDirection, b.continuity.screenDirection) ||
    both(a.continuity.facingDirection, b.continuity.facingDirection);
  add(
    det(
      "cut:declared_direction",
      "screen_direction",
      "major",
      "Declared screen / facing direction",
      "Shot spatial continuity",
      `Declared direction continues (A: ${a.continuity.screenDirection || "—"} / ${a.continuity.facingDirection || "—"}; B: ${b.continuity.screenDirection || "—"} / ${b.continuity.facingDirection || "—"}).`,
      true,
      na,
    ),
    crossesScene
      ? naFinding
      : !directionComparable
        ? { result: "n_a", side: null, reason: "No comparable direction field is declared on both sides." }
        : direction.length
          ? { result: "warn", side: "both", reason: direction.map((f) => f.message).join(" ") }
          : { result: "pass", side: "both", reason: "Same declared direction." },
  );

  const time = facts.filter((f) => f.category === "weather" || f.category === "time_of_day");
  const lighting = declaredDiffers(left.declaredExtra.lighting, right.declaredExtra.lighting)
    ? [`Lighting changes: ${left.declaredExtra.lighting} → ${right.declaredExtra.lighting}`]
    : [];
  const timeComparable =
    both(a.continuity.timeOfDay, b.continuity.timeOfDay) ||
    both(a.continuity.weather, b.continuity.weather) ||
    both(left.declaredExtra.lighting, right.declaredExtra.lighting);
  add(
    det(
      "cut:declared_time",
      "time_of_day",
      "minor",
      "Declared time of day / weather / lighting",
      "Shot continuity",
      `Declared time, weather and lighting continue (A: ${a.continuity.timeOfDay || "—"}, ${a.continuity.weather || "—"}, ${left.declaredExtra.lighting || "—"}; B: ${b.continuity.timeOfDay || "—"}, ${b.continuity.weather || "—"}, ${right.declaredExtra.lighting || "—"}).`,
      true,
      na,
    ),
    crossesScene
      ? naFinding
      : !timeComparable
        ? {
            result: "n_a",
            side: null,
            reason: "No comparable time of day, weather or lighting field is declared on both sides.",
          }
        : time.length || lighting.length
          ? { result: "warn", side: "both", reason: [...time.map((f) => f.message), ...lighting].join(" ") }
          : { result: "pass", side: "both", reason: "Same declared value in every comparable field." },
  );

  // the assigned prop sets are explicit and comparable whenever either side assigns one; free text only when both
  // sides declare it
  const propSetComparable = left.declaredExtra.propIds.length > 0 || right.declaredExtra.propIds.length > 0;
  const propTextComparable = both(left.declaredExtra.props, right.declaredExtra.props);
  const propSetDiffers = left.declaredExtra.propIds.join("|") !== right.declaredExtra.propIds.join("|");
  const propText = declaredDiffers(left.declaredExtra.props, right.declaredExtra.props);
  const propNames = (x: CutSide) =>
    x.declaredExtra.propIds.map((id) => x.propNames.get(id) ?? id).join(", ") || "none";
  add(
    det(
      "cut:declared_props",
      "props",
      "minor",
      "Declared props",
      "Shot props / continuity",
      `Declared props continue (A: ${propNames(left)}${left.declaredExtra.props ? `; ${left.declaredExtra.props}` : ""}; B: ${propNames(right)}${right.declaredExtra.props ? `; ${right.declaredExtra.props}` : ""}).`,
      true,
      na,
    ),
    crossesScene
      ? naFinding
      : !propSetComparable && !propTextComparable
        ? { result: "n_a", side: null, reason: "No comparable prop declaration on both sides." }
        : propSetDiffers || propText
          ? {
              result: "warn",
              side: "both",
              reason: [
                propSetDiffers ? `Props ${propNames(left)} → ${propNames(right)}.` : "",
                propText
                  ? `Prop continuity changes: ${left.declaredExtra.props} → ${right.declaredExtra.props}.`
                  : "",
              ]
                .filter(Boolean)
                .join(" "),
            }
          : { result: "pass", side: "both", reason: "Same declared props." },
  );

  // ── semantic cross-cut criteria: defined, never judged here ──
  const semanticBlock: string | null =
    pictureGap ??
    (broken.length ? "A pinned source is not usable; semantic analysis cannot be prepared." : null);
  const sem = (
    family: SemanticCutFamily,
    key: string,
    category: ContinuityCategory,
    severity: ContinuitySeverity,
    title: string,
    expected: string,
    sourceRef: string,
    acrossScenes = false,
  ) => {
    const applies = acrossScenes || !crossesScene;
    add(
      {
        key,
        category,
        severity,
        title,
        sourceRef,
        expected,
        handler: "analyzer",
        family,
        applicability: applies ? "applies" : "n_a",
        intentCoverable: true,
      },
      !applies
        ? naFinding
        : { result: "unchecked", side: null, reason: semanticBlock ?? NOT_CALIBRATED(family) },
    );
  };
  const hasCharacters = (t: TransitionTruthSide) => t.characters.length > 0;
  sem(
    "screen_direction",
    "cut:screen_direction",
    "screen_direction",
    "major",
    "Screen direction across the cut",
    "The subject's direction of travel / facing carries across the cut.",
    "Shot spatial continuity",
  );
  if (hasCharacters(a) || hasCharacters(b))
    sem(
      "eyeline",
      "cut:eyeline",
      "eyelines",
      "major",
      "Eyeline match across the cut",
      "A's look direction matches B's subject position (eyeline match).",
      "Shot spatial continuity",
    );
  sem(
    "axis",
    "cut:axis",
    "camera",
    "major",
    "Camera axis (180°)",
    "The camera stays on the same side of the line of action.",
    "Shot camera / blocking",
  );
  for (const to of shared) {
    const from = inA.get(to.characterId)!;
    const locked = !!to.lock || !!from.lock;
    sem(
      "character_appearance",
      `cut:character_appearance:${to.characterId}`,
      "identity",
      locked ? "critical" : "major",
      `${to.name}: same person across the cut`,
      `${to.name} is recognisably the same person on both sides.`,
      to.lock ? `Character Continuity Lock "${to.lock.name}"` : `Character ${to.name}`,
      true,
    );
    sem(
      "wardrobe",
      `cut:wardrobe:${to.characterId}`,
      "wardrobe",
      locked ? "critical" : "major",
      `${to.name}: wardrobe continues`,
      `${to.name}'s costume, hair, makeup and jewellery carry across the cut.`,
      to.lock ? `Character Continuity Lock "${to.lock.name}"` : `Look ${to.lookName ?? "none"}`,
    );
  }
  for (const id of left.declaredExtra.propIds.filter((p) => right.declaredExtra.propIds.includes(p))) {
    const name = right.propNames.get(id) ?? id;
    sem(
      "prop",
      `cut:prop:${id}`,
      "props",
      "major",
      `Prop ${name} continues`,
      `${name} persists, stays in the same place or hand, and keeps its state.`,
      `Prop ${name}`,
    );
  }
  sem(
    "object_continuity",
    "cut:object_continuity",
    "props",
    "minor",
    "Objects continue across the cut",
    "No salient object disappears, appears or jumps position unexpectedly.",
    "Shot continuity",
  );
  sem(
    "geography",
    "cut:geography",
    "geography",
    "major",
    "Geography / blocking continues",
    "Relative Character positions and the set geography stay consistent.",
    left.declaredExtra.geography || right.declaredExtra.geography
      ? `Geography: ${left.declaredExtra.geography || "—"} / ${right.declaredExtra.geography || "—"}`
      : "Shot geography",
  );
  sem(
    "lighting",
    "cut:lighting",
    "lighting",
    "minor",
    "Lighting continues",
    "Key direction, colour and time-of-day look are continuous.",
    "Shot lighting",
  );
  sem(
    "action_match",
    "cut:action_match",
    "action_continuity",
    "major",
    "Action match across the cut",
    "B's action continues A's (match on action, pose, position).",
    left.declaredExtra.exitPoint || right.declaredExtra.entryPoint
      ? `Exit ${left.declaredExtra.exitPoint || "—"} / entry ${right.declaredExtra.entryPoint || "—"}`
      : "Shot action",
  );

  return { criteria: criteria.map((c, position) => ({ ...c, position })), findings };
}

// ───────────────────────── the cut ─────────────────────────

export interface CutTransition {
  address: TransitionAddress;
  transitionKey: string;
  /** the left item's position in the edit (cut i joins item i and item i + 1) */
  index: number;
  left: CutSide;
  right: CutSide;
  crossesScene: boolean;
  /** the shared declared-truth facts: the same comparison the Sequence Board shows (the link is `cut:link`) */
  facts: TransitionFact[];
  info: CutInfo[];
  criteria: CutCriterion[];
  /** the live deterministic projection: deterministic results, and unchecked / n_a for every semantic criterion */
  findings: CutFinding[];
  /** media a future semantic analysis could use; 3A.4A has no provider, so nothing is planned from it */
  semantic: { mediaEligible: boolean; reasons: string[] };
  truth: TransitionRunTruth;
}

export interface CutInput {
  data: ProjectData;
  /** `buildEpisodeEditView(...)` of the persisted edit: the authority for order and per-item source facts */
  view: EpisodeEditView;
  /** optional: the CURRENT Shot QA state of pinned attempts (attempt id → state); never recomputed here */
  shotQa?: ReadonlyMap<string, ShotQaState>;
}

/** Every cut of the edit, in edit order: n items → n − 1 cuts. */
export function buildEpisodeCuts({ data, view, shotQa }: CutInput): CutTransition[] {
  const rate = view.edit.editRate;
  const items = view.items;
  return items.slice(1).map((rightView, i) => {
    const leftView = items[i];
    const left = sideOf(data, leftView, "left", rate, shotQa);
    const right = sideOf(data, rightView, "right", rate, shotQa);
    const address: TransitionAddress = {
      editId: view.edit.id,
      leftItemId: left.itemId,
      rightItemId: right.itemId,
    };
    const crossesScene = !!left.truth && !!right.truth && left.truth.sceneId !== right.truth.sceneId;
    const facts = left.truth && right.truth ? describeTransitionTruth(left.truth, right.truth) : [];
    const info: CutInfo[] = facts
      .filter((f) => f.category === "characters")
      .map((f) => ({ kind: "character_presence" as const, message: f.message }));
    if (left.declaredExtra.exitPoint || right.declaredExtra.entryPoint)
      info.push({
        kind: "exit_entry",
        message: `Exit ${left.declaredExtra.exitPoint || "not declared"} → entry ${right.declaredExtra.entryPoint || "not declared"}`,
      });
    const { criteria, findings } = buildCriteria(left, right, crossesScene, facts);
    // the candidates become the references the cut's applicable criteria could actually use
    left.references = referencesForCut(criteria, left.references);
    right.references = referencesForCut(criteria, right.references);
    const reasons: string[] = [];
    for (const [s, side] of [
      ["left", left],
      ["right", right],
    ] as const) {
      if (side.picture.kind !== "video") reasons.push(`The ${s} side is not a generated clip.`);
      else if (!side.usable) reasons.push(`The ${s} source is not usable.`);
      else if (!side.picture.assetChecksum) reasons.push(`The ${s} clip has no recorded checksum.`);
    }
    const cut = {
      address,
      transitionKey: transitionKey(address),
      index: i,
      left,
      right,
      crossesScene,
      facts,
      info,
      criteria,
      findings,
      semantic: { mediaEligible: reasons.length === 0, reasons },
    };
    return { ...cut, truth: transitionRunTruth(cut) };
  });
}

// ───────────────────────── identity + freshness ─────────────────────────

/** What pixels of ONE side the cut would evaluate (never who evaluates them). */
export function sideSubject(side: Pick<CutSide, "picture" | "window" | "still">): unknown[] {
  const p = side.picture;
  if (p.kind === "video")
    return [
      "video",
      p.attemptId,
      p.assetId,
      p.assetChecksum,
      side.window?.startMs,
      side.window?.endMs,
      side.still?.atMs,
    ];
  if (p.kind === "production_frame")
    return ["production_frame", p.productionFrameId, p.assetId, p.assetChecksum];
  if (p.kind === "storyboard_frame")
    return ["storyboard_frame", p.storyboardFrameId, p.assetId, p.assetChecksum];
  return ["none"];
}

export interface TransitionRunTruth {
  transitionKey: string;
  leftSubjectFingerprint: string;
  rightSubjectFingerprint: string;
  /**
   * The exact evaluated picture: each side's kind, attempt, Asset + checksum, effective edge window and edge-frame
   * instant, under the window policy. The edit rate enters through the quantised edge-frame instant. Never: the edit
   * revision, other items, audio placements, intent, overrides, provider or analyzer.
   */
  subjectFingerprint: string;
  criteriaFingerprint: string;
  referenceFingerprint: string;
  rulesVersion: string;
}

/**
 * The edit-fact criteria: the pinned picture, its integrity and currentness, linked Shot QA and the stored link. They
 * describe the edit, not the continuity truth a semantic judgment is made against, and are recomputed on every read,
 * so they are NOT part of the criteria fingerprint: a currentness change, supplied Shot QA or a re-linked Shot never
 * stales a semantic run (the assessment still shows them, live).
 */
export const EDIT_FACT_CRITERIA: readonly string[] = [
  "cut:picture",
  "cut:source_integrity",
  "cut:source_currentness",
  "cut:shot_qa",
  "cut:link",
];

/** The continuity truth a semantic run is judged against: declared-truth and semantic criteria, never edit facts. */
export function cutCriteriaFingerprint(criteria: readonly CutCriterion[]): string {
  return fingerprint([
    "cut-criteria-v1",
    SEQUENCE_RULES_VERSION,
    criteria
      .filter((c) => !EDIT_FACT_CRITERIA.includes(c.key))
      .map((c) => [
        c.key,
        c.category,
        c.severity,
        c.expected,
        c.sourceRef,
        c.handler,
        c.family,
        c.applicability,
        c.intentCoverable,
      ]),
  ]);
}

export function cutReferenceFingerprint(
  left: readonly CutReference[],
  right: readonly CutReference[],
): string {
  return fingerprint([
    "cut-references-v1",
    [...left, ...right].sort(compareReferences).map((r) => [r.side, r.role, r.ref, r.assetId, r.checksum]),
  ]);
}

export function transitionRunTruth(
  cut: Pick<CutTransition, "transitionKey" | "left" | "right" | "criteria">,
): TransitionRunTruth {
  const leftSubjectFingerprint = fingerprint(["cut-side-v1", "left", ...sideSubject(cut.left)]);
  const rightSubjectFingerprint = fingerprint(["cut-side-v1", "right", ...sideSubject(cut.right)]);
  return {
    transitionKey: cut.transitionKey,
    leftSubjectFingerprint,
    rightSubjectFingerprint,
    subjectFingerprint: fingerprint([
      "cut-subject-v1",
      CUT_EDGE_POLICY.id,
      leftSubjectFingerprint,
      rightSubjectFingerprint,
    ]),
    criteriaFingerprint: cutCriteriaFingerprint(cut.criteria),
    referenceFingerprint: cutReferenceFingerprint(cut.left.references, cut.right.references),
    rulesVersion: SEQUENCE_RULES_VERSION,
  };
}

export interface TransitionFreshness {
  /** `other_cut`: the frozen truth belongs to a different address (never compared) */
  status: "current" | "stale" | "other_cut";
  reasons: string[];
}

/** Is a frozen transition run truth still a description of this cut? Local: only this cut's own inputs count. */
export function transitionFreshness(
  frozen: TransitionRunTruth,
  cut: Pick<CutTransition, "truth">,
): TransitionFreshness {
  const now = cut.truth;
  if (frozen.transitionKey !== now.transitionKey) return { status: "other_cut", reasons: [] };
  const reasons: string[] = [];
  if (frozen.leftSubjectFingerprint !== now.leftSubjectFingerprint)
    reasons.push("The left picture at the cut changed (source, trim or edge frame).");
  if (frozen.rightSubjectFingerprint !== now.rightSubjectFingerprint)
    reasons.push("The right picture at the cut changed (source, trim or edge frame).");
  if (frozen.subjectFingerprint !== now.subjectFingerprint && reasons.length === 0)
    reasons.push("The cut-edge policy changed.");
  if (frozen.criteriaFingerprint !== now.criteriaFingerprint)
    reasons.push("The continuity truth of this cut changed.");
  if (frozen.referenceFingerprint !== now.referenceFingerprint)
    reasons.push("A reference of this cut changed.");
  if (frozen.rulesVersion !== now.rulesVersion)
    reasons.push(`Prism's cut criteria changed (rules ${frozen.rulesVersion} → ${now.rulesVersion}).`);
  return { status: reasons.length ? "stale" : "current", reasons };
}

// ───────────────────────── persisted transition subject (3A.4C) ─────────────────────────

/**
 * One side of a cut exactly as a transition run freezes it (`continuity_transition_subjects.left_side / right_side`),
 * taken from the 3A.4A side descriptors: the pinned picture (kind, attempt, Asset, checksum, trims), the evaluated
 * edge window and computed edge still (DESCRIPTORS: no derived edge Asset exists yet), the side's subject
 * fingerprint, its usability and the references its applicable criteria could use. A changed shape is a new version.
 */
export interface PersistedCutSide {
  version: "cut-side-snapshot-v1";
  side: "left" | "right";
  itemId: string;
  shotId: string;
  shotCode: string | null;
  picture: CutPicture;
  window: EdgeWindowDescriptor | null;
  still: EdgeStillDescriptor | null;
  /** `TransitionRunTruth.leftSubjectFingerprint` / `rightSubjectFingerprint` of the run */
  subjectFingerprint: string;
  usable: boolean;
  references: CutReference[];
}

export function persistedCutSide(cut: CutTransition, which: "left" | "right"): PersistedCutSide {
  const side = which === "left" ? cut.left : cut.right;
  return {
    version: "cut-side-snapshot-v1",
    side: which,
    itemId: side.itemId,
    shotId: side.shotId,
    shotCode: side.shotCode,
    picture: structuredClone(side.picture),
    window: side.window ? { ...side.window } : null,
    still: side.still ? { ...side.still } : null,
    subjectFingerprint:
      which === "left" ? cut.truth.leftSubjectFingerprint : cut.truth.rightSubjectFingerprint,
    usable: side.usable,
    references: side.references.map((r) => ({ ...r, usedBy: [...r.usedBy] })),
  };
}

// ───────────────────────── cut intent ─────────────────────────

// Defined in ./cut-intent (shared with the Episode Edit model since 3A.4C persists it); re-exported unchanged.
export { CUT_INTENT_KINDS, cutIntentEffective, type CutIntent, type CutIntentKind } from "./cut-intent";

// ───────────────────────── assessment ─────────────────────────

export const TRANSITION_STATES = [
  "no_sequence_qa",
  "sequence_stale",
  "critical_break",
  "analysis_running",
  "needs_review",
  "unchecked_transition",
  "intentional_accepted",
  "no_blocking_mismatch",
] as const;
export type TransitionState = (typeof TRANSITION_STATES)[number];

/** Never "pass", "approved" or "continuity perfect": QA is advisory. */
export const TRANSITION_STATE_LABELS: Record<TransitionState, string> = {
  no_sequence_qa: "No sequence QA yet",
  sequence_stale: "Sequence QA stale",
  critical_break: "Critical continuity break",
  analysis_running: "Sequence QA running",
  needs_review: "Needs review",
  unchecked_transition: "Unchecked transition",
  intentional_accepted: "Intentional discontinuity accepted",
  no_blocking_mismatch: "No blocking mismatch found",
};

/**
 * A finding with its EFFECTIVE result (human overrides already applied by the caller). In a run, only `criterionKey`
 * and `result` are read: the category, severity and coverability always come from the cut's CURRENT criterion.
 */
export interface EffectiveCutFinding {
  criterionKey: string;
  category: ContinuityCategory;
  severity: ContinuitySeverity;
  result: ContinuityResult;
  intentCoverable: boolean;
}

export interface TransitionRun {
  truth: TransitionRunTruth;
  analysisStatus: "queued" | "running" | "complete" | "failed";
  findings: EffectiveCutFinding[];
}

export interface TransitionAssessment {
  state: TransitionState;
  /** the composed findings the state was derived from, one per current criterion (`effectiveTransitionFindings`) */
  findings: EffectiveCutFinding[];
  label: string;
  freshness: TransitionFreshness | null;
  intentEffective: boolean;
  counts: {
    criticalFailures: number;
    failures: number;
    warnings: number;
    importantUnchecked: number;
    coveredByIntent: number;
  };
}

/**
 * The cut's findings as an assessment reads them, one per CURRENT criterion, merged by criterion key:
 *   - deterministic criteria: always the cut's current projection, recomputed on read (never a run's frozen value);
 *   - analyzer / manual criteria: the current run's effective result when it has one, otherwise the projection's
 *     `unchecked` / `n_a`. Missing analysis is never a pass, so a failed or incomplete run stays unchecked;
 *   - `n_a` is Prism's decision and is never replaced by a run;
 *   - run findings for criteria the cut no longer has are ignored.
 * Pass `run: null` when there is no CURRENT run (none, stale or another cut's).
 */
export function effectiveTransitionFindings(
  cut: Pick<CutTransition, "criteria" | "findings">,
  run: Pick<TransitionRun, "findings"> | null,
): EffectiveCutFinding[] {
  const projected = new Map(cut.findings.map((f) => [f.criterionKey, f.result]));
  const analyzed = new Map((run?.findings ?? []).map((f) => [f.criterionKey, f.result]));
  return cut.criteria.map((c) => {
    const fromRun =
      c.handler !== "deterministic" && c.applicability === "applies" ? analyzed.get(c.key) : undefined;
    return {
      criterionKey: c.key,
      category: c.category,
      severity: c.severity,
      result: fromRun ?? projected.get(c.key) ?? "unchecked",
      intentCoverable: c.intentCoverable,
    };
  });
}

const covered = (f: EffectiveCutFinding, intent: CutIntent | null) =>
  !!intent && f.intentCoverable && (intent.scope.length === 0 || intent.scope.includes(f.category));

/**
 * The cut's advisory state, in precedence order. A live deterministic source-integrity failure leads even without a
 * run (the one case where a deterministic fact leads). Otherwise: no run → stale → critical break → running → needs
 * review → unchecked → intentional accepted → no blocking mismatch. Without a current run the state is "No sequence
 * QA yet" whatever the deterministic warnings (they stay visible as findings); with one, the composed findings
 * (current deterministic projection + the run's semantic results) decide, so a deterministic warning that appears
 * after the run makes the cut "Needs review".
 */
export function assessTransition(args: {
  cut: CutTransition;
  run: TransitionRun | null;
  intent?: CutIntent | null;
}): TransitionAssessment {
  const { cut, run } = args;
  const effective = cutIntentEffective(args.intent, cut.address);
  const intent = effective ? args.intent! : null;
  const integrity = cut.findings.find((f) => f.criterionKey === "cut:source_integrity")?.result === "fail";
  const freshness = run ? transitionFreshness(run.truth, cut) : null;
  const findings = effectiveTransitionFindings(cut, run && freshness?.status === "current" ? run : null);
  const open = findings.filter((f) => (f.result === "fail" || f.result === "warn") && !covered(f, intent));
  const counts = {
    criticalFailures: open.filter((f) => f.result === "fail" && f.severity === "critical").length,
    failures: open.filter((f) => f.result === "fail").length,
    warnings: open.filter((f) => f.result === "warn").length,
    importantUnchecked: findings.filter((f) => f.result === "unchecked" && f.severity !== "minor").length,
    coveredByIntent: findings.filter(
      (f) => (f.result === "fail" || f.result === "warn") && covered(f, intent),
    ).length,
  };
  const out = (state: TransitionState): TransitionAssessment => ({
    state,
    label: TRANSITION_STATE_LABELS[state],
    findings,
    freshness,
    intentEffective: effective,
    counts,
  });
  if (integrity) return out("critical_break");
  if (!run || freshness!.status === "other_cut") return out("no_sequence_qa");
  if (freshness!.status === "stale") return out("sequence_stale");
  if (counts.criticalFailures > 0) return out("critical_break");
  if (run.analysisStatus === "queued" || run.analysisStatus === "running") return out("analysis_running");
  if (counts.failures > 0 || counts.warnings > 0) return out("needs_review");
  if (counts.importantUnchecked > 0) return out("unchecked_transition");
  if (counts.coveredByIntent > 0) return out("intentional_accepted");
  return out("no_blocking_mismatch");
}
