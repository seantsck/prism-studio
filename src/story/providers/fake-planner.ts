import { SHOT_SIZES, type PlannedShot, type ShotPlan } from "@/domain/story/shot-list";
import type { ShotPlanRequest } from "../provider";

/**
 * Phase 5B-S4: the FREE test planner behind "Prism AI (test, free)". Deterministic, no network. It plans like a
 * cautious editor: a master for the space and the action, then dialogue coverage chosen per exchange (an
 * over-the-shoulder to open a two-person exchange, singles for the replies, a reaction on the listener for the last
 * line; a single for a lone speaker). It never inflates the count and never references anything outside the context.
 */
const short = (name: string) => name.split(/\s+/).at(-1) ?? name;

export function fakeShotPlan(req: ShotPlanRequest): ShotPlan {
  if (req.scope.kind === "shot" && req.basePlan)
    return regenerate(req.basePlan, req.scope.key, req.scope.note);
  const ctx = req.context;
  const sc = ctx.scene;
  const loc = ctx.locations[0] ?? null;
  const name = (k: string | null) => ctx.characters.find((c) => c.key === k)?.name ?? "the speaker";
  const everyone = ctx.characters.map((c) => c.key);
  const shots: Omit<PlannedShot, "key" | "order">[] = [];

  // 1. the master: the space, the action, everyone in it
  shots.push({
    title: `${loc ? short(loc.name) : "Scene"} master`,
    coverage: "master",
    purpose: "Establish the space and play the whole scene wide, so every later cut has a home.",
    beat: ctx.actions[0]?.text || sc.summary || sc.heading,
    characterKeys: everyone,
    locationKey: loc?.key ?? null,
    dialogueKeys: ctx.dialogue.map((d) => d.key),
    actionKeys: ctx.actions.map((a) => a.key),
    shotSize: "wide",
    cameraAngle: "eye_level",
    framing: `Wide on ${loc?.name ?? "the location"}${everyone.length ? ` with ${everyone.map(name).join(" and ")} in frame` : ""}.`,
    emotionalIntention: sc.entering
      ? `Start from ${sc.entering}.`
      : "Let the room set the mood before anyone speaks.",
    continuityNotes: "Sets geography and screen direction for the coverage.",
    sources: [{ startLine: sc.startLine, endLine: sc.endLine }],
    confidence: "high",
    ambiguity: null,
  });

  // 2. dialogue coverage: consecutive lines of one speaker form one beat
  const groups: Array<{ speaker: string | null; keys: string[]; start: number; end: number }> = [];
  for (const d of ctx.dialogue) {
    const last = groups.at(-1);
    if (last && last.speaker === d.characterKey) {
      last.keys.push(d.key);
      last.end = d.endLine;
    } else groups.push({ speaker: d.characterKey, keys: [d.key], start: d.startLine, end: d.endLine });
  }
  const speakers = [...new Set(groups.map((g) => g.speaker).filter((x): x is string => Boolean(x)))];
  const left = speakers[0] ? name(speakers[0]) : null;
  const right = speakers[1] ? name(speakers[1]) : null;
  const direction =
    left && right ? `Keep ${left} screen-left and ${right} screen-right (same side of the line).` : "";
  groups.forEach((g, i) => {
    const listener = everyone.find((k) => k !== g.speaker) ?? null;
    const lineText = ctx.dialogue
      .filter((d) => g.keys.includes(d.key))
      .map((d) => d.text)
      .join(" ");
    const src = [{ startLine: g.start, endLine: g.end }];
    if (speakers.length >= 2 && i === 0 && listener) {
      shots.push({
        title: `${name(g.speaker)} OTS`,
        coverage: "over_the_shoulder",
        purpose: `Open the exchange: ${name(g.speaker)} speaks with ${name(listener)} in the foreground.`,
        beat: lineText,
        characterKeys: [g.speaker!, listener],
        locationKey: loc?.key ?? null,
        dialogueKeys: g.keys,
        actionKeys: [],
        shotSize: "medium",
        cameraAngle: "over_the_shoulder",
        framing: `Over ${name(listener)}'s shoulder onto ${name(g.speaker)}.`,
        emotionalIntention: `${name(g.speaker)} commits to the line; ${name(listener)} is the pressure in the frame.`,
        continuityNotes: direction,
        sources: src,
        confidence: "high",
        ambiguity: null,
      });
    } else {
      shots.push({
        title: `${name(g.speaker)} ${speakers.length >= 2 ? "single" : "medium close"}`,
        coverage: "single",
        purpose: `Cover ${name(g.speaker)}'s line close enough to read the thought behind it.`,
        beat: lineText,
        characterKeys: g.speaker ? [g.speaker] : [],
        locationKey: loc?.key ?? null,
        dialogueKeys: g.keys,
        actionKeys: [],
        shotSize: "medium_close",
        cameraAngle: "eye_level",
        framing: `${name(g.speaker)} in a medium close-up${listener ? `, eyeline to ${name(listener)}` : ""}.`,
        emotionalIntention: "Stay with the face; the line matters more than the room.",
        continuityNotes: direction,
        sources: src,
        confidence: g.speaker ? "high" : "low",
        ambiguity: g.speaker
          ? null
          : `The speaker "${ctx.dialogue.find((d) => d.key === g.keys[0])?.speaker}" is not a known Character.`,
      });
    }
    // the last line lands on whoever has to answer it
    if (i === groups.length - 1 && listener && speakers.length >= 1 && everyone.length >= 2)
      shots.push({
        title: `${name(listener)} reaction`,
        coverage: "reaction",
        purpose: `${name(listener)} absorbs the last line: the scene ends on the answer we do not hear.`,
        beat: `${name(listener)} reacts to ${name(g.speaker)}.`,
        characterKeys: [listener],
        locationKey: loc?.key ?? null,
        dialogueKeys: [],
        actionKeys: [],
        shotSize: "close_up",
        cameraAngle: "eye_level",
        framing: `Close on ${name(listener)}.`,
        emotionalIntention: "Hold a beat longer than comfortable.",
        continuityNotes: direction,
        sources: src,
        confidence: "medium",
        ambiguity: null,
      });
  });
  return {
    summary: `${shots.length} shots: a master, then ${shots.length - 1 ? "coverage chosen for the dialogue" : "nothing more is needed"}.`,
    shots: shots.map((s, i) => ({ ...s, key: `sh${i + 1}`, order: i + 1 })),
  };
}

function regenerate(base: ShotPlan, key: string, note: string): ShotPlan {
  return {
    ...base,
    shots: base.shots.map((s) => {
      if (s.key !== key) return s;
      const i = SHOT_SIZES.indexOf(s.shotSize);
      const tighter = SHOT_SIZES[Math.min(SHOT_SIZES.length - 1, i + 1)]!;
      return {
        ...s,
        shotSize: tighter === s.shotSize ? SHOT_SIZES[i - 1]! : tighter,
        framing: `${s.framing} Alternative${note ? `: ${note}` : ""}.`.slice(0, 600),
      };
    }),
  };
}
