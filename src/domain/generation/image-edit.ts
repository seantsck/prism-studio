import { renderPromptPlan } from "./prompt-plan";
import type { GenerationModel, GenerationRequest, PromptPlan } from "./schemas";

/**
 * Phase 5B-I2: "Edit Image" for a Shot still (a Production Frame candidate / generated still). An edit is an ordinary
 * still-image request in which the chosen source image is sent FIRST ("the image to edit") and the creator's
 * instruction is part of the prompt plan the provider receives. The source Asset is never modified: the result is a
 * new Asset produced by a new attempt, which records the source (`modelSettings.editSourceAssetId`, `inputAssetIds`).
 *
 * Pure. Used by both the estimate path and the submit path, so the cost the creator confirms is the cost of the edit.
 */
export interface ImageEditSpec {
  sourceAssetId: string;
  instruction: string;
}

export const MAX_EDIT_INSTRUCTION_CHARS = 2_000;

/** Problems that make an edit impossible on this model (never emulated). */
export function imageEditBlockers(model: GenerationModel, request: GenerationRequest): string[] {
  const out: string[] = [];
  if (!model.capabilities.image) out.push(`${model.displayName} does not make still images.`);
  else if (!model.capabilities.modalities.includes("image_to_image") || !model.capabilities.image.editing)
    out.push(`${model.displayName} cannot edit images.`);
  if (request.purpose !== "production_frame")
    out.push("Only a Production Frame candidate (a still) can be an image edit.");
  return out;
}

export function applyImageEdit(
  request: GenerationRequest,
  plan: PromptPlan,
  edit: ImageEditSpec,
  model: GenerationModel,
): { request: GenerationRequest; plan: PromptPlan } {
  const instruction = edit.instruction.trim().slice(0, MAX_EDIT_INSTRUCTION_CHARS);
  const line = `Edit the first image: ${instruction}`;
  const has = plan.sections.some((s) => s.key === "action");
  const nextPlan: PromptPlan = {
    ...plan,
    sections: has
      ? plan.sections.map((s) => (s.key === "action" ? { ...s, lines: [line, ...s.lines] } : s))
      : [{ key: "action", title: "Edit", lines: [line] }, ...plan.sections],
  };
  const max = Math.max(1, model.capabilities.references.maxReferences);
  const references = [
    { assetId: edit.sourceAssetId, role: "production_frame" as const, order: 0, label: "the image to edit" },
    ...request.references.filter((r) => r.assetId !== edit.sourceAssetId),
  ]
    .slice(0, max)
    .map((r, i) => ({ ...r, order: i }));
  return {
    plan: nextPlan,
    request: {
      ...request,
      modality: "image_to_image",
      references,
      prompt: { ...request.prompt, positive: renderPromptPlan(nextPlan, { includeNegative: false }) },
    },
  };
}

/** A transparent background must be native to the model; it is refused, never faked. */
export function transparencyBlockers(model: GenerationModel, request: GenerationRequest): string[] {
  if (request.providerOptions?.background !== "transparent") return [];
  return model.capabilities.image?.transparency
    ? []
    : [`${model.displayName} cannot make transparent backgrounds.`];
}

/**
 * The stills a Shot may edit: its own generated outputs (Shot attempts), its Storyboard frames and its Production
 * Frames, limited to stored images of this project. Anything else (another Shot's still, a Character image) is refused.
 */
export function shotEditableAssetIds(
  data: {
    assets: ReadonlyArray<{ id: string; type: string; objectPath: string | null }>;
    attempts: ReadonlyArray<{ shotId: string | null; outputAssetId: string | null }>;
    frames: ReadonlyArray<{ shotId: string; assetId: string | null }>;
    productionFrames?: ReadonlyArray<{ shotId: string; assetId: string }>;
  },
  shotId: string,
): Set<string> {
  const stored = new Set(data.assets.filter((a) => a.type === "image" && a.objectPath).map((a) => a.id));
  const ids = [
    ...data.attempts.filter((a) => a.shotId === shotId).map((a) => a.outputAssetId),
    ...data.frames.filter((f) => f.shotId === shotId).map((f) => f.assetId),
    ...(data.productionFrames ?? []).filter((f) => f.shotId === shotId).map((f) => f.assetId),
  ];
  return new Set(ids.filter((id): id is string => !!id && stored.has(id)));
}
