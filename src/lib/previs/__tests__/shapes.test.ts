import { describe, expect, it } from "vitest";
import { createMannequinGeometry } from "../shapes";

describe("neutral mannequin", () => {
  it("is a procedural, human-scale proxy standing on the ground (origin at the feet)", () => {
    const g = createMannequinGeometry();
    const box = g.boundingBox!;
    expect(box.min.y).toBeGreaterThanOrEqual(-0.001);
    expect(box.min.y).toBeLessThan(0.05);
    expect(box.max.y).toBeGreaterThan(1.7);
    expect(box.max.y).toBeLessThan(1.85);
    expect(box.max.x - box.min.x).toBeLessThan(0.8);
  });

  it("is deterministic and carries no external asset", () => {
    const a = createMannequinGeometry().getAttribute("position");
    const b = createMannequinGeometry().getAttribute("position");
    expect(a.count).toBe(b.count);
    expect(Array.from(a.array.slice(0, 60))).toEqual(Array.from(b.array.slice(0, 60)));
  });
});
