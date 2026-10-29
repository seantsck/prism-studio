import { randomUUID } from "node:crypto";
import { seed, shotByCode } from "@/domain/__tests__/helpers";
import { newUploadAsset } from "@/domain/__tests__/production-frame-fixtures";
import { buildEpisodeCuts } from "@/domain/continuity/sequence";
import { DEFAULT_EDIT_RATE, type EditRate } from "@/domain/edit/edit-rate";
import type { AttemptMediaFacts } from "@/domain/edit/eligibility";
import type { EditItem, EpisodeEdit, VisualSource } from "@/domain/edit/model";
import { buildEpisodeEditView } from "@/domain/edit/view";
import {
  generationAttemptSchema,
  type Asset,
  type GenerationAttempt,
  type ProjectData,
} from "@/domain/schemas";

/**
 * Cut fixtures (Phase 3A.4A / 3A.4B tests): seed data plus in-memory clips and Episode Edits. Pure: no repository,
 * provider, media processing or network.
 */

let n = 0;
export function videoAsset(data: ProjectData, durationMs: number): Asset {
  const base = newUploadAsset(data.project.id, { label: `cut-clip-${++n}` });
  const asset: Asset = {
    ...base,
    type: "video",
    purpose: "generation_output",
    mime: "video/mp4",
    durationMs,
  };
  data.assets.push(asset);
  return asset;
}

export function addAttempt(
  data: ProjectData,
  code: string,
  o: { approved?: boolean } = {},
): GenerationAttempt {
  const shotId = shotByCode(data, code).id;
  if (o.approved) for (const a of data.attempts) if (a.shotId === shotId) a.approved = false;
  const attempt = generationAttemptSchema.parse({
    id: randomUUID(),
    projectId: data.project.id,
    shotId,
    attemptNumber: 500 + ++n,
    provider: "mock",
    model: "mock-video-1",
    modality: "video",
    prompt: "",
    negativePrompt: "",
    packageSnapshot: {},
    packageFingerprint: `fp-cut-${n}`,
    modelSettings: {},
    inputAssetIds: [],
    outputAssetId: null,
    costUsd: 0,
    durationMs: null,
    status: "succeeded",
    reviewStatus: o.approved ? "approved" : "unreviewed",
    rejectionReason: "",
    notes: "",
    approved: o.approved ?? false,
    request: { purpose: "shot_output" },
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString(),
  });
  data.attempts.push(attempt);
  return attempt;
}

export interface World {
  data: ProjectData;
  media: Map<string, AttemptMediaFacts>;
}

export function world(): World {
  return { data: seed(), media: new Map() };
}

/** A clip of Shot `code`: an attempt and its primary output of `durationMs`. */
export function clip(w: World, code: string, durationMs = 6000, o: { approved?: boolean } = {}) {
  const attempt = addAttempt(w.data, code, o);
  const asset = videoAsset(w.data, durationMs);
  w.media.set(attempt.id, {
    attemptId: attempt.id,
    outputs: [{ assetId: asset.id, role: "primary" }],
    deliveryVersions: [],
    deliveryAssetId: null,
  });
  return { attempt, asset };
}

export function videoItem(
  w: World,
  code: string,
  o: { inMs?: number; outMs?: number; durationMs?: number } = {},
): EditItem {
  const { attempt, asset } = clip(w, code, o.durationMs ?? 6000);
  return item(w.data, code, {
    kind: "video",
    attemptId: attempt.id,
    assetId: asset.id,
    sourceInMs: o.inMs ?? 0,
    sourceOutMs: o.outMs ?? 5000,
  });
}

export function item(data: ProjectData, code: string, visual: VisualSource): EditItem {
  return {
    id: randomUUID(),
    shotId: shotByCode(data, code).id,
    visual,
    sourceAudio: "muted",
    performance: [],
    performanceBasis: null,
  };
}

export function editOf(
  w: World,
  items: EditItem[],
  o: { rate?: EditRate; revision?: number; id?: string } = {},
): EpisodeEdit {
  return {
    id: o.id ?? "edit-1",
    projectId: w.data.project.id,
    episodeId: w.data.episodes[0].id,
    editRate: o.rate ?? DEFAULT_EDIT_RATE,
    revision: o.revision ?? 0,
    items,
  };
}

export const cutsOf = (
  w: World,
  edit: EpisodeEdit,
  shotQa?: Map<string, "critical_mismatch" | "no_blocking_mismatch">,
) =>
  buildEpisodeCuts({
    data: w.data,
    view: buildEpisodeEditView(w.data, edit, { attempts: w.media, bestPointers: [] }),
    shotQa,
  });
