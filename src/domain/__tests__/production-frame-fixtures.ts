import { randomUUID } from "node:crypto";
import { buildShotContext, type ShotContext } from "@/domain/context";
import { sha256 } from "@/domain/hash";
import {
  draftProductionFrame,
  type ProductionFrame,
  type ProductionFrameDraft,
  type ProductionFrameSource,
} from "@/domain/production-frame";
import type { Asset, ProjectData } from "@/domain/schemas";
import { seed, shotByCode } from "./helpers";

/**
 * Fixtures for Production Frame tests (Phase 2G.1). Everything is fictional and in memory: no 3D set, GPU, provider or
 * network. The seed's storyboard images are placeholders (no stored file), so a test that promotes one first gives it a
 * real stored image with `storeImage`.
 */

export const T = "2026-10-21T00:00:00.000Z";

/** A distinct, valid sha256 per label. */
export const checksumOf = (label: string) => sha256(`production-frame-fixture:${label}`);

/** Makes an existing seeded Asset a stored image of the given size (the facts a Production Frame freezes). */
export function storeImage(
  data: ProjectData,
  assetId: string,
  o: { width?: number; height?: number; mime?: string; label?: string } = {},
): Asset {
  const a = data.assets.find((x) => x.id === assetId);
  if (!a) throw new Error(`no asset ${assetId}`);
  a.type = "image";
  a.objectPath = `${data.project.id}/${a.id}/${o.label ?? "image"}.png`;
  a.storageProvider = "local";
  a.mime = o.mime ?? "image/png";
  a.width = o.width ?? 1912;
  a.height = o.height ?? 800;
  a.checksum = checksumOf(o.label ?? assetId);
  a.byteSize = 1234;
  return a;
}

/** A brand-new `production_frame` image Asset (what an upload would create), not yet in the project. */
export function newUploadAsset(
  projectId: string,
  o: { id?: string; width?: number; height?: number; mime?: string; label?: string } = {},
): Asset {
  const id = o.id ?? randomUUID();
  return {
    id,
    projectId,
    createdBy: null,
    type: "image",
    purpose: "production_frame",
    source: "upload",
    name: `${o.label ?? "upload"}.png`,
    originalFilename: `${o.label ?? "upload"}.png`,
    storageProvider: "local",
    bucket: null,
    objectPath: `${projectId}/${id}/${o.label ?? "upload"}.png`,
    mime: o.mime ?? "image/png",
    byteSize: 1234,
    checksum: checksumOf(o.label ?? id),
    width: o.width ?? 1912,
    height: o.height ?? 800,
    durationMs: null,
    frameRate: null,
    sampleRate: null,
    channels: null,
    tags: [],
    notes: "",
    metadata: {},
    createdAt: T,
    updatedAt: T,
  };
}

export function contextOf(data: ProjectData, code: string): ShotContext {
  return buildShotContext(data, shotByCode(data, code).id);
}

/** Drafts a frame for a seeded Shot, failing the test loudly if the image is refused. */
export function draftFor(
  data: ProjectData,
  code: string,
  o: {
    asset: Asset;
    source?: ProductionFrameSource;
    sourceStoryboardFrameId?: string | null;
    sourceMasterFrameId?: string | null;
    sourceGenerationAttemptId?: string | null;
    id?: string;
  },
): ProductionFrameDraft {
  const ctx = contextOf(data, code);
  const source = o.source ?? "upload";
  const r = draftProductionFrame(ctx, {
    id: o.id ?? randomUUID(),
    now: T,
    userId: null,
    source,
    sourceStoryboardFrameId: o.sourceStoryboardFrameId ?? (source === "storyboard" ? "sb-fixture" : null),
    sourceMasterFrameId: o.sourceMasterFrameId ?? (source === "previs_master" ? "mf-fixture" : null),
    sourceGenerationAttemptId:
      o.sourceGenerationAttemptId ?? (source === "generation_output" ? "ga-fixture" : null),
    asset: o.asset,
  });
  if (!r.ok) throw new Error(`draft refused: ${r.problem.message}`);
  return r.draft;
}

/** Attaches frames and a selection to the project data the way the server loaders do. */
export function attach(
  data: ProjectData,
  frames: ProductionFrame[],
  selected: ProductionFrame | null,
  userId: string | null = null,
): ProjectData {
  data.productionFrames = frames;
  data.productionFrameSelections = selected
    ? [
        {
          projectId: data.project.id,
          shotId: selected.shotId,
          productionFrameId: selected.id,
          selectedBy: userId,
          selectedAt: T,
        },
      ]
    : [];
  return data;
}

/** A fresh seed project plus one stored 1912×800 upload Asset added to it. */
export function seedWithFrame(code = "3A", o: { selected?: boolean } = {}) {
  const data = seed();
  const asset = newUploadAsset(data.project.id, { label: `frame-${code}` });
  data.assets.push(asset);
  const draft = draftFor(data, code, { asset });
  const frame: ProductionFrame = { ...draft, version: 1 };
  attach(data, [frame], o.selected === false ? null : frame);
  return { data, asset, frame };
}

/** A second seed project with every id replaced consistently (no id is shared with the first). */
export function remappedSeed(slug: string): ProjectData {
  const text = JSON.stringify(seed());
  const map = new Map<string, string>();
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
  const remapped = JSON.parse(
    text.replace(UUID, (id) => map.get(id) ?? (map.set(id, randomUUID()), map.get(id)!)),
  );
  return { ...remapped, project: { ...remapped.project, slug } };
}
