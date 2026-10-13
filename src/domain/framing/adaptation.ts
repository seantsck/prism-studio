import { z } from "zod";
import { fingerprint } from "../hash";
import { buildConformPlan, type DeliveryConformPlan } from "./conform";
import {
  MAX_REASONABLE_DISCARD,
  centerCrop,
  normalizeRect,
  padToFrame,
  type CropAxis,
  type Rect,
} from "./crop";
import { formatRatio, nominalCanvas, parseAspectRatio, sameRatio, type Size } from "./ratio";

/**
 * GenerationAdaptationPlan — the explicit, frozen record of every compromise needed to execute a
 * production GenerationPackage on a particular provider/model.
 *
 *   PRODUCTION INTENT → ADAPTATION PLAN → PROVIDER CANVAS → PROVIDER OUTPUT → DELIVERY CONFORM → QA → APPROVAL
 *
 * It is NOT the GenerationPackage: the package says what the film is; the plan says what execution gives up
 * or changes to get there. Prism may RECOMMEND a strategy; it never selects one that changes composition on
 * the user's behalf, and non-native adaptation must be acknowledged before any generation.
 *
 * Pure: no React, no Node, no provider SDK, no secrets.
 */

export const FRAMING_STRATEGIES = [
  "native",
  "crop_to_production",
  "fit_with_letterbox",
  "fit_with_pillarbox",
  "overscan_for_crop",
  "blocked",
] as const;
export type FramingStrategy = (typeof FRAMING_STRATEGIES)[number];

export const FRAMING_LABELS: Record<FramingStrategy, string> = {
  native: "Native (provider supports the production ratio)",
  crop_to_production: "Crop to production frame after generation",
  fit_with_letterbox: "Fit with letterbox (bars top/bottom)",
  fit_with_pillarbox: "Fit with pillarbox (bars left/right)",
  overscan_for_crop: "Overscan, then crop to production frame",
  blocked: "Blocked",
};

export const DURATION_STRATEGIES = [
  "native",
  "generate_longer_then_trim",
  "generate_shorter_and_extend",
  "blocked",
] as const;
export type DurationStrategy = (typeof DURATION_STRATEGIES)[number];

export const DURATION_LABELS: Record<DurationStrategy, string> = {
  native: "Native (provider supports the production duration)",
  generate_longer_then_trim: "Generate longer, trim to production duration",
  generate_shorter_and_extend: "Generate shorter and extend (not available yet)",
  blocked: "Blocked",
};

export type AdaptationStatus = "native" | "adapted" | "needs_choice" | "blocked";

export interface DurationLimits {
  minMs: number;
  maxMs: number;
  stepMs: number | null;
  allowedMs: number[] | null;
}

export interface AdaptationInput {
  /** Video modalities have a duration; still-image modalities only have framing. */
  video: boolean;
  production: { aspectRatio: string | null; durationMs: number | null; fps: number | null };
  provider: {
    provider: string;
    modelId: string;
    aspectRatios: string[];
    /** Resolution the package asked for (may have a different ratio than the provider canvas). */
    requestedResolution: Size | null;
    maxResolution: Size | null;
    duration: DurationLimits | null;
  };
  choice?: { framing?: FramingStrategy | null; duration?: DurationStrategy | null };
  /** Manual production notes: what must survive the final frame ("Yumeko's eyes inside the crop"). */
  protectedNotes?: string[];
}

export interface AdaptationAcknowledgement {
  id: string;
  label: string;
  impact: string;
}

export interface FramingOption {
  strategy: FramingStrategy;
  usable: boolean;
  providerLabel: string | null;
  reason: string;
}

export interface FramingPlan {
  strategy: FramingStrategy;
  status: AdaptationStatus;
  productionRatio: number | null;
  productionLabel: string | null;
  providerRatio: number | null;
  providerLabel: string | null;
  /** Provider canvas used for planning; the conform step re-resolves against the real output. */
  providerCanvas: Size | null;
  canvasSource: "requested" | "nominal" | null;
  /** Surviving region of the provider canvas, 0..1 fractions (crop strategies). */
  retained: Rect | null;
  axis: CropAxis;
  /** 0..1 share of the generated picture that does not survive into the delivery frame. */
  discardedFraction: number;
  /** Letterbox/pillarbox geometry at planning scale. */
  pad: { mode: "letterbox" | "pillarbox"; frame: Size; placement: Rect; barFraction: number } | null;
  /** Action-safe / title-safe guides inside the retained region (0..1 of the provider canvas). */
  safeArea: { action: Rect; title: Rect } | null;
  protectedNotes: string[];
  recommended: FramingStrategy | null;
  options: FramingOption[];
}

export interface DurationPlan {
  strategy: DurationStrategy;
  status: AdaptationStatus;
  productionMs: number | null;
  providerMs: number | null;
  trimToMs: number | null;
  recommended: DurationStrategy | null;
  reason: string;
}

export interface GenerationAdaptationPlan {
  planVersion: 1;
  status: AdaptationStatus;
  production: { aspectRatio: string | null; durationMs: number | null; fps: number | null };
  provider: { provider: string; modelId: string };
  framing: FramingPlan;
  duration: DurationPlan;
  /** Provider-side prompt guidance, kept SEPARATE from the production camera instruction. */
  promptAdaptation: { production: string[]; provider: string[] };
  acknowledgements: AdaptationAcknowledgement[];
  warnings: string[];
  blockedReasons: string[];
  conform: DeliveryConformPlan;
  /** Content hash of everything above (stable; independent of when the plan was built). */
  fingerprint: string;
}

const secs = (ms: number) => `${Number((ms / 1000).toFixed(3))}s`;
const pct = (f: number) => `${(f * 100).toFixed(1)}%`;
const even = (n: number) => Math.max(2, 2 * Math.round(n / 2));

// ───────────────────────── duration ─────────────────────────

function supportsDuration(d: DurationLimits, ms: number): boolean {
  if (d.allowedMs?.length) return d.allowedMs.includes(ms);
  if (ms < d.minMs || ms > d.maxMs) return false;
  return d.stepMs ? (ms - d.minMs) % d.stepMs === 0 : true;
}

/** Smallest supported duration that is ≥ `ms` (null when the model cannot reach it). */
export function nextSupportedDuration(d: DurationLimits, ms: number): number | null {
  if (d.allowedMs?.length) {
    return [...d.allowedMs].sort((a, b) => a - b).find((v) => v >= ms) ?? null;
  }
  if (ms > d.maxMs) return null;
  if (ms <= d.minMs) return d.minMs;
  if (!d.stepMs) return ms;
  const steps = Math.ceil((ms - d.minMs) / d.stepMs);
  const v = d.minMs + steps * d.stepMs;
  return v <= d.maxMs ? v : null;
}

export function planDuration(input: AdaptationInput): DurationPlan {
  const productionMs = input.production.durationMs;
  const limits = input.provider.duration;
  if (!input.video || !productionMs || !limits) {
    return {
      strategy: "native",
      status: "native",
      productionMs,
      providerMs: productionMs,
      trimToMs: null,
      recommended: null,
      reason: "No duration adaptation applies.",
    };
  }
  if (supportsDuration(limits, productionMs)) {
    return {
      strategy: "native",
      status: "native",
      productionMs,
      providerMs: productionMs,
      trimToMs: null,
      recommended: null,
      reason: `Provider supports ${secs(productionMs)} natively.`,
    };
  }
  const longer = nextSupportedDuration(limits, productionMs);
  const recommended: DurationStrategy = longer != null ? "generate_longer_then_trim" : "blocked";
  const blocked = (status: AdaptationStatus, reason: string): DurationPlan => ({
    strategy: "blocked",
    status,
    productionMs,
    providerMs: null,
    trimToMs: null,
    recommended,
    reason,
  });
  const chosen = input.choice?.duration ?? null;
  if (!chosen || chosen === "native") {
    return blocked(
      "needs_choice",
      longer != null
        ? `Production duration ${secs(productionMs)} is not offered; the provider can generate ${secs(longer)} and Prism can trim to ${secs(productionMs)}. Choose a strategy; Prism will not round the shot silently.`
        : `Production duration ${secs(productionMs)} is outside what the provider can generate.`,
    );
  }
  if (chosen === "generate_longer_then_trim") {
    if (longer == null) {
      return blocked("blocked", `The provider cannot generate a clip of at least ${secs(productionMs)}.`);
    }
    return {
      strategy: "generate_longer_then_trim",
      status: "adapted",
      productionMs,
      providerMs: longer,
      trimToMs: productionMs,
      recommended,
      reason: `Generate ${secs(longer)}, then trim the delivery to ${secs(productionMs)} (production timing is unchanged).`,
    };
  }
  if (chosen === "generate_shorter_and_extend") {
    return blocked(
      "blocked",
      "Extending a shorter generation is not available yet (no optical-flow/extension step).",
    );
  }
  return blocked("blocked", "Duration adaptation blocked.");
}

// ───────────────────────── framing ─────────────────────────

/** Share of the picture that survives a crop between two ratios (1 = nothing lost). */
export function retainedShare(provider: number, production: number): number {
  return provider >= production ? production / provider : provider / production;
}

function inset(r: Rect, f: number): Rect {
  const round = (n: number) => Number(n.toFixed(5));
  return {
    x: round(r.x + r.width * f),
    y: round(r.y + r.height * f),
    width: round(r.width * (1 - 2 * f)),
    height: round(r.height * (1 - 2 * f)),
  };
}

interface RatioEntry {
  label: string;
  value: number;
}

interface FramingChoice {
  strategy: FramingStrategy;
  providerLabel: string;
  providerRatio: number;
}

/** The provider ratio each strategy would use, or null with a reason when the strategy cannot apply. */
function frameFor(
  strategy: FramingStrategy,
  prod: number,
  ratios: RatioEntry[],
): { choice: FramingChoice | null; reason: string } {
  const pick = (r: RatioEntry) => ({
    choice: { strategy, providerLabel: r.label, providerRatio: r.value },
    reason: "",
  });
  const native = ratios.find((r) => sameRatio(r.value, prod));
  if (strategy === "native") {
    return native
      ? pick(native)
      : { choice: null, reason: "The provider does not offer the production ratio." };
  }
  if (native) {
    return { choice: null, reason: `The provider offers ${native.label} natively; no adaptation is needed.` };
  }
  if (strategy === "crop_to_production" || strategy === "overscan_for_crop") {
    const viable = ratios
      .map((r) => ({ ...r, keep: retainedShare(r.value, prod) }))
      .filter((r) => 1 - r.keep <= MAX_REASONABLE_DISCARD)
      .sort((a, b) => b.keep - a.keep);
    return viable[0]
      ? pick(viable[0])
      : {
          choice: null,
          reason: `Every provider ratio would discard more than ${pct(MAX_REASONABLE_DISCARD)} of the picture.`,
        };
  }
  if (strategy === "fit_with_letterbox") {
    const wider = ratios.filter((r) => r.value > prod).sort((a, b) => a.value - b.value)[0];
    return wider
      ? pick(wider)
      : {
          choice: null,
          reason: "No provider ratio is wider than the production frame, so letterboxing cannot fit it.",
        };
  }
  if (strategy === "fit_with_pillarbox") {
    const narrower = ratios.filter((r) => r.value < prod).sort((a, b) => b.value - a.value)[0];
    return narrower
      ? pick(narrower)
      : {
          choice: null,
          reason: "No provider ratio is narrower than the production frame, so pillarboxing cannot fit it.",
        };
  }
  return { choice: null, reason: "Blocked." };
}

export function planFraming(input: AdaptationInput): FramingPlan {
  const prod = parseAspectRatio(input.production.aspectRatio);
  const ratios: RatioEntry[] = input.provider.aspectRatios.flatMap((label) => {
    const p = parseAspectRatio(label);
    return p ? [{ label, value: p.value }] : [];
  });
  const protectedNotes = (input.protectedNotes ?? []).map((n) => n.trim()).filter(Boolean);
  const empty: FramingPlan = {
    strategy: "native",
    status: "native",
    productionRatio: prod?.value ?? null,
    productionLabel: prod ? formatRatio(prod.value, input.production.aspectRatio) : null,
    providerRatio: prod?.value ?? null,
    providerLabel: input.production.aspectRatio || null,
    providerCanvas: null,
    canvasSource: null,
    retained: null,
    axis: "none",
    discardedFraction: 0,
    pad: null,
    safeArea: null,
    protectedNotes,
    recommended: null,
    options: [],
  };

  // Nothing to adapt: no production ratio, or the provider does not constrain ratio.
  if (!prod || ratios.length === 0) return empty;

  const nativeFrame = frameFor("native", prod.value, ratios);
  if (nativeFrame.choice) {
    return {
      ...empty,
      providerRatio: nativeFrame.choice.providerRatio,
      providerLabel: nativeFrame.choice.providerLabel,
    };
  }

  const options: FramingOption[] = (
    ["crop_to_production", "overscan_for_crop", "fit_with_letterbox", "fit_with_pillarbox"] as const
  ).map((strategy) => {
    const f = frameFor(strategy, prod.value, ratios);
    return {
      strategy,
      usable: f.choice !== null,
      providerLabel: f.choice?.providerLabel ?? null,
      reason: f.choice ? `Provider canvas ${f.choice.providerLabel}` : f.reason,
    };
  });
  const recommended: FramingStrategy = options.find((o) => o.strategy === "overscan_for_crop" && o.usable)
    ? "overscan_for_crop"
    : (options.find((o) => o.usable)?.strategy ?? "blocked");
  const base: FramingPlan = {
    ...empty,
    strategy: "blocked",
    status: "needs_choice",
    providerRatio: null,
    providerLabel: null,
    recommended,
    options,
  };

  const wanted = input.choice?.framing ?? null;
  if (!wanted || wanted === "native") return base;
  if (wanted === "blocked") return { ...base, status: "blocked" };
  const f = frameFor(wanted, prod.value, ratios);
  if (!f.choice) {
    return {
      ...base,
      status: "blocked",
      options: options.map((o) => (o.strategy === wanted ? { ...o, reason: f.reason } : o)),
    };
  }

  // Provider canvas: the requested resolution only when its ratio matches the chosen provider ratio.
  const req = input.provider.requestedResolution;
  let canvas: Size;
  let canvasSource: "requested" | "nominal" = "nominal";
  if (req && sameRatio(req.width / req.height, f.choice.providerRatio)) {
    canvas = req;
    canvasSource = "requested";
  } else if (req) {
    // keep the requested width, re-derive the height for the provider ratio, clamp to the model maximum
    let w = req.width;
    let h = even(w / f.choice.providerRatio);
    const max = input.provider.maxResolution;
    if (max && (w > max.width || h > max.height)) {
      const k = Math.min(max.width / w, max.height / h);
      w = even(w * k);
      h = even(h * k);
    }
    canvas = { width: even(w), height: h };
  } else {
    canvas = nominalCanvas(f.choice.providerRatio);
  }

  const plan: FramingPlan = {
    ...base,
    strategy: wanted,
    status: "adapted",
    providerRatio: f.choice.providerRatio,
    providerLabel: f.choice.providerLabel,
    providerCanvas: canvas,
    canvasSource,
  };
  if (wanted === "crop_to_production" || wanted === "overscan_for_crop") {
    const c = centerCrop(canvas, prod.value);
    const retained = normalizeRect(c.rect, canvas);
    return {
      ...plan,
      retained,
      axis: c.axis,
      discardedFraction: c.discardedFraction,
      safeArea: { action: inset(retained, 0.035), title: inset(retained, 0.05) },
    };
  }
  const p = padToFrame(canvas, prod.value);
  return {
    ...plan,
    pad:
      p.mode === "none"
        ? null
        : { mode: p.mode, frame: p.frame, placement: p.placement, barFraction: p.barFraction },
  };
}

// ───────────────────────── whole plan ─────────────────────────

function framingAck(f: FramingPlan): AdaptationAcknowledgement | null {
  if (f.status !== "adapted") return null;
  const from = f.productionLabel ?? "production ratio";
  const to = f.providerLabel ?? "provider ratio";
  if (f.strategy === "crop_to_production" || f.strategy === "overscan_for_crop") {
    return {
      id: "adaptation.framing",
      label: `Production frame ${from} will be generated on a ${to} canvas and cropped`,
      impact: `Prism generates a ${to} picture and crops it to ${from}, discarding about ${pct(f.discardedFraction)} of the generated image (${f.axis === "vertical" ? "top and bottom" : "left and right"}). Anything composed in the discarded region will not appear in the film.`,
    };
  }
  const letter = f.strategy === "fit_with_letterbox";
  return {
    id: "adaptation.framing",
    label: `Production frame ${from} will be ${letter ? "letterboxed" : "pillarboxed"} around a ${to} picture`,
    impact: `The whole ${to} picture is kept and padded with ${letter ? "horizontal" : "vertical"} bars (${pct(f.pad?.barFraction ?? 0)} of the frame is black).`,
  };
}

export function buildAdaptationPlan(input: AdaptationInput): GenerationAdaptationPlan {
  const framing = planFraming(input);
  const duration = planDuration(input);
  const acknowledgements: AdaptationAcknowledgement[] = [];
  const warnings: string[] = [];
  const blockedReasons: string[] = [];

  const fa = framingAck(framing);
  if (fa) acknowledgements.push(fa);
  if (duration.status === "adapted") {
    acknowledgements.push({
      id: "adaptation.duration",
      label: `Production duration ${secs(duration.productionMs!)} will be generated as ${secs(duration.providerMs!)} and trimmed`,
      impact: `The provider generates ${secs(duration.providerMs!)}; the delivery master is trimmed to the production duration of ${secs(duration.productionMs!)}. The last ${secs(duration.providerMs! - duration.productionMs!)} of the generation is discarded.`,
    });
  }

  if (framing.status === "needs_choice") {
    blockedReasons.push(
      `Production frame ${framing.productionLabel} is not offered by this model. Choose how to adapt it (recommended: ${framing.recommended ?? "none"}).`,
    );
  } else if (framing.status === "blocked") {
    blockedReasons.push(`Framing adaptation is blocked for ${framing.productionLabel}.`);
  }
  if (duration.status === "needs_choice" || duration.status === "blocked")
    blockedReasons.push(duration.reason);

  if (
    framing.status === "adapted" &&
    (framing.strategy === "crop_to_production" || framing.strategy === "overscan_for_crop") &&
    framing.protectedNotes.length === 0
  ) {
    warnings.push(
      "No protected composition notes are recorded for this shot; add them so you can check what must stay inside the crop.",
    );
  }
  if (framing.discardedFraction > 0.4) {
    warnings.push(`Large crop: ${pct(framing.discardedFraction)} of the generated image is discarded.`);
  }

  const promptProduction: string[] = [];
  const promptProvider: string[] = [];
  if (framing.status === "adapted" && framing.productionLabel) {
    promptProduction.push(`Production frame is ${framing.productionLabel}.`);
    if (framing.strategy === "overscan_for_crop") {
      const horizontal = framing.axis === "horizontal";
      promptProvider.push(
        `compose primary subjects within a centered ${framing.productionLabel} protected region; preserve additional ${horizontal ? "horizontal" : "vertical"} visual information ${horizontal ? "left and right" : "above and below"} for crop flexibility`,
      );
      for (const note of framing.protectedNotes)
        promptProvider.push(`keep inside the protected region: ${note}`);
    }
  }

  const statuses = [framing.status, duration.status];
  const status: AdaptationStatus = statuses.includes("blocked")
    ? "blocked"
    : statuses.includes("needs_choice")
      ? "needs_choice"
      : statuses.includes("adapted")
        ? "adapted"
        : "native";

  const conform = buildConformPlan({
    targetAspectRatio: input.production.aspectRatio,
    framing:
      framing.status !== "adapted"
        ? "none"
        : framing.strategy === "fit_with_letterbox"
          ? "letterbox"
          : framing.strategy === "fit_with_pillarbox"
            ? "pillarbox"
            : "crop",
    trimToMs: duration.status === "adapted" ? duration.trimToMs : null,
  });

  const body = {
    planVersion: 1 as const,
    status,
    production: input.production,
    provider: { provider: input.provider.provider, modelId: input.provider.modelId },
    framing,
    duration,
    promptAdaptation: { production: promptProduction, provider: promptProvider },
    acknowledgements,
    warnings,
    blockedReasons,
    conform,
  };
  return { ...body, fingerprint: fingerprint(body) };
}

// ───────────────────────── persistence shape ─────────────────────────

const rect = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });
const size = z.object({ width: z.number(), height: z.number() });
const statusEnum = z.enum(["native", "adapted", "needs_choice", "blocked"]);

/** Typed parse of a stored plan. Older attempts never recorded one: callers treat null as "none recorded". */
export const adaptationPlanSchema = z.object({
  planVersion: z.literal(1),
  status: statusEnum,
  production: z.object({
    aspectRatio: z.string().nullable(),
    durationMs: z.number().nullable(),
    fps: z.number().nullable(),
  }),
  provider: z.object({ provider: z.string(), modelId: z.string() }),
  framing: z.object({
    strategy: z.enum(FRAMING_STRATEGIES),
    status: statusEnum,
    productionRatio: z.number().nullable(),
    productionLabel: z.string().nullable(),
    providerRatio: z.number().nullable(),
    providerLabel: z.string().nullable(),
    providerCanvas: size.nullable(),
    canvasSource: z.enum(["requested", "nominal"]).nullable(),
    retained: rect.nullable(),
    axis: z.enum(["none", "vertical", "horizontal"]),
    discardedFraction: z.number(),
    pad: z
      .object({
        mode: z.enum(["letterbox", "pillarbox"]),
        frame: size,
        placement: rect,
        barFraction: z.number(),
      })
      .nullable(),
    safeArea: z.object({ action: rect, title: rect }).nullable(),
    protectedNotes: z.array(z.string()),
    recommended: z.enum(FRAMING_STRATEGIES).nullable(),
    options: z.array(
      z.object({
        strategy: z.enum(FRAMING_STRATEGIES),
        usable: z.boolean(),
        providerLabel: z.string().nullable(),
        reason: z.string(),
      }),
    ),
  }),
  duration: z.object({
    strategy: z.enum(DURATION_STRATEGIES),
    status: statusEnum,
    productionMs: z.number().nullable(),
    providerMs: z.number().nullable(),
    trimToMs: z.number().nullable(),
    recommended: z.enum(DURATION_STRATEGIES).nullable(),
    reason: z.string(),
  }),
  promptAdaptation: z.object({ production: z.array(z.string()), provider: z.array(z.string()) }),
  acknowledgements: z.array(z.object({ id: z.string(), label: z.string(), impact: z.string() })),
  warnings: z.array(z.string()),
  blockedReasons: z.array(z.string()),
  conform: z.object({
    version: z.literal(1),
    required: z.boolean(),
    targetAspectRatio: z.string().nullable(),
    framing: z.enum(["none", "crop", "letterbox", "pillarbox"]),
    trimToMs: z.number().nullable(),
    steps: z.array(z.enum(["crop", "pad", "trim"])),
  }),
  fingerprint: z.string(),
});

export function parseAdaptationPlan(raw: unknown): GenerationAdaptationPlan | null {
  const r = adaptationPlanSchema.safeParse(raw);
  return r.success ? (r.data as GenerationAdaptationPlan) : null;
}
