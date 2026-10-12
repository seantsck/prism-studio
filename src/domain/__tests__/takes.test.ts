import { describe, expect, it } from "vitest";
import { findSelectionViolations, nextTakeNumber, selectTake } from "@/domain/takes";
import { seed, shotByCode } from "./helpers";

describe("canonical take selection", () => {
  it("keeps exactly one selected take per line", () => {
    const data = seed();
    const lineId = shotByCode(data, "3A").audio.dialogueLineIds[0];
    const target = data.takes.find((t) => t.dialogueLineId === lineId && t.takeNumber === 3)!;
    const next = selectTake(data.takes, target.id);
    const forLine = next.filter((t) => t.dialogueLineId === lineId);
    expect(forLine.filter((t) => t.selected).map((t) => t.takeNumber)).toEqual([3]);
    expect(findSelectionViolations(next)).toEqual([]);
  });

  it("does not touch takes of other lines", () => {
    const data = seed();
    const lineId = shotByCode(data, "3A").audio.dialogueLineIds[0];
    const target = data.takes.find((t) => t.dialogueLineId === lineId && t.takeNumber === 2)!;
    const next = selectTake(data.takes, target.id);
    const others = (ts: typeof data.takes) => ts.filter((t) => t.dialogueLineId !== lineId);
    expect(others(next)).toEqual(others(data.takes));
  });

  it("detects violations and numbers new takes sequentially", () => {
    const data = seed();
    const lineId = shotByCode(data, "3A").audio.dialogueLineIds[0];
    const broken = data.takes.map((t) => (t.dialogueLineId === lineId ? { ...t, selected: true } : t));
    expect(findSelectionViolations(broken)).toEqual([lineId]);
    expect(nextTakeNumber(data.takes, lineId)).toBe(4);
  });
});
