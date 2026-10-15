import { fingerprint } from "../hash";
import { centerCrop, padToFrame, type Rect } from "./crop";
import { parseAspectRatio, type Size } from "./ratio";

/**
 * DeliveryConformPlan: the deterministic post-generation transforms that turn a provider's original output
 * into the production-shaped delivery master. Intent only — pixel parameters are resolved against the
 * ACTUAL probed output (`resolveConform`), because a provider's real size may differ from the planned canvas.
 *
 * Deliberately small: crop, pad (letterbox/pillarbox), trim. No colour, no effects, no timeline editing.
 */
export const CONFORM_OPS = ["crop", "pad", "trim"] as const;
export type ConformOp = (typeof CONFORM_OPS)[number];

export interface DeliveryConformPlan {
  version: 1;
  /** false = the provider original already IS the delivery master. */
  required: boolean;
  /** Production aspect ratio the delivery frame must have (null = unconstrained). */
  targetAspectRatio: string | null;
  /** How the picture reaches the target ratio. */
  framing: "none" | "crop" | "letterbox" | "pillarbox";
  /** Delivery duration; null = keep the generated duration. */
  trimToMs: number | null;
  steps: ConformOp[];
}

export function buildConformPlan(args: {
  targetAspectRatio: string | null;
  framing: DeliveryConformPlan["framing"];
  trimToMs: number | null;
}): DeliveryConformPlan {
  const steps: ConformOp[] = [];
  if (args.framing === "crop") steps.push("crop");
  if (args.framing === "letterbox" || args.framing === "pillarbox") steps.push("pad");
  if (args.trimToMs != null) steps.push("trim");
  return {
    version: 1,
    required: steps.length > 0,
    targetAspectRatio: args.targetAspectRatio,
    framing: args.framing,
    trimToMs: args.trimToMs,
    steps,
  };
}

export interface ProbedGeometry {
  width: number;
  height: number;
  durationMs: number | null;
}

export interface ResolvedConform {
  crop: Rect | null;
  pad: { frame: Size; placement: Rect } | null;
  trimMs: number | null;
  output: Size;
  /** Human sentences for the review UI ("Crop 1280×720 → 1280×536 (2.39:1)"). */
  notes: string[];
  /** Non-fatal: e.g. the provider output was shorter than the requested trim (trim skipped). */
  warnings: string[];
}

/** Resolves the plan against a real probe. Pure and integer-safe. */
export function resolveConform(plan: DeliveryConformPlan, probe: ProbedGeometry): ResolvedConform {
  const size: Size = { width: probe.width, height: probe.height };
  let working = size;
  let crop: Rect | null = null;
  let pad: ResolvedConform["pad"] = null;
  const notes: string[] = [];
  const warnings: string[] = [];
  const target = parseAspectRatio(plan.targetAspectRatio)?.value ?? null;

  if (plan.framing === "crop" && target) {
    const c = centerCrop(size, target);
    if (c.axis !== "none") {
      crop = c.rect;
      working = { width: c.rect.width, height: c.rect.height };
      notes.push(
        `Crop ${probe.width}×${probe.height} → ${working.width}×${working.height} (${plan.targetAspectRatio}), removing ${(c.discardedFraction * 100).toFixed(1)}% of the image`,
      );
    }
  } else if ((plan.framing === "letterbox" || plan.framing === "pillarbox") && target) {
    const p = padToFrame(size, target);
    if (p.mode !== "none") {
      pad = { frame: p.frame, placement: p.placement };
      working = p.frame;
      notes.push(
        `${p.mode === "letterbox" ? "Letterbox" : "Pillarbox"} ${probe.width}×${probe.height} into ${p.frame.width}×${p.frame.height} (${plan.targetAspectRatio})`,
      );
    }
  }

  let trimMs: number | null = null;
  if (plan.trimToMs != null) {
    if (probe.durationMs != null && probe.durationMs + 1 < plan.trimToMs) {
      warnings.push(
        `Provider output is ${(probe.durationMs / 1000).toFixed(2)}s, shorter than the ${(plan.trimToMs / 1000).toFixed(2)}s delivery duration; it was not extended.`,
      );
    } else if (probe.durationMs != null && probe.durationMs <= plan.trimToMs) {
      // already exactly the delivery length: nothing to trim
    } else {
      trimMs = plan.trimToMs;
      notes.push(
        `Trim ${probe.durationMs != null ? `${(probe.durationMs / 1000).toFixed(2)}s` : "output"} → ${(plan.trimToMs / 1000).toFixed(2)}s`,
      );
    }
  }
  return { crop, pad, trimMs, output: working, notes, warnings };
}

/** Bump when the meaning of a conform changes: part of every derived file's identity. */
export const CONFORM_VERSION = 1;

/**
 * Deterministic identity of a derivation: same parent bytes + same operation + same normalized parameters +
 * same processor version ⇒ same key. Used for idempotent, restart-safe processing.
 */
export function derivationKey(args: {
  parentChecksum: string;
  operation: string;
  parameters: Record<string, unknown>;
  processorVersion: string;
}): string {
  return fingerprint({
    p: args.parentChecksum,
    o: args.operation,
    a: args.parameters,
    v: args.processorVersion,
    c: CONFORM_VERSION,
  });
}
