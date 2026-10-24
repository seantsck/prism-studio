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
  /** Default `shot_output`. `animate_production_frame` (2H): motion-first wording and order. */
  opts: { purpose?: GenerationPurpose } = {},
): PromptPlan {
  const animate = opts.purpose === "animate_production_frame";
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
      pkg.performance.flatMap((p) => [
        `${p.speaker}: "${p.text}"`,
        p.emotion && `emotion: ${p.emotion}${p.intensity != null ? ` (${p.intensity}/10)` : ""}`,
        p.objective && `objective: ${p.objective}`,
        p.pace && `pace: ${p.pace}`,
        p.selectedTake
          ? `performed take ${p.selectedTake.takeNumber} (${seconds(p.selectedTake.durationMs)})`
          : "no performed take",
      ]),
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
    bySection.hard_constraints = [ANIMATION_PRESERVE_LINE, ...bySection.hard_constraints];
  }
  const order = animate ? ANIMATION_ORDER : PROMPT_SECTIONS;
  return {
    version: 1,
    sections: order
      .map((key) => ({ key, title: TITLES[key], lines: bySection[key] }))
      .filter((s) => s.lines.length > 0),
  };
}

/** Plain-text rendering used by simple adapters (and the Prompt Inspector's "compiled" fallback). */
export function renderPromptPlan(plan: PromptPlan, opts: { includeNegative?: boolean } = {}): string {
  const include = opts.includeNegative ?? false;
  return plan.sections
    .filter((s) => include || s.key !== "negative_constraints")
    .map((s) => `${s.title}: ${s.lines.join("; ")}`)
    .join("\n");
}
