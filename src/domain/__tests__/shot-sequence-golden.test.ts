import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ProjectData } from "@/domain/schemas";
import { buildShotSequence } from "@/domain/shot-sequence";
import { assignLook, attachLocks, lockFor, yumekoIvory } from "./character-continuity-fixtures";
import { seed, shotByCode } from "./helpers";
import { attachViews, locationOf, viewFor } from "./location-view-fixtures";
import { newUploadAsset } from "./production-frame-fixtures";

/**
 * Phase 3A.4A regression: the Sequence Board's transition comparison was extracted into the shared
 * `describeTransitionTruth` (domain/transition-truth.ts) so the cut domain reuses it. The board's observable output must
 * not change. The golden file was recorded from the board BEFORE that refactor; every scenario here must still produce
 * exactly it. Ids and fingerprints are random per run (fixtures use randomUUID), so they are replaced by stable labels
 * in order of first appearance; every message, category, severity and from / to value is compared verbatim.
 *
 * Re-recording is deliberate only: `PRISM_UPDATE_SEQUENCE_GOLDEN=1 npx vitest run <this file>`.
 */

const GOLDEN = path.join(__dirname, "fixtures", "shot-sequence-golden.json");
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^[0-9a-f]{64}$/;

function normalize(value: unknown): unknown {
  const labels = new Map<string, string>();
  const walk = (v: unknown): unknown => {
    if (typeof v === "string" && ID.test(v)) {
      if (!labels.has(v)) labels.set(v, `<id${labels.size + 1}>`);
      return labels.get(v);
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, walk((v as Record<string, unknown>)[k])]),
      );
    return v;
  };
  return walk(value);
}

/** What the board shows about each Shot's truth and every cut: the parts the refactor touches. */
function boardView(data: ProjectData) {
  const seq = buildShotSequence(data, data.episodes[0].id);
  return normalize({
    shots: seq.shots.map((s) => ({
      shotCode: s.shotCode,
      sceneId: s.sceneId,
      sceneNumber: s.sceneNumber,
      sceneSlugline: s.sceneSlugline,
      location: s.location,
      locationView: s.locationView,
      characters: s.characters,
      continuity: s.continuity,
      link: s.link,
    })),
    transitions: seq.transitions,
    summary: seq.summary,
  });
}

const id = (data: ProjectData, code: string) => shotByCode(data, code).id;

const SCENARIOS: Record<string, () => ProjectData> = {
  seed: () => seed(),
  links: () => {
    const data = seed();
    shotByCode(data, "1C").continuity.previousShotId = id(data, "1A");
    shotByCode(data, "1B").continuity.previousShotId = null;
    shotByCode(data, "1A").continuity.previousShotId = id(data, "1C");
    return data;
  },
  location_views: () => {
    const data = seed();
    const canopy = locationOf(data, "2A");
    const img = (label: string) => {
      const a = newUploadAsset(data.project.id, { label, width: 1200, height: 900 });
      a.purpose = "location_ref";
      data.assets.push(a);
      return a;
    };
    const wide = viewFor(data, canopy.id, img("wide"), { name: "Canopy Wide", kind: "establishing" });
    const door = viewFor(data, canopy.id, img("door"), { name: "Doorway", kind: "entrance" });
    attachViews(
      data,
      [wide, door],
      [
        { shotId: id(data, "2A"), view: wide },
        { shotId: id(data, "2B"), view: wide },
        { shotId: id(data, "2C"), view: door },
      ],
    );
    return data;
  },
  same_lock: () => {
    const data = seed();
    const { ivory } = yumekoIvory(data, "4C");
    assignLook(data, "5A", "Yumeko", ivory);
    const lockA = lockFor(data, "Yumeko", ivory, { name: "Ivory Suit v1" });
    attachLocks(
      data,
      [lockA],
      [
        { code: "4C", lock: lockA },
        { code: "5A", lock: lockA },
      ],
    );
    return data;
  },
  different_lock: () => {
    const data = seed();
    const { ivory } = yumekoIvory(data, "4C");
    assignLook(data, "5A", "Yumeko", ivory);
    const lockA = lockFor(data, "Yumeko", ivory, { name: "Ivory Suit v1" });
    ivory.hair = "loose waves";
    const lockB = lockFor(data, "Yumeko", ivory, { name: "Ivory Suit v2" });
    attachLocks(
      data,
      [lockA, lockB],
      [
        { code: "4C", lock: lockA },
        { code: "5A", lock: lockB },
      ],
    );
    return data;
  },
  lock_to_live: () => {
    const data = seed();
    const { ivory } = yumekoIvory(data, "4C");
    assignLook(data, "5A", "Yumeko", ivory);
    const lockA = lockFor(data, "Yumeko", ivory, { name: "Ivory Suit v1" });
    attachLocks(data, [lockA], [{ code: "4C", lock: lockA }]);
    return data;
  },
  look_change: () => {
    const data = seed();
    yumekoIvory(data, "5A");
    return data;
  },
  invalid_lock_selection: () => {
    const data = seed();
    const { ivory } = yumekoIvory(data, "4C");
    const lockA = lockFor(data, "Yumeko", ivory);
    attachLocks(data, [lockA], [{ code: "4C", lock: lockA }]);
    shotByCode(data, "4C").characters[0].lookId = null;
    return data;
  },
  declared_text: () => {
    const data = seed();
    shotByCode(data, "1C").spatial.screenDirection = "Right to left";
    shotByCode(data, "1B").spatial.facingDirection = "Facing camera";
    shotByCode(data, "1C").spatial.facingDirection = "Facing away";
    shotByCode(data, "3A").continuity.timeOfDay = "Dawn";
    shotByCode(data, "2B").continuity.weather = "Heavy rain";
    return data;
  },
};

describe("Sequence Board output is unchanged by the shared transition-truth refactor (golden)", () => {
  const record = process.env.PRISM_UPDATE_SEQUENCE_GOLDEN === "1";
  const actual = Object.fromEntries(Object.entries(SCENARIOS).map(([k, build]) => [k, boardView(build())]));

  if (record) {
    it("records the golden file", () => {
      writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`);
      expect(existsSync(GOLDEN)).toBe(true);
    });
    return;
  }

  const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as Record<string, unknown>;

  it("covers exactly the recorded scenarios", () => {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(golden).sort());
  });

  for (const name of Object.keys(SCENARIOS))
    it(`scenario "${name}" matches the pre-refactor board output exactly`, () => {
      expect(actual[name]).toEqual(golden[name]);
    });

  it("the golden file exercises every transition category and severity the board produces", () => {
    const facts = Object.values(golden).flatMap(
      (g) =>
        (g as { transitions: Array<{ changes: unknown[]; stable: unknown[] }> }).transitions.flatMap((t) => [
          ...t.changes,
          ...t.stable,
        ]) as Array<{ category: string; severity: string; message: string }>,
    );
    const pairs = new Set(facts.map((f) => `${f.category}:${f.severity}`));
    for (const p of [
      "sequence_link:error",
      "scene:change",
      "location:change",
      "location:stable",
      "location_view:change",
      "location_view:stable",
      "characters:change",
      "character_continuity:stable",
      "character_continuity:change",
      "look:change",
      "look:stable",
      "screen_direction:change",
      "weather:change",
      "time_of_day:change",
    ])
      expect(pairs, p).toContain(p);
    const messages = facts.map((f) => f.message);
    expect(messages.some((m) => m.startsWith("Facing direction changes:"))).toBe(true);
    expect(messages.some((m) => m.includes("appearance authority changes"))).toBe(true);
    expect(messages.some((m) => m.endsWith(" enters"))).toBe(true);
    expect(messages.some((m) => m.endsWith(" exits"))).toBe(true);
  });
});
