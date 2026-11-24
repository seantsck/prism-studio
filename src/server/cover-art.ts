import "server-only";
import { randomUUID } from "node:crypto";
import type { SubjectAttemptView } from "@/data/generation-repository";
import { isArchived } from "@/domain/archive";
import {
  COVER_CAST_MAX,
  COVER_SHAPES,
  coverPictureOfLocation,
  defaultCoverCast,
} from "@/domain/generation/cover-art";
import { canonicalRefOf } from "@/domain/visual-bible";
import { hasStoredImage } from "@/domain/generation/subject-image";
import type { Asset, ProjectData } from "@/domain/schemas";
import { isTrashed } from "@/domain/trash";
import { prepareCoverArt } from "@/generation/cover-submission";
import { previewUrl } from "@/lib/utils";
import { getGenerationConfig, getGenerationRepo, getRegistry } from "./generation";

/** The cover chosen: the picture most recently used as the cover (`metadata.cover.selectedAt`), or none. */
export function currentCover(data: ProjectData): Asset | null {
  let best: { asset: Asset; at: string } | null = null;
  for (const a of data.assets) {
    const at = (a.metadata as { cover?: { selectedAt?: unknown } }).cover?.selectedAt;
    if (typeof at !== "string" || !hasStoredImage(a) || isArchived(a) || isTrashed(a)) continue;
    if (!best || at > best.at) best = { asset: a, at };
  }
  return best?.asset ?? null;
}

export interface CoverEngine {
  value: string;
  label: string;
  paid: boolean;
  /** each shape this engine offers, with its price (null: refused, with why) */
  shapes: Array<{ ratio: string; label: string; usd: number | null; reason: string | null }>;
}

export interface CoverTake {
  attemptId: string;
  number: number;
  status: string;
  error: string | null;
  url: string | null;
  assetId: string | null;
  ratio: string | null;
  width: number | null;
  height: number | null;
  engine: string;
  createdAt: string;
}

/** Everything the cover art panel shows: engines and prices per shape, the takes made, and the current cover. */
export async function coverArtState(data: ProjectData, userId: string | null) {
  const registry = getRegistry();
  const config = getGenerationConfig();
  // who and where a cover can feature, with whether a picture of them is sent (their canonical picture)
  const picturedCharacter = (id: string) => {
    const ref = canonicalRefOf(data, id);
    return hasStoredImage(data.assets.find((a) => a.id === ref?.assetId));
  };
  const defaults = new Set(defaultCoverCast(data));
  const characters = data.characters
    .filter((c) => !c.trashedAt)
    .map((c) => ({ id: c.id, name: c.name, pictured: picturedCharacter(c.id), chosen: defaults.has(c.id) }));
  const locations = data.locations
    .filter((l) => !l.trashedAt)
    .map((l) => ({ id: l.id, name: l.name, pictured: coverPictureOfLocation(data, l.id) !== null }));
  // the price is quoted for the most a cover can send: four pictured characters and a pictured location (a ceiling)
  const ceiling = {
    direction: "",
    castIds: [
      ...characters.filter((c) => c.pictured && c.chosen),
      ...characters.filter((c) => c.pictured && !c.chosen),
    ]
      .slice(0, COVER_CAST_MAX)
      .map((c) => c.id),
    locationId: locations.find((l) => l.pictured)?.id ?? null,
  };
  const engines: CoverEngine[] = [];
  for (const m of registry.models()) {
    if (!m.capabilities.image || !registry.availabilityOf(m).available) continue;
    const ratios = COVER_SHAPES.filter((s) => m.capabilities.image!.aspectRatios.includes(s.ratio));
    if (ratios.length === 0) continue;
    engines.push({
      value: `${m.provider}/${m.modelId}`,
      label: m.displayName,
      paid: registry.billsMoney(m),
      shapes: ratios.map((s) => {
        const p = prepareCoverArt({
          data,
          input: ceiling,
          registry,
          provider: m.provider,
          modelId: m.modelId,
          aspectRatio: s.ratio,
          userId,
          idempotencyKey: `quote-${randomUUID()}`,
          config,
        });
        return {
          ratio: s.ratio,
          label: s.label,
          usd: p.ok ? p.estimate.amount : null,
          reason: p.ok ? null : p.reasons[0]!,
        };
      }),
    });
  }
  const repo = await getGenerationRepo({ startInlineWorker: false });
  let views: SubjectAttemptView[] = [];
  let available = true;
  try {
    views = await repo.listSubjectImageAttempts({ kind: "cover", projectId: data.project.id });
  } catch (err) {
    // before migration 0069 there is no project_cover column: no covers yet, and making one says so
    if ((err as { code?: string }).code !== "42703") throw err;
    available = false;
  }
  const assets = new Map(data.assets.map((a) => [a.id, a]));
  const takes: CoverTake[] = views.flatMap((v) => {
    const out = v.outputs.find((o) => o.output.role === "primary") ?? v.outputs[0];
    const asset = out ? assets.get(out.asset.id) : undefined;
    // a cover archived or in the Trash leaves the list
    if (v.attempt.status === "succeeded" && (!asset || isArchived(asset))) return [];
    return [
      {
        attemptId: v.attempt.id,
        number: v.attempt.attemptNumber,
        status: v.attempt.status,
        error:
          v.attempt.status === "failed" ? v.job?.lastErrorMessage || "This picture could not be made." : null,
        url: asset ? previewUrl(asset) : null,
        assetId: asset?.id ?? null,
        ratio: (v.attempt.modelSettings as { aspectRatio?: string }).aspectRatio ?? null,
        width: asset?.width ?? null,
        height: asset?.height ?? null,
        engine: v.attempt.model,
        createdAt: v.attempt.createdAt,
      },
    ];
  });
  const cover = currentCover(data);
  return {
    engines,
    characters,
    locations,
    castMax: COVER_CAST_MAX,
    takes,
    cover: cover
      ? { assetId: cover.id, url: previewUrl(cover), width: cover.width, height: cover.height }
      : null,
    available,
  };
}

export type CoverArtState = Awaited<ReturnType<typeof coverArtState>>;
