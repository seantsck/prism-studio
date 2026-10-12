import { describe, expect, it } from "vitest";
import { ReorderError, reorderShotsInScene } from "@/domain/ordering";
import { seed } from "./helpers";

describe("shot ordering", () => {
  const scene2 = () => {
    const data = seed();
    const sceneId = data.shots.find((s) => s.shotCode === "2A")!.sceneId;
    return data.shots.filter((s) => s.sceneId === sceneId);
  };

  it("moves a shot within its scene with contiguous order", () => {
    const shots = scene2();
    const result = reorderShotsInScene(shots, shots.find((s) => s.shotCode === "2E")!.id, 0);
    expect(result.map((s) => s.shotCode)).toEqual(["2E", "2A", "2B", "2C", "2D"]);
    expect(result.map((s) => s.order)).toEqual([0, 1, 2, 3, 4]);
  });

  it("refuses to move locked shots and keeps them pinned", () => {
    const shots = scene2().map((s) => (s.shotCode === "2B" ? { ...s, status: "locked" as const } : s));
    expect(() => reorderShotsInScene(shots, shots.find((s) => s.shotCode === "2B")!.id, 0)).toThrow(
      ReorderError,
    );
    const result = reorderShotsInScene(shots, shots.find((s) => s.shotCode === "2E")!.id, 0);
    expect(result[1].shotCode).toBe("2B");
    expect(result[0].shotCode).toBe("2E");
  });

  it("treats the target as an absolute position when a locked shot sits in between", () => {
    const shots = scene2().map((s) => (s.shotCode === "2B" ? { ...s, status: "locked" as const } : s));
    // 2A,[2B locked],2C,2D,2E — move 2A to absolute index 2: it takes the first unlocked slot at/after it.
    const result = reorderShotsInScene(shots, shots.find((s) => s.shotCode === "2A")!.id, 2);
    expect(result.map((s) => s.shotCode)).toEqual(["2C", "2B", "2A", "2D", "2E"]);
  });

  it("rejects shots spanning scenes", () => {
    const data = seed();
    expect(() => reorderShotsInScene(data.shots.slice(0, 5), data.shots[0].id, 1)).toThrow(ReorderError);
  });
});
