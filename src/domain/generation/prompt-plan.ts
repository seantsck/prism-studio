import { describeLockFacts, IDENTITY_SLOT_LABEL } from "../character-continuity";
import type { GenerationPackage } from "../generation-package";
import { describeLocationView } from "../location-view";
import { PROMPT_SECTIONS, type GenerationPurpose, type PromptPlan, type PromptSectionKey } from "./schemas";

const TITLES: Record<PromptSectionKey, string> = {
  subject: "Subject",
  identity: "Identity",
  wardrobe: "Wardrobe",
  environment: "Environment",
  composition: "Composition",
  camera: "Camera",
  action: "Action",
  timing: "Timing",
  performance: "Performance",
  lighting: "Lighting",
  continuity: "Continuity",
  hard_constraints: "Hard constraints",
  negative_constraints: "Negative constraints",
  provider_adaptation: "Provider adaptation",
};

const clean = (xs: Array<string | null | undefined | false>): string[] =>
  xs.map((x) => (x ? String(x).trim() : "")).filter(Boolean);

const seconds = (ms: number) => `${(ms / 1000).toFixed(2).replace(/\.?0+$/, "")}s`;

/** Phase 2H: the lines that make an animation start from, and keep, what its first frame already establishes. */
export const ANIMATION_BEGIN_LINE = "Begin exactly from the supplied Production Frame.";
export const ANIMATION_PRESERVE_LINE =
  "Preserve the subjects, wardrobe, set, composition and lighting established by the first frame.";
const ANIMATION_COMPOSITION_LINE = "As established by the first frame; do not recompose.";
/**
 * Phase 5B-V1: the motion layer of an animation. The Production Frame already shows what the Shot LOOKS like; these
 * lines say what may CHANGE after it (restrained, motivated motion), what "static" means for a video (a locked camera,
 * not a frozen picture), how the approved emotional intent becomes subtle performance, and what must be protected.
 */
export const ANIMATION_MOTION_LINE =
  "Animate only what changes after the first frame: restrained, motivated by the story beat; add no new action.";
export const ANIMATION_STATIC_CAMERA_LINE =
  "Camera static (locked off). The picture is not frozen: allow breathing, blinking, slight hair and fabric movement, practical light flicker and subtle environmental motion.";
export const ANIMATION_CONTINUITY_LINE =
  "Protect each Character's identity, face, wardrobe and hairstyle, the Location, the composition, important props and the established screen direction exactly as in the first frame.";
export const ANIMATION_MOTION_GUARD =
  "The creator's motion direction changes only how the Shot moves: never the Characters, their Looks, the Location, the story event or the composition.";
const PERFORMANCE_FROM_INTENT =
  "show it through subtle actor motion (a breath, a small eye movement), not broad gestures";

/**
 * Motion-first reading order for `animate_production_frame`: the first frame already shows what the Shot LOOKS like, so
 * movement, performance, camera and timing lead, and appearance follows as what must be preserved. Same sections, same
 * schema (PromptPlan v1): only their order and three purpose lines differ.
 */
const ANIMATION_ORDER: readonly PromptSectionKey[] = [
  "subject",
  "camera",
  "action",
  "performance",
  "timing",
  "continuity",
  "hard_constraints",
  "composition",
  "identity",
  "wardrobe",
  "environment",
  "lighting",
  "negative_constraints",
  "provider_adaptation",
];

/**
 * Phase 5B-I6: the reading order for a Production Frame STILL. Semantic content first (who, wearing what, where, doing
 * what, feeling what), then cinematography (composition, camera, lighting), then continuity and constraints. A still
 * has no duration, so the timing section is never included.
 */
const PRODUCTION_FRAME_ORDER: readonly PromptSectionKey[] = [
  "subject",
  "identity",
  "wardrobe",
  "environment",
  "action",
  "performance",
  "composition",
  "camera",
  "lighting",
  "continuity",
  "hard_constraints",
  "negative_constraints",
  "provider_adaptation",
];

/**
 * Phase 5B-I6: a small creative override from the creator, recorded on the attempt. `alternate_composition` varies
 * ONLY framing, lens, camera position and composition. Neither kind may change identity, wardrobe, the Location or
 * continuity: a protecting line always leads the hard constraints.
 */
export interface CreatorDirection {
  /** `motion` (5B-V1): an animation alternative's motion note ("Less movement. Yumeko only glances toward Sean."). */
  kind: "additional" | "alternate_composition" | "motion";
  text: string;
}
export const MAX_CREATOR_DIRECTION = 500;
export const CREATOR_DIRECTION_GUARD =
  "Keep every Character's identity and wardrobe, the Location and continuity exactly as referenced; the creator direction never changes them.";
export const ALTERNATE_COMPOSITION_LINE =
  "Alternate composition: vary the framing, lens, camera position and composition; keep the same Characters, Looks and Location.";

/**
 * Normalises the package into sectioned production intent. This is NOT a prompt string: each adapter
 * decides how to render sections for its model (one paragraph, tagged fields, multiple inputs...).
 * Pure and deterministic: the same package always yields the same plan.
 */
export function buildPromptPlan(
  pkg: GenerationPackage,
  /**
   * Provider-canvas guidance from the adaptation plan. Rendered as its OWN section so the production camera /
   * composition lines are never rewritten and the Prompt Inspector can show the two separately.
   */
  adaptation?: { provider: string[] } | null,
  /**
   * Default `shot_output`. `animate_production_frame` (2H): motion-first wording and order. `production_frame` (5B-I6):
   * still-image order, no timing, and the optional creator direction.
   */
  opts: { purpose?: GenerationPurpose; direction?: CreatorDirection | null } = {},
): PromptPlan {
  const animate = opts.purpose === "animate_production_frame";
  const still = opts.purpose === "production_frame";
  const names = pkg.characters.map((c) => c.name);
  const cam = pkg.camera;
  // v5: a locked assignment is described from its Continuity Lock's frozen facts (never the live library)
  const lockOf = (characterId: string) =>
    pkg.references.characterContinuity?.find((l) => l.characterId === characterId);
  const blk = pkg.blocking;

  const bySection: Record<PromptSectionKey, string[]> = {
    subject: clean([
      `${pkg.shot.code} — ${pkg.shot.title}`,
      pkg.storyIntent.storyBeat,
      pkg.storyIntent.dramaticPurpose && `Purpose: ${pkg.storyIntent.dramaticPurpose}`,
      names.length ? `Characters in frame: ${names.join(", ")}` : "No named characters in frame",
    ]),
    identity: clean(
      pkg.characters.flatMap((c) => {
        const lock = lockOf(c.characterId);
        if (!lock)
          return [
            c.physicalDescription
              ? `${c.name}: ${c.physicalDescription}`
              : `${c.name}: see identity references`,
            // 5B-I6: a still is matched to the designated canonical identity image, which is sent first
            still && c.canonicalIdentityAssetId && `${c.name}: match the canonical identity reference image`,
          ];
        const slots = lock.references
          .filter((r) => r.role === "identity")
          .map((r) => (r.identitySlot ? IDENTITY_SLOT_LABEL[r.identitySlot] : "reference"));
        // role context travels with the images: the model is told whose identity each image shows
        return [
          `${c.name} — Character Continuity Lock "${lock.name}"`,
          lock.facts.physicalDescription && `${c.name} physical identity: ${lock.facts.physicalDescription}`,
          slots.length > 0
            ? `${c.name} identity reference images: ${slots.join(", ")}`
            : `${c.name}: no identity reference images in the Lock (described in words only)`,
          ...lock.facts.continuityRules.map((r) => r.trim() && `${c.name} rule: ${r.trim()}`),
        ];
      }),
    ),
    wardrobe: clean(
      pkg.characters.flatMap((c) => {
        const lock = lockOf(c.characterId);
        if (lock)
          return lock.facts.look
            ? [
                `${c.name} — Look "${lock.facts.look.name}" (Character Continuity Lock "${lock.name}")`,
                ...describeLockFacts({ ...lock.facts, physicalDescription: "", continuityRules: [] }),
              ]
            : [`${c.name}: no Look (Character Continuity Lock "${lock.name}")`];
        return c.look
          ? [
              `${c.name} — Look "${c.look.name}"${c.look.locked ? " (locked)" : ""}`,
              c.look.wardrobe && `wardrobe: ${c.look.wardrobe}`,
              c.look.shoes && `shoes: ${c.look.shoes}`,
              c.look.hair && `hair: ${c.look.hair}`,
              c.look.makeup && `makeup: ${c.look.makeup}`,
              c.look.jewelry && `jewelry: ${c.look.jewelry}`,
              c.look.accessories && `accessories: ${c.look.accessories}`,
            ]
          : [`${c.name}: no Look assigned`];
      }),
    ),
    environment: clean([
      pkg.set &&
        `${pkg.set.name}${pkg.set.zone ? ` — ${pkg.set.zone}` : ""}${pkg.set.locked ? " (locked set)" : ""}`,
      pkg.set?.description,
      pkg.set?.geography && `geography: ${pkg.set.geography}`,
      // v4: the Shot's chosen canonical viewpoint, in words (its image, when the model takes one, is the evidence)
      ...(pkg.references.locationView ? describeLocationView(pkg.references.locationView) : []),
      still &&
        pkg.set?.visualReferences?.some((r) => r.kind === "canonical") &&
        `${pkg.set.name}: match the canonical Location reference image`,
      pkg.continuity.weather && `weather: ${pkg.continuity.weather}`,
      pkg.continuity.timeOfDay && `time of day: ${pkg.continuity.timeOfDay}`,
      pkg.props.length ? `props: ${pkg.props.map((p) => p.name).join(", ")}` : "",
      blk.backgroundActivity && `background: ${blk.backgroundActivity}`,
    ]),
    composition: clean([
      `${cam.shotSize} ${cam.framing}`.trim(),
      cam.aspectRatio && `aspect ratio ${cam.aspectRatio}`,
      blk.subjectBlocking,
      blk.facingDirection && `facing: ${blk.facingDirection}`,
      blk.eyelines && `eyelines: ${blk.eyelines}`,
      blk.screenDirection && `screen direction: ${blk.screenDirection}`,
      cam.notes,
    ]),
    camera: clean([
      cam.cameraPosition && `position: ${cam.cameraPosition}`,
      cam.cameraHeight && `height: ${cam.cameraHeight}`,
      cam.cameraAngle && `angle: ${cam.cameraAngle}`,
      cam.lens && `lens: ${cam.lens}`,
      cam.aperture && `aperture: ${cam.aperture}`,
      cam.movement && `movement: ${cam.movement}${cam.movementSpeed ? ` (${cam.movementSpeed})` : ""}`,
    ]),
    action: clean([
      pkg.timing.beginningPose && `begins: ${pkg.timing.beginningPose}`,
      ...pkg.timing.beats.map((b) => `${seconds(b.atMs)}: ${b.description}`),
      pkg.timing.endingPose && `ends: ${pkg.timing.endingPose}`,
      ...pkg.characters.flatMap((c) =>
        clean([
          c.expression && `${c.name} expression: ${c.expression}`,
          c.posture && `${c.name} posture: ${c.posture}`,
          c.gestures && `${c.name} gestures: ${c.gestures}`,
          c.physicalInteractions && `${c.name} interaction: ${c.physicalInteractions}`,
        ]),
      ),
    ]),
    timing: clean([
      `duration ${seconds(pkg.timing.durationMs)} (${pkg.timing.source})`,
      ...pkg.timing.segments.map((s) => `${seconds(s.startMs)}–${seconds(s.endMs)}: ${s.label}`),
    ]),
    performance: clean(
      pkg.performance.flatMap((p) =>
        still
          ? // a still shows the moment: the line being spoken and its emotion, never pace or a take's duration
            [
              `${p.speaker}: "${p.text}"`,
              p.emotion && `emotion: ${p.emotion}${p.intensity != null ? ` (${p.intensity}/10)` : ""}`,
            ]
          : [
              `${p.speaker}: "${p.text}"`,
              p.emotion && `emotion: ${p.emotion}${p.intensity != null ? ` (${p.intensity}/10)` : ""}`,
              p.objective && `objective: ${p.objective}`,
              p.pace && `pace: ${p.pace}`,
              p.selectedTake
                ? `performed take ${p.selectedTake.takeNumber} (${seconds(p.selectedTake.durationMs)})`
                : "no performed take",
            ],
      ),
    ),
    lighting: clean([
      pkg.lighting.mood && `mood: ${pkg.lighting.mood}`,
      pkg.lighting.keyDirection && `key: ${pkg.lighting.keyDirection}`,
      pkg.lighting.fill && `fill: ${pkg.lighting.fill}`,
      pkg.lighting.practicals && `practicals: ${pkg.lighting.practicals}`,
      pkg.lighting.colorTemperature && `colour temperature: ${pkg.lighting.colorTemperature}`,
      pkg.set?.lighting && `set lighting: ${pkg.set.lighting}`,
    ]),
    continuity: clean([
      pkg.continuity.previousShot &&
        `follows ${pkg.continuity.previousShot.code} — ${pkg.continuity.previousShot.title}`,
      pkg.continuity.wardrobe && `wardrobe: ${pkg.continuity.wardrobe}`,
      pkg.continuity.hair && `hair: ${pkg.continuity.hair}`,
      pkg.continuity.makeup && `makeup: ${pkg.continuity.makeup}`,
      pkg.continuity.jewelry && `jewelry: ${pkg.continuity.jewelry}`,
      pkg.continuity.props && `props: ${pkg.continuity.props}`,
      pkg.continuity.geography && `geography: ${pkg.continuity.geography}`,
      pkg.continuity.vehicleInPlay &&
        `vehicle orientation: ${pkg.continuity.vehicleOrientation || "keep consistent"}`,
      pkg.continuity.characterCount != null && `visible character count: ${pkg.continuity.characterCount}`,
      ...pkg.continuity.projectRules,
      pkg.continuity.sceneNotes,
    ]),
    hard_constraints: clean([
      ...pkg.constraints.hard,
      ...pkg.constraints.guardrails,
      pkg.constraints.generatorNotes,
    ]),
    negative_constraints: clean(pkg.constraints.negative),
    provider_adaptation: clean(adaptation?.provider ?? []),
  };

  if (animate) {
    const pf = pkg.references.productionFrame;
    bySection.subject = [
      pf ? `${ANIMATION_BEGIN_LINE.slice(0, -1)} (v${pf.version}).` : ANIMATION_BEGIN_LINE,
      ...bySection.subject,
    ];
    bySection.composition = [ANIMATION_COMPOSITION_LINE, ...bySection.composition];
    // 5B-V1: motion first, a static camera that is not a frozen picture, performance from the approved intent
    bySection.action = [ANIMATION_MOTION_LINE, ...bySection.action];
    if (!cam.movement.trim() || /^(static|locked)/i.test(cam.movement.trim()))
      bySection.camera = [...bySection.camera, ANIMATION_STATIC_CAMERA_LINE];
    const intent = cam.notes.match(/^Emotional intent: (.+)$/m)?.[1]?.trim();
    if (intent)
      bySection.performance = [
        ...bySection.performance,
        `emotional intent: ${intent} — ${PERFORMANCE_FROM_INTENT}`,
      ];
    if (pkg.lighting.mood) bySection.performance = [...bySection.performance, `mood: ${pkg.lighting.mood}`];
    bySection.hard_constraints = [
      ANIMATION_PRESERVE_LINE,
      ANIMATION_CONTINUITY_LINE,
      ...bySection.hard_constraints,
    ];
  }
  // 5B-V1: an animation alternative's motion direction (never a protected line; the preserve lines stay first)
  const motion = animate ? normalizeDirection(opts.direction) : null;
  if (motion?.text) {
    bySection.action = [...bySection.action, `Creator motion direction: ${motion.text}`];
    bySection.hard_constraints = [
      ...bySection.hard_constraints.slice(0, 2),
      ANIMATION_MOTION_GUARD,
      ...bySection.hard_constraints.slice(2),
    ];
  }
  // Phase 5B-I6: the creator's direction (Production Frame stills only); it never replaces a protected line
  const direction = still ? normalizeDirection(opts.direction) : null;
  if (direction) {
    if (direction.kind === "alternate_composition") {
      bySection.composition = [
        direction.text
          ? `${ALTERNATE_COMPOSITION_LINE} Direction: ${direction.text}`
          : ALTERNATE_COMPOSITION_LINE,
        ...bySection.composition.map((l) => `planned: ${l}`),
      ];
      bySection.camera = bySection.camera.map((l) => `planned ${l}`);
    } else if (direction.text) {
      bySection.composition = [...bySection.composition, `Creator direction: ${direction.text}`];
    }
    bySection.hard_constraints = [CREATOR_DIRECTION_GUARD, ...bySection.hard_constraints];
  }
  const order = animate ? ANIMATION_ORDER : still ? PRODUCTION_FRAME_ORDER : PROMPT_SECTIONS;
  return {
    version: 1,
    sections: order
      .map((key) => ({ key, title: TITLES[key], lines: bySection[key] }))
      .filter((s) => s.lines.length > 0),
  };
}

/** Phase 5B-I6: a trimmed, bounded direction; an empty "additional" direction is no direction at all. */
export function normalizeDirection(d: CreatorDirection | null | undefined): CreatorDirection | null {
  if (!d) return null;
  const text = d.text.replace(/\s+/g, " ").trim().slice(0, MAX_CREATOR_DIRECTION);
  if (d.kind === "additional" && !text) return null;
  return { kind: d.kind, text };
}

/** Plain-text rendering used by simple adapters (and the Prompt Inspector's "compiled" fallback). */
export function renderPromptPlan(plan: PromptPlan, opts: { includeNegative?: boolean } = {}): string {
  const include = opts.includeNegative ?? false;
  return plan.sections
    .filter((s) => include || s.key !== "negative_constraints")
    .map((s) => `${s.title}: ${s.lines.join("; ")}`)
    .join("\n");
}
