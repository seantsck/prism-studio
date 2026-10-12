import { describe, expect, it } from "vitest";
import { buildSeedProject } from "@/data/seed";
import {
  COLLECTIONS,
  flatFromRow,
  flatToRow,
  locationFromRow,
  locationToRow,
  sceneFromRow,
  sceneToRows,
  shotFromRows,
  shotToRows,
  type Row,
} from "@/data/postgres-mapping";
import { shotSchema, type CollectionName } from "@/domain/schemas";

/** Simulate what Postgres hands back: jsonb columns are parsed, everything else is passed through. */
const fromDb = (row: Row, jsonCols: string[]): Row =>
  Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      k,
      jsonCols.includes(k) && typeof v === "string" ? JSON.parse(v) : v,
    ]),
  );
const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

describe("postgres mapping", () => {
  const data = buildSeedProject();

  const simple: CollectionName[] = [
    "assets",
    "characters",
    "identityRefs",
    "looks",
    "voiceProfiles",
    "props",
    "episodes",
    "dialogueLines",
    "directions",
    "takes",
    "frames",
    "attempts",
    "continuityChecks",
  ];

  it.each(simple)("round-trips %s through its SQL row shape", (name) => {
    const spec = COLLECTIONS[name];
    const items = data[name] as unknown as object[];
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      const row = flatToRow(item, spec);
      const back = spec.schema.parse(flatFromRow(fromDb(row, spec.json.map(snake)), spec));
      expect(back).toEqual(spec.schema.parse(item));
    }
  });

  it("round-trips locations including the reserved 3D set columns", () => {
    for (const loc of data.locations) {
      const row = locationToRow(loc);
      const back = COLLECTIONS.locations.schema.parse(
        locationFromRow(fromDb(row, ["zones", "entrances", "set3d"])),
      );
      expect(back).toEqual(loc);
    }
    const withSet = {
      ...data.locations[0],
      set3d: { modelAssetId: data.assets[0].id, cameraRigs: [{ a: 1 }], blockingMarkers: [], lightRigs: [] },
    };
    const row = locationToRow(withSet);
    expect(row.set3d_model_asset_id).toBe(data.assets[0].id);
    expect(
      COLLECTIONS.locations.schema.parse(locationFromRow(fromDb(row, ["zones", "entrances", "set3d"]))),
    ).toEqual(withSet);
  });

  it("splits scenes into row + join rows and back", () => {
    for (const scene of data.scenes) {
      const rows = sceneToRows(scene);
      expect(rows.scene).not.toHaveProperty("character_ids");
      const back = COLLECTIONS.scenes.schema.parse(
        sceneFromRow(
          rows.scene,
          rows.characters.map((r) => String(r.character_id)),
          rows.props.map((r) => String(r.prop_id)),
        ),
      );
      expect(back).toEqual(scene);
    }
  });

  it("normalises shots: Looks, dialogue links and references live in join tables", () => {
    const sections = [
      "composition",
      "spatial",
      "continuity",
      "action",
      "audio",
      "lighting",
      "constraints",
      "generation",
    ];
    for (const shot of data.shots) {
      const rows = shotToRows(shot);
      expect(rows.shot.previous_shot_id).toBe(shot.continuity.previousShotId);
      expect(rows.shot.location_id).toBe(shot.spatial.locationId);
      expect(JSON.parse(rows.shot.audio as string)).not.toHaveProperty("dialogueLineIds");
      expect(rows.characters.map((r) => r.look_id)).toEqual(shot.characters.map((c) => c.lookId));
      const back = shotSchema.parse(
        shotFromRows(
          fromDb({ ...rows.shot, created_at: shot.createdAt, updated_at: shot.updatedAt }, sections),
          {
            characters: rows.characters,
            props: rows.props,
            lines: rows.lines,
            assets: rows.assets,
          },
        ),
      );
      expect(back).toEqual(shot);
    }
  });

  it("keeps dialogue link order and de-duplicates reference assets", () => {
    const shot = structuredClone(data.shots.find((s) => s.shotCode === "5A")!);
    shot.generation.referenceAssetIds = [data.assets[0].id, data.assets[0].id];
    const rows = shotToRows(shot);
    expect(rows.lines.map((l) => l.position)).toEqual([0, 1]);
    expect(rows.assets.filter((a) => a.role === "reference")).toHaveLength(1);
  });
});
