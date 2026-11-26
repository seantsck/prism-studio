import "server-only";
import { randomUUID } from "node:crypto";
import type { SubjectAttemptView } from "@/data/generation-repository";
import { isArchived } from "@/domain/archive";
import { coverDesignOf, type CoverDesign } from "@/domain/cover-design";
import {
  COVER_CAST_MAX,
  COVER_SHAPES,
  coverPictureOfLocation,
  defaultCoverCast,
} from "@/domain/generation/cover-art";
import { offersTestModels } from "@/domain/generation/reference-studio";
import { canonicalRefOf } from "@/domain/visual-bible";
import { hasStoredImage } from "@/domain/generation/subject-image";
import type { Asset, Project, ProjectData } from "@/domain/schemas";
import { isTrashed } from "@/domain/trash";
import { prepareCoverArt } from "@/generation/cover-submission";
import { previewUrl } from "@/lib/utils";
import { getGenerationConfig, getGenerationRepo, getRegistry } from "./generation";

/** The cover chosen among pictures: the one most recently used as the cover (`metadata.cover.selectedAt`), or none. */
export function pickCover(assets: readonly Asset[]): Asset | null {
  let best: { asset: Asset; at: string } | null = null;
  for (const a of assets) {
    const at = (a.metadata as { cover?: { selectedAt?: unknown } }).cover?.selectedAt;
    if (typeof at !== "string" || !hasStoredImage(a) || isArchived(a) || isTrashed(a)) continue;
    if (!best || at > best.at) best = { asset: a, at };
  }
  return best?.asset ?? null;
}

/** The project's cover: the picture most recently used as the cover, or none. */
export function currentCover(data: ProjectData): Asset | null {
  return pickCover(data.assets);
}

/** "A series in 10 episodes" / "A feature film" / "A short film": the line in the cover's credits. */
export function kindLineOf(project: Pick<Project, "projectType">, episodes: number | null): string {
  if (project.projectType === "film") return "A feature film";
  if (project.projectType === "short") return "A short film";
  return !episodes ? "A series" : `A series in ${episodes} episode${episodes === 1 ? "" : "s"}`;
}

/**
 * The finished cover as it is shown outside the Cover art page (the Start page, the project's card): the picture with
 * its saved title design. The cast names and the credits line are those saved with the cover when it was chosen or its
 * design saved (`metadata.cover.cast` / `kindLine`); a cover chosen before then shows the design's own cast line.
 */
export interface CoverCard {
  url: string | null;
  width: number | null;
  height: number | null;
  design: CoverDesign;
  title: string;
  cast: string[];
  kindLine: string;
}

export function coverCardOf(project: Project, asset: Asset, episodes: number | null = null): CoverCard {
  const record =
    (asset.metadata as { cover?: { design?: unknown; cast?: unknown; kindLine?: unknown } }).cover ?? {};
  return {
    url: previewUrl(asset),
    width: asset.width,
    height: asset.height,
    design: coverDesignOf(record.design),
    title: project.title,
    cast: Array.isArray(record.cast) ? record.cast.filter((c): c is string => typeof c === "string") : [],
    kindLine: typeof record.kindLine === "string" ? record.kindLine : kindLineOf(project, episodes),
  };
}

/** What is saved with a cover so it can be drawn anywhere: who it features (from its take) and the credits line. */
export async function coverSnapshotOf(
  data: ProjectData,
  assetId: string,
): Promise<{ cast: string[]; kindLine: string }> {
  let cast: string[] = [];
  try {
    const repo = await getGenerationRepo({ startInlineWorker: false });
    const views = await repo.listSubjectImageAttempts({ kind: "cover", projectId: data.project.id });
    const view = views.find((v) => v.outputs.some((o) => o.asset.id === assetId));
    cast = ((view?.attempt.packageSnapshot as { cast?: Array<{ name?: unknown }> } | undefined)?.cast ?? [])
      .map((c) => (typeof c.name === "string" ? c.name : ""))
      .filter(Boolean);
  } catch {
    cast = [];
  }
  return { cast, kindLine: kindLineOf(data.project, data.episodes.length) };
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
  /** the characters the take features (from its frozen package) */
  cast: string[];
  /** an edit of another take: which one (its number, when still listed) and what was asked */
  editOf: { number: number | null; instruction: string } | null;
}

/** What an edit of a cover take keeps from it: who and where it shows, and its shape. */
export interface CoverEditSource {
  assetId: string;
  castIds: string[];
  locationId: string | null;
  aspectRatio: string;
}

function editSourceOf(v: SubjectAttemptView, assetId: string): CoverEditSource | null {
  const ratio = (v.attempt.modelSettings as { aspectRatio?: unknown }).aspectRatio;
  if (typeof ratio !== "string") return null;
  const snap = v.attempt.packageSnapshot as {
    cast?: Array<{ id?: unknown }>;
    location?: { id?: unknown } | null;
  };
  return {
    assetId,
    castIds: (snap.cast ?? []).map((c) => c.id).filter((id): id is string => typeof id === "string"),
    locationId: typeof snap.location?.id === "string" ? snap.location.id : null,
    aspectRatio: ratio,
  };
}

/** A cover picture of this project that can be edited: one of its own finished cover takes. */
export async function coverEditSource(data: ProjectData, assetId: string): Promise<CoverEditSource | null> {
  const repo = await getGenerationRepo({ startInlineWorker: false });
  const views = await repo.listSubjectImageAttempts({ kind: "cover", projectId: data.project.id });
  for (const v of views) {
    if (v.attempt.status !== "succeeded") continue;
    if (!v.outputs.some((o) => o.asset.id === assetId)) continue;
    const asset = data.assets.find((a) => a.id === assetId);
    if (!hasStoredImage(asset) || isArchived(asset) || isTrashed(asset)) return null;
    return editSourceOf(v, assetId);
  }
  return null;
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
  // test engines (coloured patterns, never a picture) only where the Studio offers them: no real engine is switched
  // on, or the server asks for them beside the real ones
  const imageModels = registry
    .models()
    .filter((m) => m.capabilities.image && registry.availabilityOf(m).available);
  const tests = offersTestModels(
    imageModels.map((m) => ({ test: m.kind === "mock", available: true })),
    config.mock.showBesideRealModels === true,
  );
  for (const m of imageModels) {
    if (m.kind === "mock" && !tests) continue;
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
        cast: ((v.attempt.packageSnapshot as { cast?: Array<{ name?: unknown }> }).cast ?? [])
          .map((c) => (typeof c.name === "string" ? c.name : ""))
          .filter(Boolean),
        editOf: editOfAttempt(v),
      },
    ];
  });
  // an edit names the take it was made from by its number
  const numberOf = new Map(
    views.flatMap((v) => v.outputs.map((o) => [o.asset.id, v.attempt.attemptNumber] as const)),
  );
  for (const t of takes) {
    const source = (
      views.find((v) => v.attempt.id === t.attemptId)?.attempt.modelSettings as {
        editSourceAssetId?: unknown;
      }
    )?.editSourceAssetId;
    if (t.editOf && typeof source === "string") t.editOf.number = numberOf.get(source) ?? null;
  }
  const cover = currentCover(data);
  // editing the cover: each engine that can edit, priced for this cover's shape and cast
  const coverView = cover
    ? views.find((v) => v.attempt.status === "succeeded" && v.outputs.some((o) => o.asset.id === cover.id))
    : undefined;
  const editSource = cover && coverView ? editSourceOf(coverView, cover.id) : null;
  const editEngines = editSource
    ? imageModels
        .filter((m) => (m.kind !== "mock" || tests) && m.capabilities.image?.editing)
        .map((m) => {
          const p = prepareCoverArt({
            data,
            input: { direction: "", castIds: editSource.castIds, locationId: editSource.locationId },
            registry,
            provider: m.provider,
            modelId: m.modelId,
            aspectRatio: editSource.aspectRatio,
            userId,
            idempotencyKey: `quote-${randomUUID()}`,
            config,
            edit: { sourceAssetId: editSource.assetId, instruction: "quote" },
          });
          return {
            value: `${m.provider}/${m.modelId}`,
            label: m.displayName,
            paid: registry.billsMoney(m),
            usd: p.ok ? p.estimate.amount : null,
            reason: p.ok ? null : p.reasons[0]!,
          };
        })
    : [];
  return {
    engines,
    characters,
    locations,
    castMax: COVER_CAST_MAX,
    takes,
    cover: cover
      ? {
          assetId: cover.id,
          url: previewUrl(cover),
          width: cover.width,
          height: cover.height,
          design: coverDesignOf((cover.metadata as { cover?: { design?: unknown } }).cover?.design),
          cast: takes.find((t) => t.assetId === cover.id)?.cast ?? [],
          number: takes.find((t) => t.assetId === cover.id)?.number ?? null,
          editEngines,
        }
      : null,
    kindLine: kindLineOf(data.project, data.episodes.length),
    available,
  };
}

function editOfAttempt(v: SubjectAttemptView): CoverTake["editOf"] {
  const settings = v.attempt.modelSettings as { editSourceAssetId?: unknown; composer?: { edit?: unknown } };
  if (typeof settings.editSourceAssetId !== "string") return null;
  return {
    number: null,
    instruction: typeof settings.composer?.edit === "string" ? settings.composer.edit : "",
  };
}

export type CoverArtState = Awaited<ReturnType<typeof coverArtState>>;
