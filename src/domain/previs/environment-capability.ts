import { SPLAT_USER_DATA, SPLAT_PASSES_BLOCKED_MESSAGE, type SplatCalibration } from "./splat";
import type { PrevisObject, Vec3 } from "./types";

/**
 * Phase 4E: what a Location's Gaussian-splat environment can and cannot be used for, derived from the saved (or
 * working) Set document alone. Nothing here is persisted: every fact comes from the splat scene object (visibility,
 * transform, calibration), so there is no migration and no stored capability that could drift.
 *
 * The rule: **an environment can be viewable without being safe for every production control operation.** A splat
 * renders (baked colour) and can be framed and blocked against; it never produces exact control passes, it is never
 * relit, and its real-world size is only what a human or provider calibration says. 3D stays optional: a Set without
 * a splat, and a Shot without a Set, get no report at all and lose nothing.
 */

/** Typed reasons. Codes are stable identifiers; messages are what the creator reads. */
export const ENVIRONMENT_ISSUE_CODES = [
  "SPLAT_TRANSFORM_NOT_FINITE",
  "SPLAT_SCALE_DEGENERATE",
  "SPLAT_CALIBRATION_STALE",
] as const;
export type EnvironmentIssueCode = (typeof ENVIRONMENT_ISSUE_CODES)[number];

export interface EnvironmentIssue {
  code: EnvironmentIssueCode;
  /** what is wrong and what to do about it */
  message: string;
}

/** The control-pass refusal (M2C, accepted as D6). Its message is unchanged from M2C. */
export const CONTROL_PASS_REFUSAL = {
  code: "SPLAT_CONTROL_PASSES_UNSUPPORTED",
  message: SPLAT_PASSES_BLOCKED_MESSAGE,
} as const;

/**
 * The precision at which a Set's transforms are identified: `sceneFingerprint` rounds every position, rotation and
 * scale to 5 decimals (`document.ts`). A scale that rounds to 0 there is indistinguishable from 0 in the Set's
 * identity, and a calibration is compared at the same precision.
 */
export const SPLAT_TRANSFORM_DECIMALS = 5;
const SCALE = 10 ** SPLAT_TRANSFORM_DECIMALS;
/** Exactly the rounding `sceneFingerprint` applies (`Math.round(v * 1e5) / 1e5`); `+ 0` normalises -0. */
const r5 = (v: number) => Math.round(v * SCALE) / SCALE + 0;

const fmt = (v: number) => String(r5(v));

const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const finiteVec = (v: unknown) =>
  isRec(v) && [v.x, v.y, v.z].every((c) => typeof c === "number" && Number.isFinite(c));

/**
 * The raw engine scene's splat transforms must be finite numbers. `buildPrevisDocument` coerces a missing or
 * non-finite component to 0 (and `JSON.stringify` turns Infinity/NaN into null), so this is checked on the RAW scene
 * before that coercion could silently collapse an environment. Only splat objects (those naming a reconstruction)
 * are checked; other objects keep their existing parsing.
 */
export function splatTransformNotFinite(engineScene: unknown): EnvironmentIssue | null {
  if (!isRec(engineScene) || !Array.isArray(engineScene.scene)) return null;
  for (const raw of engineScene.scene) {
    if (!isRec(raw)) continue;
    const userData = isRec(raw.user_data) ? raw.user_data : {};
    if (typeof userData[SPLAT_USER_DATA.reconstructionId] !== "string") continue;
    const scaleOk = raw.scale === undefined || finiteVec(raw.scale);
    if (!finiteVec(raw.position) || !finiteVec(raw.rotation) || !scaleOk)
      return {
        code: "SPLAT_TRANSFORM_NOT_FINITE",
        message:
          "The Gaussian-splat environment has a position, rotation or scale that is not a finite number. Reset its transform before saving the set.",
      };
  }
  return null;
}

/** A scale component that rounds to 0 collapses the environment while it still counts as visible. */
export function splatScaleDegenerate(scale: Vec3): boolean {
  return [scale.x, scale.y, scale.z].some((c) => !Number.isFinite(c) || r5(Math.abs(c)) === 0);
}

/**
 * A metric calibration is true only while the object's scale is the uniform factor it set ("Apply scale" and the
 * provider-estimate placement both set scale = metresPerSourceUnit on every axis). Scaling the environment afterwards
 * makes "1 source unit = m metres" false.
 */
export function splatCalibrationStale(scale: Vec3, calibration: SplatCalibration | null): boolean {
  if (!calibration || calibration.units !== "metres" || calibration.metresPerSourceUnit === null)
    return false;
  const m = r5(calibration.metresPerSourceUnit);
  return r5(scale.x) !== m || r5(scale.y) !== m || r5(scale.z) !== m;
}

type SplatLike = Pick<PrevisObject, "kind" | "visible" | "scale" | "calibration">;

/** The environment limits a splat object must satisfy before a Set holding it is saved. */
export function splatObjectIssues(o: SplatLike): EnvironmentIssue[] {
  if (o.kind !== "splat") return [];
  const issues: EnvironmentIssue[] = [];
  if (splatScaleDegenerate(o.scale))
    issues.push({
      code: "SPLAT_SCALE_DEGENERATE",
      message:
        "The Gaussian-splat environment has a zero scale on at least one axis, so it would vanish while still counted as visible. Give it a non-zero scale before saving the set.",
    });
  else if (splatCalibrationStale(o.scale, o.calibration))
    issues.push({
      code: "SPLAT_CALIBRATION_STALE",
      message: `The Gaussian-splat environment was scaled after its calibration (1 source unit = ${fmt(o.calibration!.metresPerSourceUnit!)} m), so that real-world scale is no longer true. Apply the scale again, or choose "Scale unknown", before saving the set.`,
    });
  return issues;
}

/**
 * Every environment limit for a Set about to be saved: the raw-scene finiteness check first (it explains a 0 that
 * the parser would otherwise produce), then each splat object's own limits. Empty means the environment may be saved.
 */
export function environmentSaveIssues(
  engineScene: unknown,
  objects: ReadonlyArray<SplatLike>,
): EnvironmentIssue[] {
  const raw = splatTransformNotFinite(engineScene);
  if (raw) return [raw];
  return objects.flatMap(splatObjectIssues);
}

/** The control-pass refusal for a Set, or null when exact passes may be captured (no VISIBLE splat). */
export function controlPassRefusal(objects: ReadonlyArray<Pick<PrevisObject, "kind" | "visible">>) {
  return objects.some((o) => o.kind === "splat" && o.visible) ? CONTROL_PASS_REFUSAL : null;
}

// ───────────────────────── the creator-facing report ─────────────────────────

export type OperationState = "available" | "limited" | "unavailable";
export type EnvironmentOperation = "render" | "framing" | "lighting" | "control_passes" | "save";

export const ENVIRONMENT_OPERATION_LABEL: Record<EnvironmentOperation, string> = {
  render: "Viewing, Master Frames and previs",
  framing: "Camera framing and blocking",
  lighting: "Shot lighting",
  control_passes: "Control passes",
  save: "Saving the set",
};

export interface EnvironmentReport {
  /** the headline a creator reads first */
  status: "needs_attention" | "view_only" | "hidden";
  label: string;
  scale: SplatCalibration["scaleMethod"];
  issues: EnvironmentIssue[];
  operations: Array<{ operation: EnvironmentOperation; state: OperationState; note: string }>;
}

export const ENVIRONMENT_STATUS_LABEL: Record<EnvironmentReport["status"], string> = {
  needs_attention: "Environment needs attention",
  view_only: "View and framing only — no control passes",
  hidden: "Environment hidden",
};

/**
 * What the Set's splat environment supports right now. Null when the Set has no splat: nothing about the image-first
 * path, meshes or Shots without a Set changes.
 */
export function environmentReport(objects: ReadonlyArray<SplatLike>): EnvironmentReport | null {
  const splat = objects.find((o) => o.kind === "splat");
  if (!splat) return null;
  const issues = splatObjectIssues(splat);
  const scale = splat.calibration?.scaleMethod ?? "unknown";
  const status: EnvironmentReport["status"] =
    issues.length > 0 ? "needs_attention" : splat.visible ? "view_only" : "hidden";
  const refusal = controlPassRefusal([splat]);
  const operations: EnvironmentReport["operations"] = [
    {
      operation: "render",
      state: splat.visible ? "available" : "limited",
      note: splat.visible
        ? "Rendered with its own baked colour."
        : "Hidden in the set. Show it to see it in the viewport and renders.",
    },
    {
      operation: "framing",
      state: scale === "manual" ? "available" : "limited",
      note:
        scale === "manual"
          ? `To real-world scale (1 source unit = ${fmt(splat.calibration!.metresPerSourceUnit!)} m, set by hand).`
          : scale === "provider_estimated"
            ? `Scale is a provider estimate (1 source unit ≈ ${fmt(splat.calibration!.metresPerSourceUnit!)} m), not exact.`
            : "Not to real-world scale: figures and lenses are in metres, the splat is in unknown units. Set its scale to fix this.",
    },
    {
      operation: "lighting",
      state: "limited",
      note: "Lights affect meshes and Characters. The splat keeps its baked appearance.",
    },
    {
      operation: "control_passes",
      state: refusal ? "unavailable" : "available",
      note: refusal
        ? refusal.message
        : "Available: the hidden splat is not part of the exact depth, object-id and mask passes.",
    },
    {
      operation: "save",
      state: issues.length > 0 ? "unavailable" : "available",
      note:
        issues.length > 0 ? issues.map((i) => i.message).join(" ") : "The environment is within its limits.",
    },
  ];
  return { status, label: ENVIRONMENT_STATUS_LABEL[status], scale, issues, operations };
}
