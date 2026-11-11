import { z } from "zod";
import type { LocationView } from "./location-view";
import type { Asset, Location, ProjectData } from "./schemas";

/**
 * Phase 5B-I5: the Location Visual Bible, built on what Prism already has:
 *
 *   Canonical identity   `location.visualBible.canonicalAssetId`, ONE field, so a Location has at most one by
 *                        construction (the database stores the whole Visual Bible in one jsonb column, 0053)
 *   Establishing views   designated entries `{ role: "establishing", label }` ("exterior wide", "lobby wide", …)
 *   Background plates    designated entries `{ role: "plate", label }`: a clean environment image for compositing
 *   Variants             designated entries `{ role: "variant", label }` with a FREE label ("night", "rainy night",
 *                        "event lighting", "crowded", …): a suggestion list, never a rigid enumeration. A variant
 *                        stays part of this Location; it is not a separate Location.
 *   Recurring views      the EXISTING Location Views (2G.3): immutable, named, selected per Shot. Not duplicated here.
 *   Loose references     the existing `referenceAssetIds`, unchanged.
 *
 * A designation is a POINTER to an existing immutable Asset of this Location. Nothing is copied; the Asset is pinned
 * against deletion while designated (asset-usage), and removing the designation removes only the pointer.
 * Only an explicit creator action sets or replaces a designation; generation never does.
 */
export const LOCATION_VISUAL_ROLES = ["establishing", "plate", "variant"] as const;
export type LocationVisualRole = (typeof LOCATION_VISUAL_ROLES)[number];
export const LOCATION_VISUAL_ROLE_LABEL: Record<LocationVisualRole, string> = {
  establishing: "Establishing view",
  plate: "Background plate",
  variant: "Variant",
};
export const SUGGESTED_LOCATION_VARIANTS = [
  "day",
  "golden hour",
  "night",
  "rainy night",
  "event lighting",
  "empty",
  "crowded",
] as const;
export const MAX_LOCATION_LABEL = 60;

const entrySchema = z.object({
  assetId: z.string().min(1),
  role: z.enum(LOCATION_VISUAL_ROLES),
  label: z.string().max(MAX_LOCATION_LABEL),
});
export type LocationVisualEntry = z.infer<typeof entrySchema>;

/** Stored shape (jsonb). Every key optional so the column default `{}` is a valid, empty Visual Bible. */
export const locationVisualBibleSchema = z.object({
  canonicalAssetId: z.string().min(1).nullable().optional(),
  entries: z.array(entrySchema).optional(),
});
export type LocationVisualBible = z.infer<typeof locationVisualBibleSchema>;

export interface NormalizedLocationBible {
  canonicalAssetId: string | null;
  entries: LocationVisualEntry[];
}

export const locationBibleOf = (
  l: Pick<Location, "visualBible"> | null | undefined,
): NormalizedLocationBible => ({
  canonicalAssetId: l?.visualBible?.canonicalAssetId ?? null,
  entries: l?.visualBible?.entries ?? [],
});

export const isEmptyLocationBible = (b: NormalizedLocationBible) =>
  !b.canonicalAssetId && b.entries.length === 0;

/** Every Asset the Visual Bible designates (pinned against deletion while designated). */
export const locationBibleAssetIds = (l: Pick<Location, "visualBible">): string[] => {
  const b = locationBibleOf(l);
  return [...(b.canonicalAssetId ? [b.canonicalAssetId] : []), ...b.entries.map((e) => e.assetId)];
};

/** Normalized free label: lower case, single spaces, bounded. */
export function normalizeLocationLabel(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ").slice(0, MAX_LOCATION_LABEL);
}

/**
 * Is a variant relevant to a Shot? Every word of its label must appear (as a stem: "rainy" ≈ "rain") in the Shot's
 * own time-of-day / weather words or its Scene's time of day. A variant whose label says nothing the Shot says is
 * left out, so a "night" plate never reaches a day Shot. An empty label is never relevant.
 */
export function variantIsRelevant(label: string, shotText: string): boolean {
  const text = shotText.toLowerCase();
  const words = normalizeLocationLabel(label).split(" ").filter(Boolean);
  if (words.length === 0) return false;
  return words.every((w) => {
    const stem = w.length > 4 && w.endsWith("y") ? w.slice(0, -1) : w;
    return text.includes(stem);
  });
}

/** The words a Shot says about its time and state: its own time of day and weather, and its Scene's time of day. */
export function shotTimeText(ctx: {
  shot: { continuity: { timeOfDay: string; weather: string } };
  scene?: { timeOfDay: string } | null;
}): string {
  return [ctx.shot.continuity.timeOfDay, ctx.shot.continuity.weather, ctx.scene?.timeOfDay ?? ""]
    .join(" ")
    .toLowerCase();
}

export interface LocationReference {
  assetId: string;
  label: string;
  kind: "canonical" | LocationVisualRole;
}

/**
 * The Location's Visual Bible references for ONE Shot, in priority order (deduplicated): the canonical identity, then
 * establishing views, then background plates, then the variants relevant to the Shot. The selected Location View
 * (when the Shot has one) outranks all of these; it is placed by the reference assembly, not here.
 */
export function locationBibleReferences(location: Location, shotText: string): LocationReference[] {
  const b = locationBibleOf(location);
  const out: LocationReference[] = [];
  const seen = new Set<string>();
  const push = (assetId: string, kind: LocationReference["kind"], label: string) => {
    if (seen.has(assetId)) return;
    seen.add(assetId);
    out.push({ assetId, kind, label });
  };
  if (b.canonicalAssetId) push(b.canonicalAssetId, "canonical", `${location.name} canonical location`);
  const named = (e: LocationVisualEntry) =>
    `${location.name} ${LOCATION_VISUAL_ROLE_LABEL[e.role].toLowerCase()}${e.label ? ` (${e.label})` : ""}`;
  for (const role of ["establishing", "plate"] as const)
    for (const e of b.entries) if (e.role === role) push(e.assetId, role, named(e));
  for (const e of b.entries)
    if (e.role === "variant" && variantIsRelevant(e.label, shotText)) push(e.assetId, "variant", named(e));
  return out;
}

/** Designated variants NOT relevant to this Shot: kept out of the Shot's generic Location references too. */
export function irrelevantVariantAssetIds(location: Location, shotText: string): Set<string> {
  const relevant = new Set(locationBibleReferences(location, shotText).map((r) => r.assetId));
  return new Set(
    locationBibleOf(location)
      .entries.filter((e) => e.role === "variant" && !relevant.has(e.assetId))
      .map((e) => e.assetId),
  );
}

/** The Location's generic references a Shot receives: all of them, minus designated variants it does not use. */
export function effectiveLocationReferenceIds(location: Location, shotText: string): string[] {
  if (isEmptyLocationBible(locationBibleOf(location))) return location.referenceAssetIds;
  const skip = irrelevantVariantAssetIds(location, shotText);
  return location.referenceAssetIds.filter((id) => !skip.has(id));
}

const stored = (a: Asset | undefined) => !!a && a.type === "image" && !!a.objectPath && !!a.checksum;

export interface LocationBibleItem {
  key: string;
  label: string;
  done: boolean;
  assetId: string | null;
  /** Guidance, never a gate. */
  suggestion: string | null;
  /** The Generate preset that would fill it (existing image pipeline). */
  generateIntent:
    "location_concept" | "establishing_view" | "alternate_angle" | "background" | "time_variant" | null;
}

export interface LocationBibleReadiness {
  locationId: string;
  canonicalAssetId: string | null;
  items: LocationBibleItem[];
  views: Array<{ view: LocationView; assetId: string }>;
  entries: Array<LocationVisualEntry & { stored: boolean }>;
  done: number;
  total: number;
}

/** What the Location's Visual Bible has, and what Prism suggests next (guidance only; nothing here blocks). */
export function locationBibleReadiness(data: ProjectData, locationId: string): LocationBibleReadiness {
  const location = data.locations.find((l) => l.id === locationId);
  const assets = new Map(data.assets.map((a) => [a.id, a]));
  const b = locationBibleOf(location);
  const views = (data.locationViews ?? [])
    .filter((v) => v.locationId === locationId)
    .map((view) => ({ view, assetId: view.assetId }));
  const entries = b.entries.map((e) => ({ ...e, stored: stored(assets.get(e.assetId)) }));
  const first = (role: LocationVisualRole) => entries.find((e) => e.role === role && e.stored);
  const canonical = b.canonicalAssetId && stored(assets.get(b.canonicalAssetId)) ? b.canonicalAssetId : null;
  const hasReverse = views.some((v) => v.view.kind === "reverse");
  const item = (
    key: string,
    label: string,
    assetId: string | null | undefined,
    suggestion: string,
    generateIntent: LocationBibleItem["generateIntent"],
  ): LocationBibleItem => ({
    key,
    label,
    done: !!assetId,
    assetId: assetId ?? null,
    suggestion: assetId ? null : suggestion,
    generateIntent,
  });
  const items: LocationBibleItem[] = [
    item(
      "canonical",
      "Canonical appearance",
      canonical,
      "Choose the image that defines how this place looks.",
      "location_concept",
    ),
    item(
      "establishing",
      "Establishing view",
      first("establishing")?.assetId,
      "You don't have an establishing view yet.",
      "establishing_view",
    ),
    item(
      "view",
      "Location View",
      views[0]?.assetId,
      "Add a recurring camera view that Shots can select.",
      "alternate_angle",
    ),
    item(
      "reverse",
      "Reverse view",
      views.find((v) => v.view.kind === "reverse")?.assetId,
      hasReverse ? "" : "Optional: a reverse angle for the opposite direction.",
      "alternate_angle",
    ),
    item(
      "variant",
      "Time-of-day / state variant",
      first("variant")?.assetId,
      "Optional: a night, golden-hour or crowded variant.",
      "time_variant",
    ),
    item(
      "plate",
      "Background plate",
      first("plate")?.assetId,
      "Optional: a clean plate for compositing.",
      "background",
    ),
  ];
  return {
    locationId,
    canonicalAssetId: canonical,
    items,
    views,
    entries,
    done: items.filter((i) => i.done).length,
    total: items.length,
  };
}
