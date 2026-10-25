import { isShotOutputAttempt } from "@/domain/generation/schemas";
import type { GenerationOutput } from "@/domain/generation/schemas";
import type { Asset, GenerationAttempt, ProjectData } from "@/domain/schemas";
import type { AudioPlacement, EditItem, VisualSource } from "./model";

/**
 * The generation media facts an edit needs that are not part of ProjectData (they live in the generation and media
 * repositories): each attempt's outputs, its delivery versions with their parents, its currently selected delivery
 * master, and every candidate set's current Best. The server loads them; the domain only reads them.
 */
export interface AttemptMediaFacts {
  attemptId: string;
  outputs: ReadonlyArray<{ assetId: string; role: GenerationOutput["role"] }>;
  /** `slot = 'delivery'` derivations of this attempt (asset_derivations), with the asset each was derived from. */
  deliveryVersions: ReadonlyArray<{ assetId: string; parentAssetId: string; version: number }>;
  /** attempt_deliveries.asset_id: the selected delivery master (the original or a delivery version), if any. */
  deliveryAssetId: string | null;
}

export interface EditMediaFacts {
  attempts: ReadonlyMap<string, AttemptMediaFacts>;
  /** Current Best of each candidate set (generation_candidate_sets.preferred_attempt_id). Advisory only. */
  bestPointers: ReadonlyArray<{ setId: string; shotId: string; attemptId: string | null }>;
}

export const NO_MEDIA_FACTS: EditMediaFacts = { attempts: new Map(), bestPointers: [] };

/** Output roles that are playable pictures of the attempt (not previews, thumbnails, audio or metadata). */
const PICTURE_ROLES: ReadonlySet<string> = new Set(["primary", "variant"]);

export type VideoSourceViolation =
  | "attempt_not_found"
  | "wrong_project"
  | "wrong_shot"
  | "not_shot_output"
  | "not_succeeded"
  | "asset_not_found"
  | "asset_not_of_attempt"
  | "asset_not_video"
  | "asset_duration_unknown"
  | "invalid_range"
  | "range_outside_asset";

export const VIDEO_SOURCE_VIOLATION_TEXT: Record<VideoSourceViolation, string> = {
  attempt_not_found: "The generation attempt no longer exists.",
  wrong_project: "The generation attempt belongs to another project.",
  wrong_shot: "The generation attempt belongs to another Shot.",
  not_shot_output: "A Production Frame candidate is not a Shot clip and cannot be placed as video.",
  not_succeeded: "Only a completed generation can be placed.",
  asset_not_found: "The clip's file no longer exists.",
  asset_not_of_attempt: "The file is not an output or delivery version of that generation.",
  asset_not_video: "The file is not a video.",
  asset_duration_unknown: "The clip's duration is unknown, so its trim cannot be checked.",
  invalid_range: "The trim is not a valid interval (integer ms, in < out).",
  range_outside_asset: "The trim lies outside the clip.",
};

/** How an asset relates to its attempt, if it is one of the attempt's playable pictures at all. */
export type AttemptAssetRole = "primary_output" | "variant_output" | "delivery_version";

export function attemptAssetRole(
  facts: AttemptMediaFacts | undefined,
  assetId: string,
): AttemptAssetRole | null {
  if (!facts) return null;
  const out = facts.outputs.find((o) => o.assetId === assetId && PICTURE_ROLES.has(o.role));
  if (out) return out.role === "primary" ? "primary_output" : "variant_output";
  return facts.deliveryVersions.some((d) => d.assetId === assetId) ? "delivery_version" : null;
}

/**
 * Can this exact clip interval be placed on this Shot? The SAME project, the item's Shot, a Shot-output purpose (the
 * existing classifier; a Production Frame candidate never), a succeeded attempt, an Asset that IS one of the attempt's
 * playable pictures, a video, and a trim inside that Asset's probed duration. Empty = eligible.
 */
export function videoSourceViolations(
  data: Pick<ProjectData, "project" | "attempts" | "assets">,
  shotId: string,
  source: Extract<VisualSource, { kind: "video" }>,
  media: EditMediaFacts,
): VideoSourceViolation[] {
  const attempt = data.attempts.find((a) => a.id === source.attemptId);
  if (!attempt) return ["attempt_not_found"];
  const out: VideoSourceViolation[] = [];
  if (attempt.projectId !== data.project.id) out.push("wrong_project");
  if (attempt.shotId !== shotId) out.push("wrong_shot");
  if (!isShotOutputAttempt(attempt)) out.push("not_shot_output");
  if (attempt.status !== "succeeded") out.push("not_succeeded");
  const asset = data.assets.find((a) => a.id === source.assetId);
  if (!asset) return [...out, "asset_not_found"];
  if (asset.projectId !== data.project.id) out.push("wrong_project");
  if (!attemptAssetRole(media.attempts.get(attempt.id), asset.id)) out.push("asset_not_of_attempt");
  if (asset.type !== "video") out.push("asset_not_video");
  const { sourceInMs: a, sourceOutMs: b } = source;
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || b <= a) out.push("invalid_range");
  else if (asset.durationMs == null) out.push("asset_duration_unknown");
  else if (b > asset.durationMs) out.push("range_outside_asset");
  return [...new Set(out)];
}

/** Every clip of the Shot an editor may deliberately pin (any succeeded Shot-output attempt, approved or not). */
export interface EligibleClip {
  attempt: GenerationAttempt;
  assets: Array<{ asset: Asset; role: AttemptAssetRole }>;
}

export function eligibleClips(
  data: Pick<ProjectData, "project" | "attempts" | "assets">,
  shotId: string,
  media: EditMediaFacts,
): EligibleClip[] {
  const assets = new Map(data.assets.map((a) => [a.id, a]));
  return data.attempts
    .filter(
      (a) =>
        a.shotId === shotId &&
        a.projectId === data.project.id &&
        a.status === "succeeded" &&
        isShotOutputAttempt(a),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((attempt) => {
      const facts = media.attempts.get(attempt.id);
      const ids = [
        ...(facts?.outputs.filter((o) => PICTURE_ROLES.has(o.role)).map((o) => o.assetId) ?? []),
        ...(facts?.deliveryVersions.map((d) => d.assetId) ?? []),
      ];
      return {
        attempt,
        assets: [...new Set(ids)]
          .map((id) => assets.get(id))
          .filter((a): a is Asset => Boolean(a) && a!.type === "video" && a!.durationMs != null)
          .map((asset) => ({ asset, role: attemptAssetRole(facts, asset.id)! })),
      };
    })
    .filter((c) => c.assets.length > 0);
}

export type PlaceholderViolation = "frame_not_found" | "frame_wrong_shot";

/** A still placeholder must name a frame of THIS Shot. */
export function placeholderViolations(
  data: Pick<ProjectData, "frames" | "productionFrames">,
  shotId: string,
  visual: Exclude<VisualSource, { kind: "video" }>,
): PlaceholderViolation[] {
  if (visual.kind === "none") return [];
  const frame =
    visual.kind === "production_frame"
      ? (data.productionFrames ?? []).find((f) => f.id === visual.productionFrameId)
      : data.frames.find((f) => f.id === visual.storyboardFrameId);
  if (!frame) return ["frame_not_found"];
  return frame.shotId === shotId ? [] : ["frame_wrong_shot"];
}

export type PlacementViolation = "take_not_found" | "take_wrong_line" | "beyond_take";

/** A placement must name an existing take OF its line and play inside that take. */
export function placementViolations(
  data: Pick<ProjectData, "takes">,
  p: AudioPlacement,
): PlacementViolation[] {
  const take = data.takes.find((t) => t.id === p.takeId);
  if (!take) return ["take_not_found"];
  const out: PlacementViolation[] = [];
  if (take.dialogueLineId !== p.dialogueLineId) out.push("take_wrong_line");
  if (p.takeOutMs > take.durationMs) out.push("beyond_take");
  return out;
}

/** Every project-level violation of an item's sources (picture + performance). */
export function itemSourceViolations(
  data: Pick<ProjectData, "project" | "attempts" | "assets" | "frames" | "productionFrames" | "takes">,
  item: EditItem,
  media: EditMediaFacts,
): string[] {
  const visual =
    item.visual.kind === "video"
      ? videoSourceViolations(data, item.shotId, item.visual, media)
      : placeholderViolations(data, item.shotId, item.visual);
  return [
    ...visual,
    ...item.performance.flatMap((p) => placementViolations(data, p).map((v) => `${v}:${p.dialogueLineId}`)),
  ];
}
