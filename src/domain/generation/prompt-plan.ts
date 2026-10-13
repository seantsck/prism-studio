import type { GenerationPackage } from "../generation-package";
import { PROMPT_SECTIONS, type PromptPlan, type PromptSectionKey } from "./schemas";

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
};

const clean = (xs: Array<string | null | undefined | false>): string[] =>
  xs.map((x) => (x ? String(x).trim() : "")).filter(Boolean);

const seconds = (ms: number) => `${(ms / 1000).toFixed(2).replace(/\.?0+$/, "")}s`;

/**
 * Normalises the package into sectioned production intent. This is NOT a prompt string: each adapter
 * decides how to render sections for its model (one paragraph, tagged fields, multiple inputs...).
 * Pure and deterministic: the same package always yields the same plan.
 */
export function buildPromptPlan(pkg: GenerationPackage): PromptPlan {
  const names = pkg.characters.map((c) => c.name);
  const cam = pkg.camera;
  const blk = pkg.blocking;

  const bySection: Record<PromptSectionKey, string[]> = {
    subject: clean([
      `${pkg.shot.code} — ${pkg.shot.title}`,
      pkg.storyIntent.storyBeat,
      pkg.storyIntent.dramaticPurpose && `Purpose: ${pkg.storyIntent.dramaticPurpose}`,
      names.length ? `Characters in frame: ${names.join(", ")}` : "No named characters in frame",
    ]),
    identity: clean(
      pkg.characters.map((c) =>
        c.physicalDescription ? `${c.name}: ${c.physicalDescription}` : `${c.name}: see identity references`,
      ),
    ),
    wardrobe: clean(
      pkg.characters.flatMap((c) =>
        c.look
          ? [
              `${c.name} — Look "${c.look.name}"${c.look.locked ? " (locked)" : ""}`,
              c.look.wardrobe && `wardrobe: ${c.look.wardrobe}`,
              c.look.shoes && `shoes: ${c.look.shoes}`,
              c.look.hair && `hair: ${c.look.hair}`,
              c.look.makeup && `makeup: ${c.look.makeup}`,
              c.look.jewelry && `jewelry: ${c.look.jewelry}`,
              c.look.accessories && `accessories: ${c.look.accessories}`,
            ]
          : [`${c.name}: no Look assigned`],
      ),
    ),
    environment: clean([
      pkg.set &&
        `${pkg.set.name}${pkg.set.zone ? ` — ${pkg.set.zone}` : ""}${pkg.set.locked ? " (locked set)" : ""}`,
      pkg.set?.description,
      pkg.set?.geography && `geography: ${pkg.set.geography}`,
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
  };

  return {
    version: 1,
    sections: PROMPT_SECTIONS.map((key) => ({ key, title: TITLES[key], lines: bySection[key] })).filter(
      (s) => s.lines.length > 0,
    ),
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
