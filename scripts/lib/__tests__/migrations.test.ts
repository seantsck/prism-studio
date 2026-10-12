import { describe, expect, it } from "vitest";
import { MISMATCH_MESSAGE, assertPlanSafe, checksumOf, planMigrations } from "../migrations.mjs";

const f = (name: string, sql = "select 1;") => ({ name, sql });

describe("migration integrity", () => {
  it("checksums are stable and line-ending independent", () => {
    expect(checksumOf("a\nb\n")).toBe(checksumOf("a\r\nb\r\n"));
    expect(checksumOf("a")).not.toBe(checksumOf("b"));
    expect(checksumOf("x")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("plans only unapplied files, in name order", () => {
    const plan = planMigrations(
      [f("0003_c.sql"), f("0001_a.sql"), f("0002_b.sql")],
      [{ name: "0001_a.sql", checksum: checksumOf("select 1;") }],
    );
    expect(plan.pending.map((p) => p.name)).toEqual(["0002_b.sql", "0003_c.sql"]);
    expect(plan.mismatched).toEqual([]);
    expect(() => assertPlanSafe(plan)).not.toThrow();
  });

  it("refuses to proceed when an applied migration changed on disk", () => {
    const plan = planMigrations(
      [f("0001_a.sql", "select 2;")],
      [{ name: "0001_a.sql", checksum: checksumOf("select 1;") }],
    );
    expect(plan.mismatched).toEqual(["0001_a.sql"]);
    expect(() => assertPlanSafe(plan)).toThrow(MISMATCH_MESSAGE);
    expect(MISMATCH_MESSAGE).toBe("Applied migration has changed on disk. Create a new migration instead.");
  });

  it("reports migrations applied before checksums existed as needing a baseline", () => {
    const plan = planMigrations([f("0001_a.sql")], [{ name: "0001_a.sql", checksum: null }]);
    expect(plan.unrecorded).toEqual(["0001_a.sql"]);
    expect(plan.mismatched).toEqual([]);
  });

  it("flags applied migrations whose file is gone and out-of-order pending files", () => {
    const gone = planMigrations([], [{ name: "0001_a.sql", checksum: "x" }]);
    expect(gone.missingOnDisk).toEqual(["0001_a.sql"]);
    expect(() => assertPlanSafe(gone)).toThrow(/missing on disk/);
    const ooo = planMigrations(
      [f("0001_a.sql"), f("0002_b.sql"), f("0003_c.sql")],
      [
        { name: "0001_a.sql", checksum: checksumOf("select 1;") },
        { name: "0003_c.sql", checksum: checksumOf("select 1;") },
      ],
    );
    expect(ooo.outOfOrder).toEqual(["0002_b.sql"]);
    expect(() => assertPlanSafe(ooo)).toThrow(/before an applied/);
  });
});
