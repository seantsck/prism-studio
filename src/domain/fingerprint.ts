import type { ShotContext } from "./context";
import { fingerprint } from "./hash";
import { timelineFromContext } from "./timeline";

/**
 * Freshness / stale-asset signals.
 *
 * A shot is described by named PARTS (camera, looks, location, performance...), each reduced to a
 * deterministic content hash. Artifacts record the parts they were built from:
 *   - a storyboard frame stores the parts at approval time (storyboard_frames.approved_snapshot)
 *   - a generation attempt stores the package fingerprint (immutable)
 * Comparing stored parts to the current ones says not just THAT something is stale but WHAT changed.
 * Deliberately not event sourcing: hashes of current state, nothing more.
 */

export const FRESHNESS_PARTS = [
  "story",
  "camera",
  "blocking",
  "characters",
  "looks",
  "location",
  "props",
  "lighting",
  "action",
  "continuity",
  "constraints",
  "performance",
  "timing",
] as const;
export type FreshnessPart = (typeof FRESHNESS_PARTS)[number];
export type ShotParts = Record<FreshnessPart, string>;

/** The parts that decide what a storyboard frame must depict. */
export const VISUAL_PARTS: readonly FreshnessPart[] = [
  "camera",
  "blocking",
  "characters",
  "looks",
  "location",
  "props",
  "lighting",
  "action",
  "continuity",
];

export const PART_LABELS: Record<FreshnessPart, string> = {
  story: "Story intent",
  camera: "Camera setup",
  blocking: "Blocking",
  characters: "Character assignment",
  looks: "Character Look",
  location: "Location / set",
  props: "Props",
  lighting: "Lighting",
  action: "Action timing",
  continuity: "Continuity",
  constraints: "Constraints",
  performance: "Selected performance",
  timing: "Derived timing",
};

export function computeShotParts(ctx: ShotContext): ShotParts {
  const { shot } = ctx;
  const timeline = timelineFromContext(ctx);
  return {
    story: fingerprint({
      storyBeat: shot.storyBeat,
      dramaticPurpose: shot.dramaticPurpose,
      scene: [ctx.scene.slugline, ctx.scene.summary, ctx.scene.dramaticPurpose],
    }),
    camera: fingerprint(shot.composition),
    blocking: fingerprint(shot.spatial),
    characters: fingerprint(
      ctx.characters.map((c) => ({
        assignment: c.assignment,
        physicalDescription: c.character?.physicalDescription ?? null,
        identityRefs: c.identityRefs.map((r) => [r.slot, r.assetId, r.locked]).sort(),
      })),
    ),
    looks: fingerprint(
      ctx.characters.map((c) =>
        c.look
          ? {
              id: c.look.id,
              wardrobe: c.look.wardrobe,
              shoes: c.look.shoes,
              jewelry: c.look.jewelry,
              hair: c.look.hair,
              makeup: c.look.makeup,
              grooming: c.look.grooming,
              bodyNotes: c.look.bodyNotes,
              accessories: c.look.accessories,
              referenceAssetIds: c.look.referenceAssetIds,
              locked: c.look.locked,
            }
          : null,
      ),
    ),
    location: fingerprint(
      ctx.location
        ? {
            id: ctx.location.id,
            description: ctx.location.description,
            geography: ctx.location.geography,
            zones: ctx.location.zones,
            entrances: ctx.location.entrances,
            lighting: ctx.location.lighting,
            referenceAssetIds: ctx.location.referenceAssetIds,
            locked: ctx.location.locked,
          }
        : null,
    ),
    props: fingerprint(ctx.props.map((p) => [p.id, p.name, p.description]).sort()),
    lighting: fingerprint(shot.lighting),
    // Beat ids are regenerated on every save, so they are not part of the content.
    action: fingerprint({
      beats: [...shot.action.beats]
        .sort((a, b) => a.order - b.order)
        .map((b) => [b.atMs, b.description]),
      beginningPose: shot.action.beginningPose,
      endingPose: shot.action.endingPose,
    }),
    continuity: fingerprint(shot.continuity),
    constraints: fingerprint({ constraints: shot.constraints, guardrails: ctx.bible.guardrails }),
    performance: fingerprint(
      ctx.lines.map((l) => ({
        lineId: l.line.id,
        text: l.line.originalText,
        direction: l.direction,
        take: l.selectedTake
          ? {
              id: l.selectedTake.id,
              durationMs: l.selectedTake.durationMs,
              audioAssetId: l.selectedTake.audioAssetId,
              checksum: l.selectedAudioAsset?.checksum ?? null,
            }
          : null,
      })),
    ),
    timing: fingerprint({
      total: timeline.totalMs,
      source: timeline.source,
      segments: timeline.segments.map((s) => [s.kind, s.startMs, s.endMs]),
    }),
  };
}

export function visualFingerprint(parts: ShotParts): string {
  return fingerprint(VISUAL_PARTS.map((p) => [p, parts[p]]));
}

export function overallFingerprint(parts: ShotParts): string {
  return fingerprint(FRESHNESS_PARTS.map((p) => [p, parts[p]]));
}

export interface ApprovedSnapshot {
  parts: Partial<Record<FreshnessPart, string>>;
  durationMs: number;
}

/** What gets stored on a storyboard frame when it is approved. */
export function approvalSnapshot(ctx: ShotContext): { fingerprint: string; snapshot: ApprovedSnapshot } {
  const parts = computeShotParts(ctx);
  return {
    fingerprint: visualFingerprint(parts),
    snapshot: { parts, durationMs: timelineFromContext(ctx).totalMs },
  };
}

export type StoryboardFreshnessStatus = "none" | "fresh" | "stale" | "unknown";

export interface StoryboardFreshness {
  status: StoryboardFreshnessStatus;
  /** Visual parts that differ from the approved snapshot. */
  changedParts: FreshnessPart[];
  /** Non-visual: the performance/timing changed since approval. */
  timingChange: { fromMs: number; toMs: number } | null;
  messages: string[];
}

export function storyboardFreshness(
  ctx: ShotContext,
  approved: { approvedFingerprint: string | null; approvedSnapshot: ApprovedSnapshot | null } | null,
): StoryboardFreshness {
  if (!approved) return { status: "none", changedParts: [], timingChange: null, messages: [] };
  const current = computeShotParts(ctx);
  const snap = approved.approvedSnapshot;
  if (!snap && !approved.approvedFingerprint)
    return {
      status: "unknown",
      changedParts: [],
      timingChange: null,
      messages: ["Approved before change tracking existed; re-approve to start tracking freshness."],
    };

  let changed: FreshnessPart[] = [];
  if (snap) {
    changed = VISUAL_PARTS.filter((p) => snap.parts[p] !== undefined && snap.parts[p] !== current[p]);
  } else if (approved.approvedFingerprint !== visualFingerprint(current)) {
    changed = [...VISUAL_PARTS]; // fingerprint only: cannot say which part
  }
  const toMs = timelineFromContext(ctx).totalMs;
  const timingChange =
    snap && snap.durationMs !== toMs ? { fromMs: snap.durationMs, toMs } : null;

  const messages: string[] = [];
  for (const p of changed) {
    messages.push(
      p === "looks"
        ? "Character Look changed after storyboard approval."
        : p === "camera"
          ? "Storyboard frame predates the current camera setup."
          : `${PART_LABELS[p]} changed after storyboard approval.`,
    );
  }
  if (timingChange)
    messages.push(
      `Selected performance changed; derived duration changed from ${(timingChange.fromMs / 1000).toFixed(1)}s → ${(timingChange.toMs / 1000).toFixed(1)}s.`,
    );
  return {
    status: changed.length > 0 ? "stale" : "fresh",
    changedParts: changed,
    timingChange,
    messages,
  };
}
