import type { LocationView, LocationViewSelection } from "@/domain/location-view";
import type { Asset } from "@/domain/schemas";

/**
 * Persistence contract for Phase 2G.3 Location Views: the IMMUTABLE canonical views of each Location and the ONE
 * mutable selection pointer per Shot. The application path only (acts as the signed-in user; RLS applies in Postgres).
 * Neither worker role has any access: a worker consumes the frozen request/package, never these tables.
 *
 * Implementations: src/data/location-view-memory.ts and src/data/location-view-postgres.ts (same semantics). Reads
 * reach the domain through ProjectData (the server loaders attach `locationViews` and `shotLocationViewSelections`).
 */
export class LocationViewError extends Error {
  constructor(
    readonly code: "not_found" | "wrong_project" | "wrong_location" | "conflict" | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "LocationViewError";
  }
}

export interface NewLocationView {
  /** from domain `draftLocationView`: everything frozen */
  draft: LocationView;
  /**
   * An upload's NEW private `location_ref` Asset, persisted in the SAME transaction as the view so the pair is
   * all-or-nothing. Null for a promotion (the view references an existing Asset: nothing is copied).
   */
  newAsset: Asset | null;
}

export interface CreateLocationViewResult {
  view: LocationView;
  /**
   * false: an identical view (same Location, image checksum and view spec) already existed and was returned instead
   * of a duplicate row. `newAsset` was then NOT stored, so the caller removes its uploaded object.
   */
  created: boolean;
}

export interface SelectLocationViewInput {
  projectId: string;
  shotId: string;
  locationViewId: string;
  userId: string | null;
  now: string;
  /**
   * Compare-and-set on what the caller saw: a view id, `null` (expected none), or `undefined` (unconditional). A
   * mismatch is a `conflict`, so two browser tabs never silently overwrite each other's choice.
   */
  expectedSelectedViewId?: string | null;
}

export interface ClearLocationViewInput {
  projectId: string;
  shotId: string;
  expectedSelectedViewId?: string | null;
}

export interface LocationViewRepository {
  /** Every view and every Shot selection of a project, for the loaders. */
  listForProject(projectId: string): Promise<{ views: LocationView[]; selections: LocationViewSelection[] }>;
  /** The views of one Location, newest first. */
  listForLocation(projectId: string, locationId: string): Promise<LocationView[]>;
  get(projectId: string, viewId: string): Promise<LocationView | null>;
  /** Stores the optional new Asset and the view together; an identical view is returned instead of duplicated. */
  create(input: NewLocationView): Promise<CreateLocationViewResult>;
  /**
   * Moves the Shot's pointer to a view of THE SHOT'S OWN Location and Project. Touches no Shot, Location or view row.
   * A view of another Location is `wrong_location`; of another Project, `wrong_project`.
   */
  selectForShot(input: SelectLocationViewInput): Promise<LocationViewSelection>;
  /** Removes the Shot's pointer (no-op when none). Compare-and-set like `selectForShot`. */
  clearForShot(input: ClearLocationViewInput): Promise<void>;
  selectionForShot(projectId: string, shotId: string): Promise<LocationViewSelection | null>;
  /** Whether any Location View (of any project the caller owns) uses this Asset. */
  usesAsset(assetId: string): Promise<boolean>;
}

export const SELECTION_CONFLICT_MESSAGE =
  "The selected Location View changed in the meantime. Reload and choose again.";
export const WRONG_LOCATION_MESSAGE =
  "That Location View belongs to a different Location than this Shot's. Choose a view of this Shot's Location.";
