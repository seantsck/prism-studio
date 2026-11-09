import { label, SHOT_SIZES } from "@/domain/story/shot-list";
import type { DirectionContext, ShotDirection, Side } from "@/domain/story/shot-direction";

/**
 * Phase 5B-S5: the FREE test director behind "Prism AI (test, free)". Deterministic, no network. It keeps the Shot's
 * Characters and Location, honours the selected Location View, keeps every Character on the side the coverage has
 * already established (or establishes one: first Character screen-left, a lone Character screen-right, looking into
 * the frame), and reads a creator note for the usual variants (more intimate / distant / isolated, tense, romantic,
 * symmetrical, handheld, restrained, "make X dominant").
 */
type Size = (typeof SHOT_SIZES)[number];
const LENS: Record<Size, [string, string]> = {
  extreme_wide: ["18–24mm", "wide environmental"],
  wide: ["24–28mm", "wide environmental"],
  full: ["35mm", "natural wide"],
  medium_wide: ["35mm", "natural wide"],
  medium: ["50mm", "neutral, eye-like"],
  medium_close: ["85mm", "intimate compression"],
  close_up: ["85mm", "intimate compression"],
  extreme_close_up: ["100mm", "detail compression"],
};

function sizeOf(raw: string): Size {
  const k = raw.toLowerCase().replace(/[\s-]+/g, "_");
  if ((SHOT_SIZES as readonly string[]).includes(k)) return k as Size;
  if (/^mcu$|medium_close/.test(k)) return "medium_close";
  if (/^cu$|close/.test(k)) return "close_up";
  if (/^ws$|wide/.test(k)) return "wide";
  if (/^ms$|medium/.test(k)) return "medium";
  return "medium";
}
const step = (s: Size, d: number): Size =>
  SHOT_SIZES[Math.max(0, Math.min(SHOT_SIZES.length - 1, SHOT_SIZES.indexOf(s) + d))]!;
const opposite = (s: Side): Side => (s === "left" ? "right" : s === "right" ? "left" : "centre");

export function fakeDirection(ctx: DirectionContext, instruction: string): ShotDirection {
  const note = instruction.toLowerCase();
  const chars = ctx.characters;
  const loc = ctx.location?.name ?? "the location";
  const view = ctx.locationView;

  // size: what S4 planned, adjusted by the note
  let size = sizeOf(ctx.shot.shotSize || ctx.shot.framing);
  if (/intimate|closer|tighter/.test(note)) size = step(size, 1);
  if (/distant|wider|isolat/.test(note)) size = step(size, -1);
  const [focal, intent] = LENS[size];

  // sides: established first, then a stable convention
  const sides = new Map<string, Side>();
  chars.forEach((c, i) => {
    const est = ctx.established[c.name];
    sides.set(c.key, est ?? (chars.length === 1 ? "right" : i === 0 ? "left" : "right"));
  });
  if (/symmetr/.test(note) && chars.length === 1) sides.set(chars[0]!.key, "centre");
  const dominant = chars.find((c) =>
    new RegExp(`${c.name}[^.]*dominant|dominant[^.]*${c.name}`, "i").test(instruction),
  );
  const ots = /over the shoulder|over-the-shoulder|ots/i.test(`${ctx.shot.title} ${ctx.shot.planNotes}`);
  const nameOf = (k: string) => chars.find((c) => c.key === k)!.name;
  const partner = (k: string) => chars.find((c) => c.key !== k);
  const isolated =
    /isolat|alone/.test(note) || (chars.length === 1 && /alone|hushed|isolat/i.test(ctx.shot.storyBeat));

  const blocking = chars.map((c, i) => {
    const side = sides.get(c.key)!;
    const other = partner(c.key);
    const otherSide = other ? sides.get(other.key)! : opposite(side);
    const fg = (ots && i === chars.length - 1 && chars.length > 1) || dominant?.key === c.key;
    const looks = other
      ? `screen-${otherSide === "centre" ? opposite(side) : otherSide}, toward ${other.name}`
      : `screen-${opposite(side)}, into the open frame`;
    return {
      characterKey: c.key,
      position: `${c.name} ${fg ? "in the foreground" : "in the midground"}, frame ${side}${c.look ? `, in the ${c.look} Look` : ""}`,
      screenSide: side,
      depth: fg ? ("foreground" as const) : ("midground" as const),
      facing: other
        ? `toward ${other.name}`
        : isolated
          ? "three-quarter away from camera"
          : "three-quarter to camera",
      eyeline: `looks ${looks}`,
      relation: other
        ? `${c.name} holds screen-${side}; ${other.name} screen-${otherSide}`
        : isolated
          ? "alone in the space"
          : "no one else in frame",
      entryExit: "none (already in place)",
    };
  });

  const angle = dominant
    ? ("low" as const)
    : view && /high/i.test(view.cameraAngle)
      ? ("high" as const)
      : ("eye_level" as const);
  const height = dominant
    ? ("low" as const)
    : /low/i.test(view?.cameraHeight ?? "")
      ? ("low" as const)
      : ("eye_level" as const);
  const movement = /handheld/.test(note)
    ? ("handheld" as const)
    : /restrain/.test(note)
      ? ("static" as const)
      : ("static" as const);
  const tense = /tens|suspens/.test(note);
  const romantic = /romantic|warm/.test(note);
  const composition = /symmetr/.test(note)
    ? "Symmetrical frame, the subject on the centre line"
    : isolated
      ? `Wide negative space around ${chars.map((c) => c.name).join(" and ") || "the space"}; rule of thirds`
      : "Rule of thirds, the eyeline into the open side of the frame";
  const sideLine = blocking.map((b) => `${nameOf(b.characterKey)} screen-${b.screenSide}`).join(", ");
  const lightKey = (ctx.location?.lighting || "a motivated soft key from the nearest practical").replace(
    /[.\s]+$/,
    "",
  );
  const description = [
    `${label(size)[0]!.toUpperCase()}${label(size).slice(1)} at ${ctx.aspectRatio}${view ? `, from the ${view.name} view` : ""} in ${loc}.`,
    ...blocking.map((b) => `${b.position.replace(/^./, (x) => x.toUpperCase())}, ${b.facing}.`),
    `${romantic ? "Warm" : tense ? "Hard-edged" : "Soft"} light: ${lightKey}${isolated ? "; the room falls away around her" : ""}.`,
  ].join(" ");

  return {
    summary: `${label(size)} on ${focal} (${intent})${movement === "handheld" ? ", handheld" : ", static"}; ${sideLine || "no Characters"}.`,
    framing: {
      shotSize: size,
      composition,
      subjectPlacement: sideLine
        ? `${sideLine}${isolated ? ", small in the frame" : ""}`
        : "the space itself",
      headroom:
        size === "close_up" || size === "extreme_close_up"
          ? "Tight headroom"
          : "Natural headroom, room above for the space",
    },
    lens: {
      intent,
      focalRange: focal,
      rationale: `${intent[0]!.toUpperCase()}${intent.slice(1)} suits a ${label(size)}.`,
    },
    camera: {
      height,
      angle,
      position:
        view?.cameraPosition ||
        (chars.length ? `Facing ${chars.map((c) => c.name).join(" and ")} across ${loc}` : `Across ${loc}`),
      perspective: view
        ? `Consistent with the ${view.name} view (${view.orientation || view.viewpoint})`
        : "Neutral perspective",
      movement,
      movementRationale:
        movement === "handheld"
          ? "Handheld, as asked: unease without cutting."
          : "Static: the stillness carries the beat.",
    },
    blocking,
    lighting: {
      key: lightKey,
      practicals: /lobby|restaurant|hallway/i.test(loc)
        ? "Warm practical sconces and fixtures in frame"
        : "Practicals as they exist in the location",
      contrast: tense ? "Hard, high contrast" : "Soft, low contrast",
      mood: romantic
        ? "Warm, close"
        : tense
          ? "Tense, uneasy"
          : isolated
            ? "Hushed, lonely"
            : "Quiet, attentive",
      timeOfDay: ctx.scene.timeOfDay || "unspecified",
      motivatedSources: `${lightKey}; ${ctx.scene.intExt === "EXT" ? "street light" : "city light through the glass"}`,
    },
    depth: {
      foreground:
        blocking
          .filter((b) => b.depth === "foreground")
          .map((b) => nameOf(b.characterKey))
          .join(", ") || "clear",
      midground:
        blocking
          .filter((b) => b.depth === "midground")
          .map((b) => nameOf(b.characterKey))
          .join(", ") || "the space",
      background: `${loc}${ctx.location?.geography ? ` (${ctx.location.geography.slice(0, 80)})` : ""}`,
      cues: "Overlapping planes and practicals receding into the background",
    },
    emotionalIntent: isolated
      ? "The space dwarfs her: the stillness says what she will not."
      : dominant
        ? `${dominant.name} owns the frame; the other has to look up.`
        : "Keep the audience with the face and the line; nothing distracts from the beat.",
    continuity: {
      screenDirection: sideLine
        ? `${sideLine}; same side of the line as the adjacent shots`
        : "No screen direction to keep",
      eyelines: blocking.map((b) => `${nameOf(b.characterKey)} ${b.eyeline}`).join("; "),
      constraints: [
        ...chars.filter((c) => c.look).map((c) => `${c.name} in the ${c.look} Look`),
        ...chars.filter((c) => c.continuityLock).map((c) => `${c.name}: Continuity Lock ${c.continuityLock}`),
        ...ctx.adjacent.map((a) => `Cuts with ${a.code} (${a.title})`),
      ].slice(0, 10),
      breaksPattern: false,
      breakJustification: null,
    },
    locationView: {
      usesSelectedView: Boolean(view),
      conflict: null,
      suggestedNewView: view
        ? null
        : ctx.otherViews[0]
          ? `Use the existing "${ctx.otherViews[0].name}" view`
          : `Suggested new Location View: ${loc}, ${chars.length ? `facing ${chars.map((c) => c.name).join(" and ")}` : "establishing"}, ${label(size)}`,
    },
    storyboardDescription: description,
    confidence: "high",
    ambiguity: null,
  };
}
