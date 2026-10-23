import { buildAnimaticTimeline } from "./animatic";
import { shotOrder, type ShotContext } from "./context";
import { PART_LABELS, storyboardFreshness, type FreshnessPart } from "./fingerprint";
import { fingerprint } from "./hash";
import type { PreflightReport } from "./preflight";
import {
  productionFrameFreshness,
  shotProductionAspect,
  type ProductionFrameSource,
} from "./production-frame";
import type { ProjectData, Shot } from "./schemas";
import { summarizeEpisode } from "./summary";

/**
 * Phase 2G.5 Shot Sequence Board: the episode reviewed as a SEQUENCE OF CANONICAL STILLS ("do these Shots cut
 * together?"). Everything here is DERIVED from existing production truth (Shot order, the selected Production Frame,
 * Storyboard approval, the selected Location View, Character Continuity selections and the Shot's continuity fields).
 * Nothing is persisted, no freshness part is added and the GenerationPackage is unchanged. Pure: no database, provider,
 * AI analysis, 3D set or GPU.
 *
 * The only write the board offers is the explicit continuity-link sync (`planSequenceLinkSync`): it changes
 * `shot.continuity.previousShotId` and nothing else, only for Shots that differ, only after the filmmaker confirmed the
 * exact preview, and never for a locked Shot.
 */

// ───────────────────────── per-Shot model ─────────────────────────

/** Which image the card shows. Never equivalent: only `production_frame` is canonical production imagery. */
export type SequenceVisualKind = "production_frame" | "approved_storyboard" | "draft_storyboard" | "none";

export const SEQUENCE_VISUAL_LABEL: Record<SequenceVisualKind, string> = {
  production_frame: "Production Frame",
  approved_storyboard: "Storyboard fallback",
  draft_storyboard: "Draft Storyboard only",
  none: "No production image",
};

/** Derived per-Shot visual / integrity state. Never persisted. */
export type SequenceHealth =
  | "current_production_frame"
  | "stale_production_frame"
  | "storyboard_fallback"
  | "draft_storyboard_only"
  | "missing_visual"
  | "integrity_blocked";

export const SEQUENCE_HEALTH_LABEL: Record<SequenceHealth, string> = {
  current_production_frame: "Current Production Frame",
  stale_production_frame: "Stale Production Frame",
  storyboard_fallback: "Storyboard fallback",
  draft_storyboard_only: "Draft Storyboard only",
  missing_visual: "No production image",
  integrity_blocked: "Integrity blocker",
};

export interface SequenceVisual {
  kind: SequenceVisualKind;
  /** the private Asset to show (delivered by the existing private asset route); null = placeholder */
  assetId: string | null;
  /** the image's own pixel shape when known (a Production Frame is production-shaped by construction) */
  width: number | null;
  height: number | null;
  /** "fresh" / "stale" for a Production Frame or an approved Storyboard; "unknown" for an untracked approval */
  freshness: "fresh" | "stale" | "unknown" | "none";
  changedParts: FreshnessPart[];
  messages: string[];
  version: number | null;
}

export interface SequenceProductionFrame {
  id: string;
  version: number;
  source: ProductionFrameSource;
  /** current = fresh; stale = the Shot changed since the frame was made (the frame stays selected and shown) */
  status: "current" | "stale";
  changedParts: FreshnessPart[];
  messages: string[];
  assetId: string;
  width: number;
  height: number;
  productionAspectRatio: string;
  /** frozen attempt metadata when the frame came from a generation that still resolves; null otherwise */
  generated: { provider: string; model: string; attemptNumber: number } | null;
}

export interface SequenceStoryboard {
  approved: { frameId: string; version: number; freshness: "fresh" | "stale" | "unknown" } | null;
  latest: { frameId: string; version: number; approved: boolean } | null;
}

export interface SequenceCharacter {
  characterId: string;
  name: string;
  /** "lock" = a selected Character Continuity Lock is authoritative; "live" = the editable library */
  authority: "lock" | "live";
  lock: { id: string; name: string; lockFingerprint: string } | null;
  lookId: string | null;
  lookName: string | null;
  /** a stored selection that no longer matches the assignment (integrity blocker, never a silent fallback) */
  issue: string | null;
}

export interface SequenceIntegrityIssue {
  code: "location_view" | "character_continuity" | "continuity_orphan";
  message: string;
}

export interface ShotSequenceItem {
  shotId: string;
  shotCode: string;
  title: string;
  status: Shot["status"];
  locked: boolean;
  sceneId: string;
  sceneNumber: string;
  sceneSlugline: string;
  /** 0-based position in the episode's actual editorial order (`shotOrder`) */
  sequenceIndex: number;
  /** from the Animatic timeline: the same duration model, never a second one */
  startMs: number;
  durationMs: number;
  visual: SequenceVisual;
  health: SequenceHealth;
  productionFrame: SequenceProductionFrame | null;
  storyboard: SequenceStoryboard;
  /** the Shot's production aspect ("2.39:1"), used to shape a fallback / placeholder */
  productionAspect: { raw: string; w: number; h: number } | null;
  location: { id: string; name: string } | null;
  locationView: { id: string; name: string } | null;
  characters: SequenceCharacter[];
  continuity: {
    previousShotId: string | null;
    screenDirection: string;
    facingDirection: string;
    weather: string;
    timeOfDay: string;
  };
  link: SequenceLink;
  integrityIssues: SequenceIntegrityIssue[];
  preflightBlockers: number;
}

// ───────────────────────── stored previous-Shot link ─────────────────────────

export type SequenceLinkStatus = "synced" | "missing" | "wrong";

export interface SequenceLink {
  /** the Shot immediately before this one in the actual order; null for the episode's first Shot */
  expectedPreviousShotId: string | null;
  /** `shot.continuity.previousShotId` as persisted (continuity intent, separate from order) */
  storedPreviousShotId: string | null;
  status: SequenceLinkStatus;
}

function linkOf(stored: string | null, expected: string | null): SequenceLink {
  const status: SequenceLinkStatus = stored === expected ? "synced" : stored === null ? "missing" : "wrong";
  return { expectedPreviousShotId: expected, storedPreviousShotId: stored, status };
}

// ───────────────────────── transitions ─────────────────────────

export type TransitionCategory =
  | "sequence_link"
  | "scene"
  | "location"
  | "location_view"
  | "characters"
  | "character_continuity"
  | "look"
  | "screen_direction"
  | "weather"
  | "time_of_day";

/**
 * A transition fact. Only a sequence-link mismatch is an `error`. Everything else that differs is a `change`: a human
 * review aid describing what changes across the cut, which may be an intentional filmmaking decision. `stable` records
 * what demonstrably carries over (same Lock, same Look, same Location / View).
 */
export interface TransitionFact {
  category: TransitionCategory;
  severity: "error" | "change" | "stable";
  /** a Character name for character facts */
  subject?: string;
  message: string;
  from?: string | null;
  to?: string | null;
}

export interface ShotSequenceTransition {
  fromShotId: string;
  toShotId: string;
  fromShotCode: string;
  toShotCode: string;
  crossesScene: boolean;
  expectedPreviousShotId: string;
  storedPreviousShotId: string | null;
  linkStatus: SequenceLinkStatus;
  /** errors + changes (what a reviewer needs to look at) */
  changes: TransitionFact[];
  stable: TransitionFact[];
}

const said = (s: string | null | undefined) => (s ?? "").trim();
const differs = (a: string, b: string) => a !== "" && b !== "" && a.toLowerCase() !== b.toLowerCase();

function characterFacts(a: ShotSequenceItem, b: ShotSequenceItem): TransitionFact[] {
  const facts: TransitionFact[] = [];
  const inA = new Map(a.characters.map((c) => [c.characterId, c]));
  const inB = new Map(b.characters.map((c) => [c.characterId, c]));
  for (const c of a.characters)
    if (!inB.has(c.characterId))
      facts.push({ category: "characters", severity: "change", subject: c.name, message: `${c.name} exits` });
  for (const c of b.characters)
    if (!inA.has(c.characterId))
      facts.push({
        category: "characters",
        severity: "change",
        subject: c.name,
        message: `${c.name} enters`,
      });
  for (const to of b.characters) {
    const from = inA.get(to.characterId);
    // an invalid stored selection is the Shot's integrity blocker; its appearance is not compared
    if (!from || from.issue || to.issue) continue;
    const name = to.name;
    if (from.lock && to.lock) {
      if (from.lock.lockFingerprint === to.lock.lockFingerprint)
        facts.push({
          category: "character_continuity",
          severity: "stable",
          subject: name,
          message: `${name}: same Continuity Lock "${to.lock.name}"`,
        });
      else
        facts.push({
          category: "character_continuity",
          severity: "change",
          subject: name,
          message: `${name}: Continuity Lock "${from.lock.name}" → "${to.lock.name}"`,
          from: from.lock.name,
          to: to.lock.name,
        });
    } else if (from.lock || to.lock) {
      const label = (c: SequenceCharacter) =>
        c.lock
          ? `Continuity Lock "${c.lock.name}"`
          : `live appearance${c.lookName ? ` · ${c.lookName}` : ""}`;
      facts.push({
        category: "character_continuity",
        severity: "change",
        subject: name,
        message: `${name}: ${label(from)} → ${label(to)} (appearance authority changes)`,
        from: label(from),
        to: label(to),
      });
    } else if (from.lookId !== to.lookId) {
      facts.push({
        category: "look",
        severity: "change",
        subject: name,
        message: `${name}: Look ${from.lookName ?? "none"} → ${to.lookName ?? "none"}`,
        from: from.lookName,
        to: to.lookName,
      });
    } else if (to.lookId) {
      facts.push({
        category: "look",
        severity: "stable",
        subject: name,
        message: `${name}: same Look ${to.lookName ?? ""}`.trim(),
      });
    }
  }
  return facts;
}

function locationFacts(a: ShotSequenceItem, b: ShotSequenceItem): TransitionFact[] {
  const name = (i: ShotSequenceItem) => i.location?.name ?? "no Location";
  if ((a.location?.id ?? null) !== (b.location?.id ?? null))
    return [
      {
        category: "location",
        severity: "change",
        message: `Location ${name(a)} → ${name(b)}`,
        from: a.location?.name ?? null,
        to: b.location?.name ?? null,
      },
    ];
  if (!b.location) return [];
  // the View is optional: without a selected View on both sides nothing is inferred
  if (!a.locationView || !b.locationView)
    return [{ category: "location", severity: "stable", message: `Same Location ${b.location.name}` }];
  if (a.locationView.id === b.locationView.id)
    return [
      {
        category: "location_view",
        severity: "stable",
        message: `Same Location ${b.location.name}, same View ${b.locationView.name}`,
      },
    ];
  return [
    {
      category: "location_view",
      severity: "change",
      message: `${b.location.name}: View ${a.locationView.name} → ${b.locationView.name}`,
      from: a.locationView.name,
      to: b.locationView.name,
    },
  ];
}

function textFact(
  category: "screen_direction" | "weather" | "time_of_day",
  label: string,
  from: string,
  to: string,
  note = "",
): TransitionFact[] {
  return differs(from, to)
    ? [{ category, severity: "change", message: `${label} changes: ${from} → ${to}${note}`, from, to }]
    : [];
}

/** The derived facts across one cut (A immediately before B in the actual order). */
export function describeTransition(a: ShotSequenceItem, b: ShotSequenceItem): ShotSequenceTransition {
  const facts: TransitionFact[] = [];
  if (b.link.status !== "synced")
    facts.push({
      category: "sequence_link",
      severity: "error",
      message:
        b.link.status === "missing"
          ? `${b.shotCode} has no stored previous Shot; the sequence puts ${a.shotCode} before it.`
          : `${b.shotCode} stores a different previous Shot than ${a.shotCode}, which the sequence puts before it.`,
      from: b.link.storedPreviousShotId,
      to: a.shotId,
    });
  if (a.sceneId !== b.sceneId)
    facts.push({
      category: "scene",
      severity: "change",
      message: `Scene ${a.sceneNumber} → Scene ${b.sceneNumber} (${b.sceneSlugline})`,
      from: a.sceneNumber,
      to: b.sceneNumber,
    });
  facts.push(...locationFacts(a, b), ...characterFacts(a, b));
  const review = " (needs human review)";
  facts.push(
    ...textFact(
      "screen_direction",
      "Screen direction",
      a.continuity.screenDirection,
      b.continuity.screenDirection,
      review,
    ),
    ...textFact(
      "screen_direction",
      "Facing direction",
      a.continuity.facingDirection,
      b.continuity.facingDirection,
      review,
    ),
    ...textFact("weather", "Weather", a.continuity.weather, b.continuity.weather),
    ...textFact("time_of_day", "Time of day", a.continuity.timeOfDay, b.continuity.timeOfDay),
  );
  return {
    fromShotId: a.shotId,
    toShotId: b.shotId,
    fromShotCode: a.shotCode,
    toShotCode: b.shotCode,
    crossesScene: a.sceneId !== b.sceneId,
    expectedPreviousShotId: a.shotId,
    storedPreviousShotId: b.link.storedPreviousShotId,
    linkStatus: b.link.status,
    changes: facts.filter((f) => f.severity !== "stable"),
    stable: facts.filter((f) => f.severity === "stable"),
  };
}

// ───────────────────────── the sequence ─────────────────────────

export interface ShotSequenceSummary {
  shots: number;
  currentProductionFrames: number;
  staleProductionFrames: number;
  missingProductionFrames: number;
  /** Shots without a Production Frame that show an (approved or draft) Storyboard instead */
  storyboardOnlyShots: number;
  noVisualShots: number;
  linkMismatches: number;
  integrityBlockedShots: number;
  /** equals the Animatic's total for the same episode */
  runtimeMs: number;
}

export interface ShotSequence {
  episodeId: string;
  shots: ShotSequenceItem[];
  transitions: ShotSequenceTransition[];
  summary: ShotSequenceSummary;
}

function visualOf(ctx: ShotContext, pf: SequenceProductionFrame | null): SequenceVisual {
  if (pf)
    return {
      kind: "production_frame",
      assetId: pf.assetId,
      width: pf.width,
      height: pf.height,
      freshness: pf.status === "current" ? "fresh" : "stale",
      changedParts: pf.changedParts,
      messages: pf.messages,
      version: pf.version,
    };
  if (ctx.approvedFrame) {
    const f = storyboardFreshness(ctx, ctx.approvedFrame);
    return {
      kind: "approved_storyboard",
      assetId: ctx.approvedFrame.assetId,
      width: null,
      height: null,
      freshness: f.status === "stale" ? "stale" : f.status === "unknown" ? "unknown" : "fresh",
      changedParts: f.changedParts,
      messages: f.messages,
      version: ctx.approvedFrame.version,
    };
  }
  const latest = ctx.frames[0];
  if (latest)
    return {
      kind: "draft_storyboard",
      assetId: latest.assetId,
      width: null,
      height: null,
      freshness: "none",
      changedParts: [],
      messages: [],
      version: latest.version,
    };
  return {
    kind: "none",
    assetId: null,
    width: null,
    height: null,
    freshness: "none",
    changedParts: [],
    messages: [],
    version: null,
  };
}

function itemOf(
  data: ProjectData,
  ctx: ShotContext,
  report: PreflightReport,
  index: number,
  expectedPrevious: string | null,
  timing: { startMs: number; durationMs: number },
): ShotSequenceItem {
  const { shot } = ctx;
  const selected = ctx.selectedProductionFrame;
  let productionFrame: SequenceProductionFrame | null = null;
  if (selected) {
    const fresh = productionFrameFreshness(ctx, selected);
    const attempt =
      selected.source === "generation_output" && selected.sourceGenerationAttemptId
        ? data.attempts.find((a) => a.id === selected.sourceGenerationAttemptId)
        : undefined;
    productionFrame = {
      id: selected.id,
      version: selected.version,
      source: selected.source,
      status: fresh.status === "stale" ? "stale" : "current",
      changedParts: fresh.changedParts,
      messages: fresh.messages,
      assetId: selected.assetId,
      width: selected.width,
      height: selected.height,
      productionAspectRatio: selected.productionAspectRatio,
      generated: attempt
        ? { provider: attempt.provider, model: attempt.model, attemptNumber: attempt.attemptNumber }
        : null,
    };
  }
  const approvedFresh = ctx.approvedFrame ? storyboardFreshness(ctx, ctx.approvedFrame) : null;
  const storyboard: SequenceStoryboard = {
    approved: ctx.approvedFrame
      ? {
          frameId: ctx.approvedFrame.id,
          version: ctx.approvedFrame.version,
          freshness:
            approvedFresh?.status === "stale"
              ? "stale"
              : approvedFresh?.status === "unknown"
                ? "unknown"
                : "fresh",
        }
      : null,
    latest: ctx.frames[0]
      ? { frameId: ctx.frames[0].id, version: ctx.frames[0].version, approved: ctx.frames[0].approved }
      : null,
  };
  const visual = visualOf(ctx, productionFrame);

  const integrityIssues: SequenceIntegrityIssue[] = [];
  if (ctx.locationViewIssue)
    integrityIssues.push({ code: "location_view", message: ctx.locationViewIssue.message });
  for (const c of ctx.characters)
    if (c.continuityLockIssue)
      integrityIssues.push({
        code: "character_continuity",
        message: `${c.character?.name ?? "A Character"}: ${c.continuityLockIssue.message}`,
      });
  for (const o of ctx.continuityLockOrphans)
    integrityIssues.push({ code: "continuity_orphan", message: o.message });

  const health: SequenceHealth =
    integrityIssues.length > 0
      ? "integrity_blocked"
      : productionFrame
        ? productionFrame.status === "stale"
          ? "stale_production_frame"
          : "current_production_frame"
        : visual.kind === "approved_storyboard"
          ? "storyboard_fallback"
          : visual.kind === "draft_storyboard"
            ? "draft_storyboard_only"
            : "missing_visual";

  const aspect = shotProductionAspect(shot, ctx.bible);
  return {
    shotId: shot.id,
    shotCode: shot.shotCode,
    title: shot.title,
    status: shot.status,
    locked: shot.status === "locked",
    sceneId: shot.sceneId,
    sceneNumber: ctx.scene.sceneNumber,
    sceneSlugline: ctx.scene.slugline,
    sequenceIndex: index,
    startMs: timing.startMs,
    durationMs: timing.durationMs,
    visual,
    health,
    productionFrame,
    storyboard,
    productionAspect: aspect ? { raw: aspect.raw, w: aspect.ratio.w, h: aspect.ratio.h } : null,
    location: ctx.location ? { id: ctx.location.id, name: ctx.location.name } : null,
    locationView: ctx.selectedLocationView
      ? { id: ctx.selectedLocationView.id, name: ctx.selectedLocationView.name }
      : null,
    characters: ctx.characters.map((c) => ({
      characterId: c.assignment.characterId,
      name: c.character?.name ?? c.appearance.name ?? "Unknown Character",
      authority: c.appearance.source === "continuity_lock" ? "lock" : "live",
      lock: c.appearance.lock
        ? {
            id: c.appearance.lock.lockId,
            name: c.appearance.lock.name,
            lockFingerprint: c.appearance.lock.lockFingerprint,
          }
        : null,
      lookId: c.appearance.look?.id ?? null,
      lookName: c.appearance.look?.name ?? null,
      issue: c.continuityLockIssue?.message ?? null,
    })),
    continuity: {
      previousShotId: shot.continuity.previousShotId,
      screenDirection: said(shot.spatial.screenDirection),
      facingDirection: said(shot.spatial.facingDirection),
      weather: said(shot.continuity.weather),
      timeOfDay: said(shot.continuity.timeOfDay),
    },
    link: linkOf(shot.continuity.previousShotId, expectedPrevious),
    integrityIssues,
    preflightBlockers: report.blockers.length,
  };
}

/**
 * The episode as the filmmaker would cut it: `shotOrder` (Scene order, then Shot order), the Animatic's own durations,
 * one canonical display visual per Shot, every adjacent transition (including across Scene boundaries) and totals.
 */
export function buildShotSequence(data: ProjectData, episodeId: string): ShotSequence {
  const episode = data.episodes.find((e) => e.id === episodeId);
  if (!episode) throw new Error(`Episode ${episodeId} not found`);
  const summaries = summarizeEpisode(data, episode);
  const timeline = buildAnimaticTimeline(data, episodeId);
  const timing = new Map(
    timeline.clips.map((c) => [c.shotId, { startMs: c.startMs, durationMs: c.durationMs }]),
  );
  const shots = summaries.map(({ ctx, report }, i) =>
    itemOf(
      data,
      ctx,
      report,
      i,
      i === 0 ? null : summaries[i - 1].ctx.shot.id,
      timing.get(ctx.shot.id) ?? { startMs: 0, durationMs: 0 },
    ),
  );
  const transitions = shots.slice(1).map((b, i) => describeTransition(shots[i], b));
  const count = (pred: (s: ShotSequenceItem) => boolean) => shots.filter(pred).length;
  return {
    episodeId,
    shots,
    transitions,
    summary: {
      shots: shots.length,
      currentProductionFrames: count((s) => s.productionFrame?.status === "current"),
      staleProductionFrames: count((s) => s.productionFrame?.status === "stale"),
      missingProductionFrames: count((s) => !s.productionFrame),
      storyboardOnlyShots: count(
        (s) =>
          !s.productionFrame &&
          (s.visual.kind === "approved_storyboard" || s.visual.kind === "draft_storyboard"),
      ),
      noVisualShots: count((s) => s.visual.kind === "none"),
      linkMismatches: count((s) => s.link.status !== "synced"),
      integrityBlockedShots: count((s) => s.integrityIssues.length > 0),
      runtimeMs: timeline.totalMs,
    },
  };
}

/** Human labels for a stale visual's changed parts. */
export const changedPartLabels = (parts: readonly FreshnessPart[]) => parts.map((p) => PART_LABELS[p]);

// ───────────────────────── explicit continuity-link sync ─────────────────────────

export interface SequenceLinkChange {
  shotId: string;
  shotCode: string;
  fromPreviousShotId: string | null;
  fromPreviousShotCode: string | null;
  toPreviousShotId: string | null;
  toPreviousShotCode: string | null;
  locked: boolean;
}

/** The episode's Shots in the actual editorial order (the same `shotOrder` the board, Storyboard and Animatic use). */
const orderedEpisodeShots = (data: ProjectData, episodeId: string): Shot[] =>
  data.shots.filter((s) => s.episodeId === episodeId).sort(shotOrder(data));

/**
 * Every Shot whose stored previous-Shot link differs from the Shot before it in the actual order (the first Shot's
 * expected link is null). Shots already correct are not listed, so a sync never touches them.
 */
export function sequenceLinkChanges(data: ProjectData, episodeId: string): SequenceLinkChange[] {
  const shots = orderedEpisodeShots(data, episodeId);
  const codeOf = (id: string | null) =>
    id === null ? null : (data.shots.find((s) => s.id === id)?.shotCode ?? "(missing Shot)");
  return shots.flatMap((shot, i) => {
    const expected = i === 0 ? null : shots[i - 1].id;
    const stored = shot.continuity.previousShotId;
    if (stored === expected) return [];
    return [
      {
        shotId: shot.id,
        shotCode: shot.shotCode,
        fromPreviousShotId: stored,
        fromPreviousShotCode: codeOf(stored),
        toPreviousShotId: expected,
        toPreviousShotCode: codeOf(expected),
        locked: shot.status === "locked",
      },
    ];
  });
}

/**
 * The SYNC PREVIEW KEY: optimistic-concurrency protection for the link-sync action ONLY. It hashes what the preview
 * was computed from (the ordered Shot ids, their stored previous-Shot links and locked state), so a confirmation made
 * from an outdated preview is refused instead of applied. It is NOT Shot freshness, NOT GenerationPackage provenance and
 * NOT a persistent identity: it is never stored.
 */
export function sequenceLinkPreviewKey(data: ProjectData, episodeId: string): string {
  return fingerprint({
    purpose: "prism.sequence-link-sync-preview",
    episodeId,
    shots: orderedEpisodeShots(data, episodeId).map((s) => [
      s.id,
      s.continuity.previousShotId,
      s.status === "locked",
    ]),
  });
}

export const SEQUENCE_CHANGED_MESSAGE = "The sequence changed. Review the new link changes before syncing.";

export type SequenceLinkSyncPlan =
  | { ok: true; changes: SequenceLinkChange[]; shots: Shot[] }
  | { ok: false; reason: "stale_preview" | "locked" | "nothing_to_sync"; message: string };

/**
 * Validates a confirmed sync against the CURRENT data and returns the updated Shots (only the ones that differ; each
 * changes `continuity.previousShotId` and nothing else). Refused whole when the preview is outdated or when any change
 * would touch a locked Shot: never a partial sync.
 */
export function planSequenceLinkSync(
  data: ProjectData,
  episodeId: string,
  confirmedPreviewKey: string,
): SequenceLinkSyncPlan {
  if (confirmedPreviewKey !== sequenceLinkPreviewKey(data, episodeId))
    return { ok: false, reason: "stale_preview", message: SEQUENCE_CHANGED_MESSAGE };
  const changes = sequenceLinkChanges(data, episodeId);
  if (changes.length === 0)
    return {
      ok: false,
      reason: "nothing_to_sync",
      message: "Every continuity link already matches the sequence.",
    };
  const locked = changes.filter((c) => c.locked);
  if (locked.length > 0)
    return {
      ok: false,
      reason: "locked",
      message: `Locked Shot${locked.length === 1 ? "" : "s"} ${locked.map((c) => c.shotCode).join(", ")} would need ${
        locked.length === 1 ? "its" : "their"
      } continuity link changed. Nothing was synced: unlock ${locked.length === 1 ? "it" : "them"} first, or keep the current links.`,
    };
  const byId = new Map(data.shots.map((s) => [s.id, s]));
  const shots = changes.map((c) => {
    const shot = byId.get(c.shotId)!;
    return { ...shot, continuity: { ...shot.continuity, previousShotId: c.toPreviousShotId } };
  });
  return { ok: true, changes, shots };
}
