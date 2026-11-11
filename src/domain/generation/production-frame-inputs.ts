import type { GenerationPackage } from "../generation-package";
import {
  deriveProductionFrameReferenceCandidates,
  essentialOverflowMessage,
  evaluateCompatibility,
  productionFrameReferenceTiers,
  type ReferenceTier,
} from "./compatibility";
import { buildPromptPlan, renderPromptPlan, type CreatorDirection } from "./prompt-plan";
import type { GenerationModel, ReferenceRole } from "./schemas";

/**
 * Phase 5B-I6: the Production Frame INPUTS, in words a filmmaker reads before pressing Generate Production Frame.
 *
 * Pure and derived ONLY from the frozen GenerationPackage (the same package every Production Frame candidate freezes),
 * so the preview can never disagree with what is sent: the reference list IS `deriveProductionFrameReferenceCandidates`,
 * the tiers ARE `productionFrameReferenceTiers`, the prompt IS `buildPromptPlan(…, { purpose: "production_frame" })`.
 * No new generation system: this is a reading of the existing one.
 */
export interface ProductionFrameReference {
  assetId: string;
  label: string;
  role: ReferenceRole;
  tier: ReferenceTier;
}

export interface ProductionFrameInputs {
  /** Guidance ticks for the happy path ("Inputs ready"); never a gate (the generation gate stays authoritative). */
  ready: { characters: boolean; location: boolean; direction: boolean; story: boolean };
  story: string[];
  characters: Array<{ characterId: string; name: string; lines: string[] }>;
  location: string[];
  direction: string[];
  continuity: string[];
  /** Every reference Prism would send, in priority order, with its tier. */
  references: ProductionFrameReference[];
  essentialCount: number;
}

const clean = (xs: Array<string | null | undefined | false>) =>
  xs.map((x) => (x ? String(x).trim() : "")).filter(Boolean);

/** A blocking mark's x (0..1) as a screen position, when the Shot has one for the Character. */
function screenPosition(x: number): string {
  return x < 0.34 ? "screen left" : x > 0.66 ? "screen right" : "centre";
}

export function productionFrameInputs(pkg: GenerationPackage): ProductionFrameInputs {
  const tiers = productionFrameReferenceTiers(pkg);
  const references: ProductionFrameReference[] = deriveProductionFrameReferenceCandidates(pkg).map((c) => ({
    assetId: c.assetId,
    label: c.label,
    role: c.role,
    tier: tiers.get(c.assetId) ?? "optional",
  }));
  const sent = new Set(references.map((r) => r.assetId));
  const lockOf = (id: string) => pkg.references.characterContinuity?.find((l) => l.characterId === id);
  const marks = pkg.blocking.marks ?? [];

  const characters = pkg.characters.map((c) => {
    const lock = lockOf(c.characterId);
    const canonical = !lock && c.canonicalIdentityAssetId && sent.has(c.canonicalIdentityAssetId);
    const identityImages = lock
      ? lock.references.filter((r) => r.role === "identity" && sent.has(r.assetId)).length
      : c.identityReferenceAssetIds.filter((id) => sent.has(id)).length;
    const lookName = lock ? lock.facts.look?.name : c.look?.name;
    const lookImages = lock
      ? lock.references.filter((r) => r.role === "look" && sent.has(r.assetId)).length
      : (c.look?.referenceAssetIds ?? []).filter((id) => sent.has(id)).length;
    const mark = marks.find((m) => m.label.trim().toLowerCase() === c.name.trim().toLowerCase());
    return {
      characterId: c.characterId,
      name: c.name,
      lines: clean([
        lock
          ? `${c.name} — Continuity Lock "${lock.name}"`
          : canonical
            ? `${c.name} — Canonical Identity`
            : identityImages > 0
              ? `${c.name} — Identity reference`
              : `${c.name} — no identity image (described in words only)`,
        lookName
          ? `${c.name} — ${lookName} Look${lookImages === 0 ? " (described in words only)" : ""}`
          : `${c.name} — no Look`,
        mark && `${c.name} — ${screenPosition(mark.x)}${mark.notes ? `, ${mark.notes}` : ""}`,
      ]),
    };
  });

  const set = pkg.set;
  const view = pkg.references.locationView;
  const location = set
    ? clean([
        view ? `${set.name} — ${view.name}` : `${set.name} — no Location View selected`,
        ...(set.visualReferences ?? []).map((r) =>
          r.kind === "canonical"
            ? `${set.name} — Canonical`
            : r.label.replace(`${set.name} `, `${set.name} — `),
        ),
        pkg.continuity.timeOfDay && `Time of day: ${pkg.continuity.timeOfDay}`,
        pkg.continuity.weather && `Weather: ${pkg.continuity.weather}`,
        set.zone && `Zone: ${set.zone}`,
      ])
    : ["No Location"];

  const cam = pkg.camera;
  const direction = clean([
    [cam.shotSize || cam.framing, cam.lens, pkg.lighting.mood].filter(Boolean).join(" · "),
    cam.cameraAngle && `Angle: ${cam.cameraAngle}`,
    pkg.blocking.subjectBlocking,
    cam.movement && `Movement: ${cam.movement}`,
  ]);
  const story = clean([
    `${pkg.shot.code} — ${pkg.shot.title}`,
    pkg.storyIntent.storyBeat,
    pkg.storyIntent.scene.slugline &&
      `Scene ${pkg.storyIntent.scene.number}: ${pkg.storyIntent.scene.slugline}`,
    pkg.storyIntent.dramaticPurpose,
  ]);
  const continuity = clean([
    pkg.continuity.wardrobe && `Wardrobe: ${pkg.continuity.wardrobe}`,
    pkg.continuity.hair && `Hair: ${pkg.continuity.hair}`,
    pkg.continuity.makeup && `Makeup: ${pkg.continuity.makeup}`,
    pkg.continuity.props && `Props: ${pkg.continuity.props}`,
    pkg.continuity.previousShot && `Follows ${pkg.continuity.previousShot.code}`,
  ]);
  return {
    ready: {
      characters: characters.every((c) => !c.lines[0]!.includes("no identity image")),
      location: !set || !!view || (set.visualReferences ?? []).length > 0 || set.referenceAssetIds.length > 0,
      direction: !!(cam.shotSize || cam.framing),
      story: !!pkg.storyIntent.storyBeat,
    },
    story,
    characters,
    location,
    direction,
    continuity,
    references,
    essentialCount: references.filter((r) => r.tier === "essential").length,
  };
}

export interface ProductionFrameModelFit {
  provider: string;
  modelId: string;
  label: string;
  maxReferences: number;
  /** What this model will actually be given, in order. */
  sent: ProductionFrameReference[];
  /** What is left out (by name); never an essential reference. */
  omitted: ProductionFrameReference[];
  /** Why this model cannot make the frame (essential overflow, or the existing explicit-reference limit). */
  refusal: string | null;
  /** The exact still prompt (Advanced). */
  prompt: string;
}

/** How one model would take this Shot's Production Frame inputs. Never switches models: it only describes. */
export function fitProductionFrameToModel(
  pkg: GenerationPackage,
  model: GenerationModel,
  direction?: CreatorDirection | null,
): ProductionFrameModelFit {
  const inputs = productionFrameInputs(pkg);
  const byId = new Map(inputs.references.map((r) => [r.assetId, r]));
  const report = evaluateCompatibility(pkg, model, { purpose: "production_frame" });
  const sent = report.used.references.map((r) => byId.get(r.assetId)).filter((r) => !!r);
  const sentIds = new Set(sent.map((r) => r.assetId));
  const tooMany = report.errors.find((e) => e.id === "references.too_many");
  return {
    provider: model.provider,
    modelId: model.modelId,
    label: model.displayName,
    maxReferences: model.capabilities.references.maxReferences,
    sent: tooMany ? [] : sent,
    omitted: tooMany ? [] : inputs.references.filter((r) => !sentIds.has(r.assetId)),
    refusal: tooMany?.message ?? null,
    prompt: renderPromptPlan(
      buildPromptPlan(pkg, report.adaptation?.promptAdaptation, { purpose: "production_frame", direction }),
    ),
  };
}

/** Models that could take every essential reference of this Shot (a recommendation; the human still chooses). */
export function modelsFittingEssentials(
  pkg: GenerationPackage,
  models: readonly GenerationModel[],
): GenerationModel[] {
  const need = productionFrameInputs(pkg).essentialCount;
  return models.filter(
    (m) => m.capabilities.references.referenceImages && m.capabilities.references.maxReferences >= need,
  );
}

export { essentialOverflowMessage };
