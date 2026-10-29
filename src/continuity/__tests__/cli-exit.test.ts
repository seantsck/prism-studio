import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EXIT_GRACE_MS, exitGracefully, type ExitTarget } from "../calibration/cli-exit";

/**
 * The calibration and smoke wrappers end the process by setting `exitCode`, never by `process.exit` mid-teardown
 * (which aborted on Windows with a libuv UV_HANDLE_CLOSING assertion after a valid report was written).
 */
describe("graceful CLI exit", () => {
  const fake = () => {
    const exits: number[] = [];
    const timers: { fn: () => void; ms: number; unref: boolean }[] = [];
    const target: ExitTarget = { exitCode: undefined, exit: (c) => void exits.push(c) };
    const schedule = (fn: () => void, ms: number) => {
      const t = { fn, ms, unref: false };
      timers.push(t);
      return { unref: () => (t.unref = true) };
    };
    return { exits, timers, target, schedule };
  };

  for (const code of [0, 1, 2, 3])
    it(`code ${code}: sets exitCode, does not exit immediately, and only an unref'd fallback can force it`, () => {
      const f = fake();
      exitGracefully(code, f.target, f.schedule);
      expect(f.target.exitCode).toBe(code);
      expect(f.exits).toEqual([]);
      expect(f.timers).toHaveLength(1);
      expect(f.timers[0]!.unref).toBe(true); // never keeps the event loop alive by itself
      expect(f.timers[0]!.ms).toBe(EXIT_GRACE_MS);
      f.timers[0]!.fn(); // a handle that never closed: the fallback exits with the SAME code
      expect(f.exits).toEqual([code]);
    });

  for (const script of ["continuity-temporal-smoke.mts", "continuity-temporal-calibration.mts"])
    it(`${script} ends through exitGracefully, never process.exit`, () => {
      const src = readFileSync(`scripts/${script}`, "utf8");
      expect(src).toContain('import { exitGracefully } from "../src/continuity/calibration/cli-exit";');
      expect(src).toContain("(code) => exitGracefully(code)");
      expect(src).toContain("exitGracefully(1);");
      expect(src).not.toMatch(/process\.exit\(/);
    });
});
