import {
  effectiveLocationId,
  locationViewSchema,
  locationViewSelectionSchema,
  type LocationView,
  type LocationViewSelection,
} from "@/domain/location-view";
import type { ProjectData, Shot } from "@/domain/schemas";
import type { MemoryProjectsAccess } from "./generation-memory";
import {
  LocationViewError,
  SELECTION_CONFLICT_MESSAGE,
  WRONG_LOCATION_MESSAGE,
  type ClearLocationViewInput,
  type CreateLocationViewResult,
  type LocationViewRepository,
  type NewLocationView,
  type SelectLocationViewInput,
} from "./location-view-repository";

const clone = <T>(v: T): T => structuredClone(v);

/**
 * In-process Location View persistence for memory/demo mode and fast tests. Semantics mirror the Postgres
 * implementation and migration 0040: a unique view fingerprint per Location, views frozen after creation, a new Asset
 * stored together with its view, one selection per Shot that can only name a view of the Shot's OWN Location and
 * Project, and (like the database trigger on `shots.location_id`) a selection that is removed when its Shot moves to
 * another Location (`onShotSaved`, called by the memory repository whenever a Shot is written).
 */
export class MemoryLocationViewService implements LocationViewRepository {
  private views: LocationView[] = [];
  private selections = new Map<string, LocationViewSelection>(); // by shot id

  constructor(private readonly access: MemoryProjectsAccess) {}

  private projectOf(projectId: string): ProjectData | undefined {
    return this.access.all().find((p) => p.project.id === projectId);
  }

  /** The database cascades: a removed Location takes its views; a removed Shot or view takes the selection. */
  private live(projectId: string) {
    const p = this.projectOf(projectId);
    const locations = new Set(p?.locations.map((l) => l.id) ?? []);
    const shots = new Map((p?.shots ?? []).map((s) => [s.id, s]));
    const views = this.views.filter((v) => v.projectId === projectId && locations.has(v.locationId));
    const viewIds = new Set(views.map((v) => v.id));
    const selections = [...this.selections.values()].filter(
      (s) => s.projectId === projectId && shots.has(s.shotId) && viewIds.has(s.locationViewId),
    );
    return { views, selections };
  }

  async listForProject(projectId: string) {
    const { views, selections } = this.live(projectId);
    return {
      views: [...views]
        .sort((a, b) => a.locationId.localeCompare(b.locationId) || b.createdAt.localeCompare(a.createdAt))
        .map(clone),
      selections: selections.map(clone),
    };
  }

  async listForLocation(projectId: string, locationId: string) {
    return this.live(projectId)
      .views.filter((v) => v.locationId === locationId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(clone);
  }

  async get(projectId: string, viewId: string) {
    const v = this.live(projectId).views.find((x) => x.id === viewId);
    return v ? clone(v) : null;
  }

  async create(input: NewLocationView): Promise<CreateLocationViewResult> {
    const { draft } = input;
    const project = this.projectOf(draft.projectId);
    if (!project) throw new LocationViewError("not_found", "That project no longer exists.");
    if (!project.locations.some((l) => l.id === draft.locationId))
      throw new LocationViewError("not_found", "That Location no longer exists in this project.");

    // an identical view already exists: return it instead of a duplicate row
    const existing = this.views.find(
      (v) => v.locationId === draft.locationId && v.viewFingerprint === draft.viewFingerprint,
    );
    if (existing) return { view: clone(existing), created: false };

    // what the database trigger checks: a real, stored image of THIS project whose facts are the view's facts
    const asset =
      input.newAsset && input.newAsset.id === draft.assetId
        ? input.newAsset
        : project.assets.find((a) => a.id === draft.assetId);
    if (!asset || asset.projectId !== draft.projectId)
      throw new LocationViewError("wrong_project", "The Location View image is not in this project.");
    if (
      asset.type !== "image" ||
      !asset.objectPath ||
      asset.checksum !== draft.assetChecksum ||
      asset.width !== draft.width ||
      asset.height !== draft.height
    )
      throw new LocationViewError("invalid", "The Location View facts do not match its image.");

    const view = locationViewSchema.parse(draft);
    if (input.newAsset && !project.assets.some((a) => a.id === input.newAsset!.id))
      project.assets.push(clone(input.newAsset));
    this.views.push(clone(view));
    return { view: clone(view), created: true };
  }

  private shotOf(projectId: string, shotId: string): Shot {
    const project = this.projectOf(projectId);
    if (!project) throw new LocationViewError("not_found", "That project no longer exists.");
    const shot = project.shots.find((s) => s.id === shotId);
    if (!shot) throw new LocationViewError("not_found", "That Shot no longer exists.");
    return shot;
  }

  private checkExpected(shotId: string, expected: string | null | undefined) {
    if (expected === undefined) return;
    const current = this.selections.get(shotId)?.locationViewId ?? null;
    if (current !== expected) throw new LocationViewError("conflict", SELECTION_CONFLICT_MESSAGE);
  }

  async selectForShot(input: SelectLocationViewInput): Promise<LocationViewSelection> {
    const shot = this.shotOf(input.projectId, input.shotId);
    const view = this.views.find((v) => v.id === input.locationViewId);
    if (!view) throw new LocationViewError("not_found", "That Location View no longer exists.");
    if (view.projectId !== input.projectId)
      throw new LocationViewError("wrong_project", "That Location View belongs to a different project.");
    if (view.locationId !== effectiveLocationId(shot))
      throw new LocationViewError("wrong_location", WRONG_LOCATION_MESSAGE);
    this.checkExpected(input.shotId, input.expectedSelectedViewId);
    const current = this.selections.get(input.shotId);
    // re-selecting the view that is already selected changes nothing (no spurious write)
    if (current?.locationViewId === view.id) return clone(current);
    const selection = locationViewSelectionSchema.parse({
      projectId: view.projectId,
      shotId: input.shotId,
      locationViewId: view.id,
      locationId: view.locationId,
      selectedBy: input.userId,
      selectedAt: input.now,
    });
    this.selections.set(input.shotId, selection);
    return clone(selection);
  }

  async clearForShot(input: ClearLocationViewInput): Promise<void> {
    this.shotOf(input.projectId, input.shotId);
    this.checkExpected(input.shotId, input.expectedSelectedViewId);
    this.selections.delete(input.shotId);
  }

  async selectionForShot(projectId: string, shotId: string) {
    const s = this.live(projectId).selections.find((x) => x.shotId === shotId);
    return s ? clone(s) : null;
  }

  async usesAsset(assetId: string): Promise<boolean> {
    return this.views.some((v) => v.assetId === assetId);
  }

  /**
   * The memory twin of migration 0040's `shots_location_view_selection_clear` trigger: a Shot written with a different
   * Location loses a selection of a view of its previous Location, at once.
   */
  onShotSaved(shot: Pick<Shot, "id" | "spatial">): void {
    const sel = this.selections.get(shot.id);
    if (sel && sel.locationId !== effectiveLocationId(shot)) this.selections.delete(shot.id);
  }
}
