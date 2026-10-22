import { z } from "zod";
import type { ShotContext } from "./context";
import { fingerprint } from "./hash";
import type { Asset, Location, ProjectData, Shot } from "./schemas";

/**
 * LOCATION VIEW (Phase 2G.3): one IMMUTABLE canonical image of a Location plus a semantic description of the viewpoint
 * it shows ("Doorway", "Window side", "Reverse"). A filmmaker makes it once; any Shot at that Location can then choose
 * it explicitly, and Prism hands the same image to every Production Frame generation of those Shots, so no model is
 * asked to re-invent the place.
 *
 *   LOCATION            the place: description, geography, zones, entrances, broad reference photos
 *   LOCATION VIEW       this: one named viewpoint of the place, image + viewSpec, frozen at creation
 *   PRODUCTION FRAME    one Shot's approved still (it may BECOME a Location View; it is never one)
 *
 * A Location View is NOT a 3D camera, a Production Frame, a Storyboard Frame or a provider canvas. It needs no 3D set,
 * GPU or reconstruction, and it carries NO spatial coordinates: the viewSpec is semantic production data only. Its
 * image keeps whatever shape it has (a doorway reference may be 4:3 or portrait): it is never cropped to the
 * production aspect, because it is a reference, not a frame.
 *
 * There is deliberately no "current version of Doorway" pointer: a revised view is a NEW Location View, and each Shot
 * names the exact view it means (one selection pointer per Shot). Pure domain code: no persistence or provider.
 */

export const LOCATION_VIEW_SCHEMA = "prism.location-view.v1" as const;
export const LOCATION_VIEW_SPEC_SCHEMA = "prism.location-view-spec.v1" as const;

export const LOCATION_VIEW_KINDS = [
  "establishing",
  "entrance",
  "reverse",
  "side",
  "zone",
  "detail",
  "custom",
] as const;
export type LocationViewKind = (typeof LOCATION_VIEW_KINDS)[number];

export const LOCATION_VIEW_KIND_LABEL: Record<LocationViewKind, string> = {
  establishing: "Establishing",
  entrance: "Entrance",
  reverse: "Reverse",
  side: "Side",
  zone: "Zone",
  detail: "Detail",
  custom: "Custom",
};

/** Where the canonical image came from. Every source REUSES an existing Asset except `upload`. */
export const LOCATION_VIEW_SOURCES = [
  "upload",
  "location_reference",
  "production_frame",
  "storyboard",
  "previs_master",
] as const;
export type LocationViewSource = (typeof LOCATION_VIEW_SOURCES)[number];

export const LOCATION_VIEW_SOURCE_LABEL: Record<LocationViewSource, string> = {
  upload: "Uploaded",
  location_reference: "From Location reference",
  production_frame: "From Production Frame",
  storyboard: "From Storyboard",
  previs_master: "From 3D Master Frame",
};

const id = z.string().min(1);
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const line = z.string().max(2000);
const named = z.object({ id, name: z.string(), description: z.string() });

/** The viewpoint, in words. Every field is optional (empty string / null); nothing here is a coordinate. */
export const locationViewSpecSchema = z.object({
  schema: z.literal(LOCATION_VIEW_SPEC_SCHEMA),
  name: z.string().trim().min(1).max(120),
  kind: z.enum(LOCATION_VIEW_KINDS),
  /** one of the Location's zones / entrances, copied BY VALUE at creation (later Location edits never rewrite it) */
  zone: named.nullable(),
  entrance: named.nullable(),
  viewpointDescription: line,
  orientation: line,
  cameraPosition: line,
  cameraHeight: line,
  cameraAngle: line,
  shotSize: line,
  framing: line,
  lens: line,
  geographyNotes: line,
  continuityNotes: line,
});
export type LocationViewSpec = z.infer<typeof locationViewSpecSchema>;

/** The immutable record. Nothing in it changes after creation. */
export const locationViewSchema = z.object({
  id,
  projectId: id,
  locationId: id,
  schemaVersion: z.literal(LOCATION_VIEW_SCHEMA),
  name: z.string().trim().min(1).max(120),
  kind: z.enum(LOCATION_VIEW_KINDS),
  assetId: id,
  /** frozen from the Asset at creation */
  assetChecksum: hex64,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  source: z.enum(LOCATION_VIEW_SOURCES),
  sourceProductionFrameId: id.nullable(),
  sourceStoryboardFrameId: id.nullable(),
  sourceMasterFrameId: id.nullable(),
  viewSpec: locationViewSpecSchema,
  /** deterministic identity (Location, image checksum, viewSpec; no timestamps): the duplicate key */
  viewFingerprint: hex64,
  createdBy: id.nullable(),
  createdAt: z.string(),
});
export type LocationView = z.infer<typeof locationViewSchema>;

/** The ONE Location View a Shot uses. Changing it moves only this pointer: no Shot, View or Location row changes. */
export const locationViewSelectionSchema = z.object({
  projectId: id,
  shotId: id,
  locationViewId: id,
  /** the Location of the chosen view (the database checks it is the Shot's Location) */
  locationId: id,
  selectedBy: id.nullable(),
  selectedAt: z.string(),
});
export type LocationViewSelection = z.infer<typeof locationViewSelectionSchema>;

// ───────────────────────── effective Location ─────────────────────────

/**
 * The Location a Shot is set in, as Prism resolves it everywhere else (ShotContext, the package, freshness): the
 * Shot's own `spatial.locationId` (persisted as `shots.location_id`). A new Shot copies its Scene's Location at
 * creation; there is no read-time fallback to the Scene, so a Shot without a Location has none here either.
 */
export const effectiveLocationId = (shot: Pick<Shot, "spatial">): string | null =>
  shot.spatial.locationId ?? null;

// ───────────────────────── the image rules ─────────────────────────

export const LOCATION_VIEW_MIMES = ["image/png", "image/jpeg", "image/webp"] as const;
export const LOCATION_VIEW_MIN_EDGE = 64;

export type LocationViewImageCheck =
  { ok: true; width: number; height: number; checksum: string } | { ok: false; message: string };

/**
 * A Location View image: a stored PNG/JPEG/WebP of this project with a checksum and readable size. ANY aspect ratio is
 * accepted (a reference, not a production frame): it is never cropped to the Shot's frame.
 */
export function checkLocationViewImage(
  asset: Pick<Asset, "type" | "mime" | "objectPath" | "width" | "height" | "checksum"> | null,
): LocationViewImageCheck {
  if (!asset) return { ok: false, message: "That image is missing." };
  if (asset.type !== "image") return { ok: false, message: "A Location View must be an image." };
  if (!asset.objectPath)
    return { ok: false, message: "That image has not been uploaded yet (it has no stored file)." };
  if (!(LOCATION_VIEW_MIMES as readonly string[]).includes(asset.mime ?? ""))
    return { ok: false, message: "A Location View must be a PNG, JPEG or WebP image." };
  if (!asset.width || !asset.height)
    return { ok: false, message: "Prism could not read this image's pixel size." };
  if (!asset.checksum || !/^[0-9a-f]{64}$/.test(asset.checksum))
    return { ok: false, message: "This image has no recorded checksum." };
  if (asset.width < LOCATION_VIEW_MIN_EDGE || asset.height < LOCATION_VIEW_MIN_EDGE)
    return {
      ok: false,
      message: `A Location View must be at least ${LOCATION_VIEW_MIN_EDGE} px on each side.`,
    };
  return { ok: true, width: asset.width, height: asset.height, checksum: asset.checksum };
}

// ───────────────────────── creating a record (pure) ─────────────────────────

/** What the filmmaker typed. Zone / entrance are ids of the Location's own zones / entrances. */
export interface LocationViewSpecInput {
  name: string;
  kind: string;
  zoneId?: string | null;
  entranceId?: string | null;
  viewpointDescription?: string;
  orientation?: string;
  cameraPosition?: string;
  cameraHeight?: string;
  cameraAngle?: string;
  shotSize?: string;
  framing?: string;
  lens?: string;
  geographyNotes?: string;
  continuityNotes?: string;
}

export type SpecResult = { ok: true; spec: LocationViewSpec } | { ok: false; message: string };

export function buildLocationViewSpec(
  location: Pick<Location, "zones" | "entrances">,
  input: LocationViewSpecInput,
): SpecResult {
  const name = (input.name ?? "").trim();
  if (!name) return { ok: false, message: "Name the Location View." };
  if (name.length > 120) return { ok: false, message: "A Location View name is at most 120 characters." };
  if (!(LOCATION_VIEW_KINDS as readonly string[]).includes(input.kind))
    return { ok: false, message: "Choose what kind of view this is." };
  const zone = input.zoneId ? location.zones.find((z) => z.id === input.zoneId) : null;
  if (input.zoneId && !zone) return { ok: false, message: "That zone is not part of this Location." };
  const entrance = input.entranceId ? location.entrances.find((e) => e.id === input.entranceId) : null;
  if (input.entranceId && !entrance)
    return { ok: false, message: "That entrance is not part of this Location." };
  const t = (v: string | undefined) => (v ?? "").trim();
  const parsed = locationViewSpecSchema.safeParse({
    schema: LOCATION_VIEW_SPEC_SCHEMA,
    name,
    kind: input.kind,
    zone: zone ? { id: zone.id, name: zone.name, description: zone.description } : null,
    entrance: entrance ? { id: entrance.id, name: entrance.name, description: entrance.description } : null,
    viewpointDescription: t(input.viewpointDescription),
    orientation: t(input.orientation),
    cameraPosition: t(input.cameraPosition),
    cameraHeight: t(input.cameraHeight),
    cameraAngle: t(input.cameraAngle),
    shotSize: t(input.shotSize),
    framing: t(input.framing),
    lens: t(input.lens),
    geographyNotes: t(input.geographyNotes),
    continuityNotes: t(input.continuityNotes),
  });
  return parsed.success
    ? { ok: true, spec: parsed.data }
    : { ok: false, message: "A Location View field is too long." };
}

/**
 * The duplicate key: the Location, the image's bytes (checksum) and the full viewSpec. No timestamps, and no source:
 * the same image described the same way at the same Location IS the same canonical view however it reached Prism,
 * so creating it twice returns the existing one. A changed spec with the same image is a new view (its meaning changed).
 */
export function locationViewFingerprint(
  locationId: string,
  assetChecksum: string,
  spec: LocationViewSpec,
): string {
  return fingerprint({ schema: LOCATION_VIEW_SCHEMA, locationId, assetChecksum, viewSpec: spec });
}

export interface LocationViewDraftInput {
  id: string;
  now: string;
  userId: string | null;
  projectId: string;
  location: Pick<Location, "id" | "projectId" | "zones" | "entrances">;
  asset: Pick<Asset, "id" | "projectId" | "type" | "mime" | "objectPath" | "width" | "height" | "checksum">;
  source: LocationViewSource;
  sourceProductionFrameId?: string | null;
  sourceStoryboardFrameId?: string | null;
  sourceMasterFrameId?: string | null;
  spec: LocationViewSpecInput;
}

export type LocationViewDraftResult = { ok: true; draft: LocationView } | { ok: false; message: string };

/** Each origin carries exactly its own source id (the database CHECK says the same). */
function sourceIdsAreConsistent(i: LocationViewDraftInput): boolean {
  const pf = i.sourceProductionFrameId ?? null;
  const sb = i.sourceStoryboardFrameId ?? null;
  const mf = i.sourceMasterFrameId ?? null;
  switch (i.source) {
    case "upload":
    case "location_reference":
      return !pf && !sb && !mf;
    case "production_frame":
      return !!pf && !sb && !mf;
    case "storyboard":
      return !pf && !!sb && !mf;
    case "previs_master":
      return !pf && !sb && !!mf;
  }
}

export function draftLocationView(i: LocationViewDraftInput): LocationViewDraftResult {
  if (i.location.projectId !== i.projectId)
    return { ok: false, message: "That Location belongs to a different project." };
  if (i.asset.projectId !== i.projectId)
    return { ok: false, message: "That image belongs to a different project." };
  if (!sourceIdsAreConsistent(i))
    return { ok: false, message: "The Location View's origin is inconsistent." };
  const image = checkLocationViewImage(i.asset);
  if (!image.ok) return image;
  const spec = buildLocationViewSpec(i.location, i.spec);
  if (!spec.ok) return spec;
  const draft = locationViewSchema.parse({
    id: i.id,
    projectId: i.projectId,
    locationId: i.location.id,
    schemaVersion: LOCATION_VIEW_SCHEMA,
    name: spec.spec.name,
    kind: spec.spec.kind,
    assetId: i.asset.id,
    assetChecksum: image.checksum,
    width: image.width,
    height: image.height,
    source: i.source,
    sourceProductionFrameId: i.sourceProductionFrameId ?? null,
    sourceStoryboardFrameId: i.sourceStoryboardFrameId ?? null,
    sourceMasterFrameId: i.sourceMasterFrameId ?? null,
    viewSpec: spec.spec,
    viewFingerprint: locationViewFingerprint(i.location.id, image.checksum, spec.spec),
    createdBy: i.userId,
    createdAt: i.now,
  });
  return { ok: true, draft };
}

// ───────────────────────── a Shot's view (resolved from ProjectData) ─────────────────────────

/** Why a stored selection cannot be used. Only reachable through a data-integrity problem: never a silent fallback. */
export interface LocationViewSelectionIssue {
  code: "missing_view" | "wrong_location" | "no_location";
  message: string;
  locationViewId: string;
}

export interface ShotLocationViews {
  /** every view of the Shot's effective Location, newest first (empty without a Location) */
  views: LocationView[];
  /** the selected view, ONLY when it is valid for the Shot's current Location */
  selected: LocationView | null;
  /** a stored selection that does not resolve to a valid view (null when none or valid) */
  issue: LocationViewSelectionIssue | null;
}

export const LOCATION_VIEW_INTEGRITY_MESSAGE =
  "This Shot's selected Location View does not belong to its current Location. Clear it or choose a view of this Location before generating.";

export function resolveShotLocationViews(
  data: Pick<ProjectData, "locationViews" | "shotLocationViewSelections">,
  shot: Pick<Shot, "id" | "spatial">,
): ShotLocationViews {
  const locationId = effectiveLocationId(shot);
  const all = data.locationViews ?? [];
  const views = locationId
    ? all
        .filter((v) => v.locationId === locationId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.name.localeCompare(b.name))
    : [];
  const sel = data.shotLocationViewSelections?.find((s) => s.shotId === shot.id);
  if (!sel) return { views, selected: null, issue: null };
  const view = all.find((v) => v.id === sel.locationViewId);
  if (!view)
    return {
      views,
      selected: null,
      issue: {
        code: "missing_view",
        message: LOCATION_VIEW_INTEGRITY_MESSAGE,
        locationViewId: sel.locationViewId,
      },
    };
  if (!locationId)
    return {
      views,
      selected: null,
      issue: { code: "no_location", message: LOCATION_VIEW_INTEGRITY_MESSAGE, locationViewId: view.id },
    };
  if (view.locationId !== locationId)
    return {
      views,
      selected: null,
      issue: { code: "wrong_location", message: LOCATION_VIEW_INTEGRITY_MESSAGE, locationViewId: view.id },
    };
  return { views, selected: view, issue: null };
}

/**
 * What the Shot's LOCATION part hashes about its view (domain/fingerprint): the view's immutable identity, or the
 * invalid selection. Undefined when no view is selected, so a Shot without one hashes exactly as before 2G.3.
 */
export function locationViewPartIdentity(
  ctx: Pick<ShotContext, "selectedLocationView" | "locationViewIssue">,
): Record<string, unknown> | undefined {
  const v = ctx.selectedLocationView;
  if (v)
    return {
      viewId: v.id,
      viewFingerprint: v.viewFingerprint,
      assetChecksum: v.assetChecksum,
    };
  if (ctx.locationViewIssue) return { invalidSelection: ctx.locationViewIssue.locationViewId };
  return undefined;
}

// ───────────────────────── by-value reference for GenerationPackage v4 ─────────────────────────

/** What a GenerationPackage records about the selected Location View (by value; never a URL or a path). */
export interface LocationViewPackageRef {
  viewId: string;
  locationId: string;
  name: string;
  kind: LocationViewKind;
  assetId: string;
  assetChecksum: string;
  width: number;
  height: number;
  source: LocationViewSource;
  viewFingerprint: string;
  viewSpec: LocationViewSpec;
}

export function locationViewPackageRef(v: LocationView | null): LocationViewPackageRef | null {
  if (!v) return null;
  return {
    viewId: v.id,
    locationId: v.locationId,
    name: v.name,
    kind: v.kind,
    assetId: v.assetId,
    assetChecksum: v.assetChecksum,
    width: v.width,
    height: v.height,
    source: v.source,
    viewFingerprint: v.viewFingerprint,
    viewSpec: structuredClone(v.viewSpec),
  };
}

/** The view's semantic facts as short lines (prompt plan, brief, UI). Words only: the image is the visual evidence. */
export function describeLocationView(v: Pick<LocationView, "name" | "kind" | "viewSpec">): string[] {
  const s = v.viewSpec;
  const lines = [
    `canonical Location View: "${v.name}" (${LOCATION_VIEW_KIND_LABEL[v.kind].toLowerCase()})`,
    s.viewpointDescription && `viewpoint: ${s.viewpointDescription}`,
    s.zone && `zone: ${s.zone.name}`,
    s.entrance && `entrance: ${s.entrance.name}`,
    s.orientation && `orientation: ${s.orientation}`,
    [s.cameraPosition, s.cameraHeight, s.cameraAngle].some(Boolean) &&
      `view camera: ${[s.cameraPosition, s.cameraHeight, s.cameraAngle].filter(Boolean).join(" / ")}`,
    [s.shotSize, s.framing, s.lens].some(Boolean) &&
      `view framing: ${[s.shotSize, s.framing, s.lens].filter(Boolean).join(" · ")}`,
    s.geographyNotes && `geography: ${s.geographyNotes}`,
    s.continuityNotes && `continuity: ${s.continuityNotes}`,
  ];
  return lines.filter((l): l is string => typeof l === "string" && l.trim().length > 0);
}
