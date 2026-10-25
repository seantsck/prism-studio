import type { GenerationPackage } from "../../generation-package";
import type { DurationStrategy, FramingStrategy } from "../../framing/adaptation";
import { ANIMATE_KEYFRAME_DISCLOSURE } from "../animation";
import { evaluateCompatibility, type CompatibilityReport, type InputMode } from "../compatibility";
import type { GenerationModel, GenerationPurpose, ModelAvailability } from "../schemas";
import { estimateCredits, estimateImageCredits, isImageCatalogModel, tierById } from "./catalog";
import type { CatalogModel } from "./types";

/**
 * The per-shot model comparison (pure): for one package and a set of models, say whether each model fits,
 * exactly why, which inputs it would receive, and what it would cost. It reuses the Phase 2A compatibility
 * engine and the Phase 2C adaptation plan, so the matrix can never disagree with what the Generate gate does.
 */
export type FitStatus = "supported" | "adaptation_required" | "unsupported" | "unknown";

export const FIT_LABELS: Record<FitStatus, string> = {
  supported: "Supported",
  adaptation_required: "Adaptation required",
  unsupported: "Unsupported",
  unknown: "Unknown",
};

export type PackagingState =
  "used" | "not_used_mode" | "unsupported" | "omitted_limit" | "adapted" | "supported_not_used";

export const PACKAGING_LABELS: Record<PackagingState, string> = {
  used: "USED",
  not_used_mode: "NOT USED (mode)",
  unsupported: "UNSUPPORTED",
  omitted_limit: "OMITTED (LIMIT)",
  adapted: "ADAPTATION",
  supported_not_used: "SUPPORTED, NOT USED",
};

export interface PackagingRow {
  kind:
    | "start_frame"
    | "end_frame"
    | "reference"
    | "performance_audio"
    | "reference_video"
    | "framing"
    | "duration"
    | "native_audio";
  label: string;
  state: PackagingState;
  detail: string;
}

export interface ModelFitOptions {
  /** User choices; the matrix itself previews with each model's RECOMMENDED strategies when none given. */
  framing?: FramingStrategy | null;
  duration?: DurationStrategy | null;
  /** Preview with recommended adaptations applied (default true: this is a comparison, not a submission). */
  previewAdaptation?: boolean;
  inputMode?: InputMode;
  tierId?: string | null;
  nativeAudio?: boolean;
  protectedNotes?: string[];
  /** `production_frame`: a still-image candidate (default `shot_output`). */
  purpose?: GenerationPurpose;
  /** Still-image quality option (null = the model's explicit Prism default). */
  quality?: string | null;
}

export interface ModelFit {
  provider: string;
  modelId: string;
  displayName: string;
  kind: "mock" | "real";
  status: FitStatus;
  /** Why, in plain language (blockers first, then adaptations, then limitations, then unknowns). */
  blockers: string[];
  adaptations: string[];
  limitations: string[];
  unknowns: string[];
  inputMode: InputMode | null;
  /** The strategies the preview applied (what a candidate-set submission records as the user's choice). */
  adaptationChoice: { framing: FramingStrategy | null; duration: DurationStrategy | null };
  tierId: string | null;
  /** Still-image quality that will be requested (null = the model has no quality option). */
  quality: string | null;
  purpose: GenerationPurpose;
  nativeAudio: boolean;
  packaging: PackagingRow[];
  referencesUsed: { used: number; total: number };
  duration: { text: string; ok: boolean; unverified: boolean };
  framing: { text: string; status: "native" | "adapted" | "needs_choice" | "blocked" };
  audio: { text: string };
  estimate: { amountUsd: number | null; credits: number | null; basis: string; currency: string } | null;
  available: boolean;
  availabilityNote: string;
  compatibility: CompatibilityReport;
}

const seconds = (ms: number) => `${Number((ms / 1000).toFixed(3))} s`;

export function evaluateModelFit(args: {
  pkg: GenerationPackage;
  model: GenerationModel;
  catalog: CatalogModel | null;
  availability: ModelAvailability | null;
  options?: ModelFitOptions;
}): ModelFit {
  const { pkg, model, catalog } = args;
  const o = args.options ?? {};
  const purpose: GenerationPurpose = o.purpose ?? "shot_output";
  const base = evaluateCompatibility(pkg, model, {
    adaptation: { framing: o.framing ?? null, duration: o.duration ?? null },
    inputMode: o.inputMode,
    protectedNotes: o.protectedNotes,
    purpose,
  });

  // Preview adaptation: apply each model's own recommendation so the matrix shows "ADAPTATION REQUIRED + how"
  // instead of a bare "incompatible". The real submission still needs the user's explicit choice.
  const wantPreview = o.previewAdaptation !== false;
  const a = base.adaptation;
  const framingChoice =
    o.framing ??
    (wantPreview && a?.framing.status === "needs_choice" && a.framing.recommended !== "blocked"
      ? a.framing.recommended
      : null);
  const durationChoice =
    o.duration ??
    (wantPreview && a?.duration.status === "needs_choice" && a.duration.recommended !== "blocked"
      ? a.duration.recommended
      : null);
  const report =
    framingChoice !== (o.framing ?? null) || durationChoice !== (o.duration ?? null)
      ? evaluateCompatibility(pkg, model, {
          adaptation: { framing: framingChoice, duration: durationChoice },
          inputMode: o.inputMode,
          protectedNotes: o.protectedNotes,
          purpose,
        })
      : base;

  const plan = report.adaptation;
  const adaptations: string[] = [];
  if (plan?.framing.status === "adapted") {
    adaptations.push(
      `Framing: ${plan.framing.productionLabel ?? "production"} → provider ${plan.framing.providerLabel} (${plan.framing.strategy.replace(/_/g, " ")})`,
    );
  }
  if (plan?.duration.status === "adapted") {
    adaptations.push(
      `Duration: generate ${seconds(plan.duration.providerMs ?? 0)}, trim to ${seconds(plan.duration.trimToMs ?? plan.duration.productionMs ?? 0)}`,
    );
  }
  const unresolvedAdaptation =
    plan != null && (plan.framing.status === "needs_choice" || plan.duration.status === "needs_choice");

  const blockers = report.errors.map((e) => e.message);
  const limitations = report.ignoredFeatures
    .filter((f) => f.feature !== "adaptation")
    .map((f) => `${f.label}: ${f.impact}`);

  // unknowns: catalog statements the sources do not make, restricted to what THIS shot needs
  const unknowns: string[] = [];
  if (catalog) {
    if (!catalog.duration.verified)
      unknowns.push(`Duration bounds are not documented (${catalog.duration.note})`);
    if (pkg.performance.some((p) => p.selectedTake?.audioAssetId)) {
      if (catalog.audio.referenceConditioning === "unknown")
        unknowns.push("Whether performed audio can be used as input is not documented");
    }
    if (report.used.references.length > 0 && catalog.inputs.referenceImages === "unknown")
      unknowns.push("Reference image support is not documented");
    if (catalog.availability === "deprecated") unknowns.push("The model is deprecated");
  }

  const available = (args.availability?.available ?? true) && catalog?.availability !== "unavailable";
  const hardBlock = blockers.length > 0 && !unresolvedAdaptation;
  const status: FitStatus = hardBlock
    ? "unsupported"
    : unresolvedAdaptation
      ? "adaptation_required"
      : adaptations.length > 0
        ? "adaptation_required"
        : unknowns.length > 0
          ? "unknown"
          : "supported";

  // ── packaging rows: what the model will receive, input by input ──
  const caps = model.capabilities;
  const maxRefs = caps.references.maxReferences;
  const packaging: PackagingRow[] = [];
  const modeExclusive = report.ignoredFeatures.some((f) => f.id === "references.mode_exclusive");
  let referencesTotal = 0;
  let referencesUsed = 0;
  for (const i of report.inputs) {
    if (i.kind === "start_frame" || i.kind === "end_frame") {
      const supported = i.kind === "start_frame" ? caps.references.startFrame : caps.references.endFrame;
      const asReference = report.used.references.some((r) => r.assetId === i.assetId);
      packaging.push({
        kind: i.kind,
        label: i.label,
        state: i.used ? (asReference ? "adapted" : "used") : supported ? "supported_not_used" : "unsupported",
        detail: i.used
          ? asReference
            ? "Supplied as a reference image (reference mode), not as the exact frame."
            : purpose === "animate_production_frame" && i.kind === "start_frame"
              ? "Exact first frame: the selected Production Frame (image-to-video)."
              : "Conditions the generation."
          : supported
            ? "The model supports it but this evaluation does not use it."
            : "This model has no such input; it will not influence the result.",
      });
    } else if (i.kind === "reference") {
      referencesTotal += 1;
      if (i.used) referencesUsed += 1;
      let state: PackagingState = "used";
      let detail = "Sent as a reference image.";
      if (!i.used) {
        if (modeExclusive) {
          state = "not_used_mode";
          detail =
            purpose === "animate_production_frame"
              ? ANIMATE_KEYFRAME_DISCLOSURE
              : "Keyframe mode: this model cannot combine first/last frames with references. Switch to reference mode to use it.";
        } else if (i.role === "location_view") {
          state = "unsupported";
          detail =
            "Location View image not supplied to this model; its viewpoint is described in the prompt only.";
        } else if (!caps.references.referenceImages) {
          state = "unsupported";
          detail = "This model takes no reference images.";
        } else if (i.role === "identity" || i.role === "character_look") {
          state = caps.references.characterReferences ? "omitted_limit" : "unsupported";
          detail = "Character references are not accepted for this role.";
        } else {
          state = "unsupported";
          detail = `Not accepted for role ${i.role ?? "reference"}.`;
        }
      }
      packaging.push({ kind: "reference", label: i.label, state, detail });
    } else if (i.kind === "audio") {
      packaging.push({
        kind: "performance_audio",
        label: i.label,
        state: i.used ? "used" : "unsupported",
        detail: i.used
          ? "Supplied as a reference input; the performed take stays production truth."
          : caps.audio.nativeDialogueAudio
            ? "Not used as input. The model can generate its own speech, which would NOT be the performed take."
            : "Not used as input; lip sync and timing are handled in post.",
      });
    } else if (i.kind === "reference_video") {
      packaging.push({
        kind: "reference_video",
        label: i.label,
        state: i.used ? "used" : "unsupported",
        detail: i.used ? "Sent as a motion reference." : "This model takes no reference video.",
      });
    }
  }
  if (referencesTotal > maxRefs && caps.references.referenceImages) {
    // the engine blocks "too many"; mark the overflow explicitly instead of silently
    let seen = 0;
    for (const row of packaging) {
      if (row.kind !== "reference") continue;
      seen += 1;
      if (seen > maxRefs) {
        row.state = "omitted_limit";
        row.detail = `Over the model's limit of ${maxRefs} reference images (generation is blocked until reduced).`;
      }
    }
  }
  if (plan) {
    packaging.push({
      kind: "framing",
      label: "Framing",
      state:
        plan.framing.status === "adapted"
          ? "adapted"
          : plan.framing.status === "native"
            ? "used"
            : "unsupported",
      detail:
        plan.framing.status === "adapted"
          ? `Production ${plan.framing.productionLabel} → provider ${plan.framing.providerLabel} (${plan.framing.strategy.replace(/_/g, " ")}); the protected frame stays canonical.`
          : plan.framing.status === "native"
            ? "Native ratio."
            : "Needs a framing choice.",
    });
    packaging.push({
      kind: "duration",
      label: "Duration",
      state:
        plan.duration.status === "adapted"
          ? "adapted"
          : plan.duration.status === "native"
            ? "used"
            : "unsupported",
      detail: plan.duration.reason,
    });
  }
  if (catalog && catalog.audio.nativeGeneration === "supported") {
    packaging.push({
      kind: "native_audio",
      label: "Provider-generated audio",
      state: o.nativeAudio ? "adapted" : "supported_not_used",
      detail: o.nativeAudio
        ? "ON: the provider generates its own sound/speech (priced higher). It does not replace the performed take."
        : "Available but OFF: Prism's selected performance stays production truth.",
    });
  }

  // ── estimate ──
  const nativeAudio = Boolean(o.nativeAudio) && catalog?.audio.nativeGeneration === "supported";
  const durationMs = report.used.durationMs;
  const tier = catalog ? tierById(catalog, o.tierId ?? null) : null;
  let estimate: ModelFit["estimate"] = null;
  const quality = catalog?.image ? (o.quality ?? catalog.image.defaultQuality) : null;
  if (catalog && tier && isImageCatalogModel(catalog)) {
    // a still has no duration: one image, priced by quality/canvas tier and the references it carries
    const r = estimateImageCredits(catalog, {
      tierId: tier.id,
      quality,
      referenceImages: report.used.references.length,
      outputCount: 1,
    });
    estimate = { amountUsd: r.amountUsd, credits: r.credits, basis: r.basis, currency: "USD" };
  } else if (durationMs != null) {
    if (catalog && tier) {
      const r = estimateCredits(catalog, {
        seconds: durationMs / 1000,
        tierId: tier.id,
        nativeAudio,
        referenceImages: report.used.references.length,
        referenceVideoSeconds: 0,
        startFrame: Boolean(report.used.startFrameAssetId),
        endFrame: Boolean(report.used.endFrameAssetId),
      });
      estimate = { amountUsd: r.amountUsd, credits: r.credits, basis: r.basis, currency: "USD" };
    } else {
      const unit = caps.commercial.unitCost;
      estimate = {
        amountUsd: unit != null ? Math.round(unit * (durationMs / 1000) * 10_000) / 10_000 : null,
        credits: null,
        basis: unit != null ? `${unit} ${caps.commercial.currency}/${caps.commercial.costUnit}` : "unknown",
        currency: caps.commercial.currency,
      };
    }
  }

  const durationText = report.duration
    ? `${seconds(report.duration.productionMs)} · ${report.duration.ok ? "supported" : `supports ${report.duration.supported}`}`
    : "n/a";
  const nativeSupport = caps.audio.nativeDialogueAudio || caps.audio.soundGeneration;
  const audioText =
    purpose === "production_frame"
      ? "No audio (still image)"
      : report.inputs.some((i) => i.kind === "audio")
        ? report.used.audioAssetIds.length > 0
          ? "Performance supplied as reference"
          : nativeSupport
            ? "Performance not used (model generates its own audio)"
            : "Performance not used"
        : nativeSupport
          ? "Native audio available"
          : "No audio input";

  return {
    provider: model.provider,
    modelId: model.modelId,
    displayName: model.displayName,
    kind: model.kind,
    status,
    blockers,
    adaptations,
    limitations,
    unknowns,
    inputMode: report.inputMode,
    adaptationChoice: { framing: framingChoice, duration: durationChoice },
    tierId: tier?.id ?? null,
    quality,
    purpose,
    nativeAudio,
    packaging,
    referencesUsed: { used: referencesUsed, total: referencesTotal },
    duration: {
      text: durationText,
      ok: report.duration?.ok ?? true,
      unverified: catalog ? !catalog.duration.verified : false,
    },
    framing: {
      text:
        plan?.framing.status === "adapted"
          ? `${plan.framing.productionLabel} → ${plan.framing.providerLabel} (${plan.framing.strategy.replace(/_/g, " ")})`
          : plan?.framing.status === "needs_choice"
            ? "needs a framing choice"
            : "native",
      status: plan?.framing.status ?? "native",
    },
    audio: { text: audioText },
    estimate,
    available,
    availabilityNote: args.availability && !args.availability.available ? "Not available on this server" : "",
    compatibility: report,
  };
}
