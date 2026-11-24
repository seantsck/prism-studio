import { describe, expect, it } from "vitest";
import { buildCoverArtPlan, COVER_CAST_MAX, coverPictureOfLocation, defaultCoverCast } from "../cover-art";
import { seed } from "../../__tests__/helpers";

/** Cover art's prompt plan: the project's own words, its leads' canonical pictures, and never any lettering. */
describe("cover art plan", () => {
  it("is made from the title, premise, tone and style, asks for no lettering, and features the leads", () => {
    const data = seed();
    const plan = buildCoverArtPlan(data, { direction: "Rain and neon." });
    expect(plan.positive).toContain(`"${data.project.title}"`);
    expect(plan.positive).toContain("No lettering of any kind in the image.");
    expect(plan.positive).toContain("Rain and neon.");
    expect(plan.negative).toMatch(/^text, letters, title/);
    const cast = defaultCoverCast(data);
    expect(cast.length).toBeGreaterThan(0);
    expect(cast.length).toBeLessThanOrEqual(COVER_CAST_MAX);
    for (const id of cast) expect(plan.positive).toContain(data.characters.find((c) => c.id === id)!.name);
  });

  it("sends only stored canonical pictures, within what the model takes; with none, it is made from words", () => {
    const data = seed();
    const none = buildCoverArtPlan(data, { direction: "" }, { maxReferences: 0 });
    expect(none.references).toHaveLength(0);
    expect(none.operation).toBe("text");
    const all = buildCoverArtPlan(data, { direction: "" });
    expect(all.references.every((r) => data.assets.some((a) => a.id === r.assetId && a.objectPath))).toBe(
      true,
    );
  });

  it("refuses a character that is not in the project", () => {
    expect(() => buildCoverArtPlan(seed(), { direction: "", castIds: ["nobody"] })).toThrow(
      /no longer in this project/,
    );
  });
});

describe("cover art: the creator's cast and place", () => {
  it("features exactly the characters chosen, in order, and none when none are", () => {
    const data = seed();
    const [a, b] = data.characters;
    const plan = buildCoverArtPlan(data, { direction: "", castIds: [b!.id, a!.id] });
    expect(plan.packageSnapshot.cast).toEqual([
      { id: b!.id, name: b!.name },
      { id: a!.id, name: a!.name },
    ]);
    const none = buildCoverArtPlan(data, { direction: "", castIds: [] });
    expect(none.packageSnapshot.cast).toEqual([]);
    expect(none.plan.sections.some((x) => x.key === "identity")).toBe(false);
  });

  it("sets it in the location chosen, sending its picture after the cast's when it has one", () => {
    const data = seed();
    const place = data.locations[0]!;
    const plan = buildCoverArtPlan(data, { direction: "", castIds: [], locationId: place.id });
    expect(plan.positive).toContain(`Set in ${place.name}`);
    expect(plan.packageSnapshot.location).toEqual({ id: place.id, name: place.name });
    const picture = coverPictureOfLocation(data, place.id);
    expect(plan.references.map((r) => r.assetId)).toEqual(picture ? [picture] : []);
    expect(() => buildCoverArtPlan(data, { direction: "", locationId: "gone" })).toThrow(/location/);
  });
});
