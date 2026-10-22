import { randomUUID } from "node:crypto";
import {
  draftLocationView,
  type LocationView,
  type LocationViewSource,
  type LocationViewSpecInput,
} from "@/domain/location-view";
import type { Asset, ProjectData } from "@/domain/schemas";
import { shotByCode } from "./helpers";
import { T } from "./production-frame-fixtures";

/**
 * Fixtures for Location View tests (Phase 2G.3). Fictional and in memory: no 3D set, GPU, provider or network.
 */

export const locationOf = (data: ProjectData, code: string) => {
  const id = shotByCode(data, code).spatial.locationId;
  const l = data.locations.find((x) => x.id === id);
  if (!l) throw new Error(`shot ${code} has no location`);
  return l;
};

export const locationByName = (data: ProjectData, name: string) => {
  const l = data.locations.find((x) => x.name === name);
  if (!l) throw new Error(`no location ${name}`);
  return l;
};

/** Drafts a view, failing the test loudly when it is refused. */
export function viewFor(
  data: ProjectData,
  locationId: string,
  asset: Asset,
  spec: Partial<LocationViewSpecInput> = {},
  o: { source?: LocationViewSource; sourceProductionFrameId?: string | null; id?: string; now?: string } = {},
): LocationView {
  const location = data.locations.find((l) => l.id === locationId)!;
  const r = draftLocationView({
    id: o.id ?? randomUUID(),
    now: o.now ?? T,
    userId: null,
    projectId: data.project.id,
    location,
    asset,
    source: o.source ?? "upload",
    sourceProductionFrameId: o.sourceProductionFrameId ?? null,
    spec: { name: "Doorway", kind: "entrance", ...spec },
  });
  if (!r.ok) throw new Error(`view refused: ${r.message}`);
  return r.draft;
}

/** Attaches views and Shot selections to the project data the way the server loaders do. */
export function attachViews(
  data: ProjectData,
  views: LocationView[],
  selections: Array<{ shotId: string; view: LocationView }> = [],
): ProjectData {
  data.locationViews = views;
  data.shotLocationViewSelections = selections.map(({ shotId, view }) => ({
    projectId: data.project.id,
    shotId,
    locationViewId: view.id,
    locationId: view.locationId,
    selectedBy: null,
    selectedAt: T,
  }));
  return data;
}
