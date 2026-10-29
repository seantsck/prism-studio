import type { ShotContext } from "./context";
import type { Shot } from "./schemas";

/**
 * The declared production truth on each side of a cut, and the facts that compare it. Shared by the Phase 2G.5 Shot
 * Sequence Board (planned order, canonical stills) and the Phase 3A.4 cut domain (the persisted Episode Edit's actual
 * order): one comparison, two orders. Pure: it compares DECLARED truth (Scene, Location / View, Character appearance
 * authority, the Shot's continuity text), never pixels, and it judges nothing. Every difference is a `change` for a
 * person to review, because a change across a cut may be an intentional filmmaking decision.
 */

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

/** One assigned Character's appearance authority, as the comparison needs it. */
export interface TransitionCharacterTruth {
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

/** The Shot's declared continuity text the comparison reads (trimmed; "" = not declared). */
export interface DeclaredContinuity {
  screenDirection: string;
  facingDirection: string;
  weather: string;
  timeOfDay: string;
}

/** Everything `describeTransitionTruth` reads about one side. A Sequence Board item and a cut side both satisfy it. */
export interface TransitionTruthSide {
  sceneId: string;
  sceneNumber: string;
  sceneSlugline: string;
  location: { id: string; name: string } | null;
  locationView: { id: string; name: string } | null;
  characters: TransitionCharacterTruth[];
  continuity: DeclaredContinuity;
}

export const declared = (s: string | null | undefined) => (s ?? "").trim();
/** Both sides declare a value and they differ (case-insensitive). An undeclared side never differs. */
export const declaredDiffers = (a: string, b: string) =>
  a !== "" && b !== "" && a.toLowerCase() !== b.toLowerCase();

// ───────────────────────── side truth from a Shot ─────────────────────────

/** The authoritative appearance of each assigned Character: a selected Lock is compared by the Lock, never the library. */
export function transitionCharactersOf(ctx: ShotContext): TransitionCharacterTruth[] {
  return ctx.characters.map((c) => ({
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
  }));
}

export function declaredContinuityOf(shot: Shot): DeclaredContinuity {
  return {
    screenDirection: declared(shot.spatial.screenDirection),
    facingDirection: declared(shot.spatial.facingDirection),
    weather: declared(shot.continuity.weather),
    timeOfDay: declared(shot.continuity.timeOfDay),
  };
}

/** The shared side truth of one Shot (its Scene, Location / View, Characters and declared continuity). */
export function transitionTruthOf(ctx: ShotContext): TransitionTruthSide {
  return {
    sceneId: ctx.shot.sceneId,
    sceneNumber: ctx.scene.sceneNumber,
    sceneSlugline: ctx.scene.slugline,
    location: ctx.location ? { id: ctx.location.id, name: ctx.location.name } : null,
    locationView: ctx.selectedLocationView
      ? { id: ctx.selectedLocationView.id, name: ctx.selectedLocationView.name }
      : null,
    characters: transitionCharactersOf(ctx),
    continuity: declaredContinuityOf(ctx.shot),
  };
}

// ───────────────────────── the comparison ─────────────────────────

export function characterFacts(a: TransitionTruthSide, b: TransitionTruthSide): TransitionFact[] {
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
      const label = (c: TransitionCharacterTruth) =>
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

export function locationFacts(a: TransitionTruthSide, b: TransitionTruthSide): TransitionFact[] {
  const name = (i: TransitionTruthSide) => i.location?.name ?? "no Location";
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
  return declaredDiffers(from, to)
    ? [{ category, severity: "change", message: `${label} changes: ${from} → ${to}${note}`, from, to }]
    : [];
}

/**
 * The declared-truth facts across one cut, A immediately before B, in a fixed order: Scene, Location / View,
 * Characters, screen / facing direction, weather, time of day. The previous-Shot LINK is not part of it: whether B's
 * stored link is right depends on which order is authoritative (the board's planned order, or the edit's actual
 * order), so each caller states its own link fact.
 */
export function describeTransitionTruth(a: TransitionTruthSide, b: TransitionTruthSide): TransitionFact[] {
  const facts: TransitionFact[] = [];
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
  return facts;
}
