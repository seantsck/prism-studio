import "server-only";
import { randomUUID } from "node:crypto";
import type { SubjectAttemptView } from "@/data/generation-repository";
import { isArchived } from "@/domain/archive";
import { COVER_SHAPES, defaultCoverCast } from "@/domain/generation/cover-art";
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
          input: { direction: "" },
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
  const cast = defaultCoverCast(data).map((id) => data.characters.find((c) => c.id === id)!.name);
  return {
    engines,
    takes,
    cover: cover
      ? { assetId: cover.id, url: previewUrl(cover), width: cover.width, height: cover.height }
      : null,
    cast,
    available,
  };
}

export type CoverArtState = Awaited<ReturnType<typeof coverArtState>>;
