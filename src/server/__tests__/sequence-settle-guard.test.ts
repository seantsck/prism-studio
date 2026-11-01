import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SEQUENCE_SETTLE_MS } from "@/domain/continuity/sequence-automation";

/**
 * Phase 3A.4F: `PRISM_STUDIO_E2E_SEQUENCE_SETTLE_MS` exists so a browser test need not wait 10 minutes. It may shorten
 * settling only in memory persistence AND with the fake analysis transports. Anything else keeps the frozen window.
 */
// each case re-imports the server module fresh, and the first import is slow
vi.setConfig({ testTimeout: 120_000 });
vi.mock("server-only", () => ({}));
const settle = async (env: Record<string, string>) => {
  vi.resetModules();
  vi.stubEnv("PRISM_STUDIO_E2E_SEQUENCE_SETTLE_MS", "");
  vi.stubEnv("PRISM_STUDIO_PERSISTENCE", "");
  vi.stubEnv("PRISM_STUDIO_ANALYSIS_TRANSPORT", "");
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return (await import("../media-qa")).getSequenceSettleMs();
};
afterEach(() => vi.unstubAllEnvs());

const OVERRIDE = { PRISM_STUDIO_E2E_SEQUENCE_SETTLE_MS: "15000" };
const MEMORY = { PRISM_STUDIO_PERSISTENCE: "memory" };
const SUPABASE = { PRISM_STUDIO_PERSISTENCE: "supabase" };
const FAKE = { PRISM_STUDIO_ANALYSIS_TRANSPORT: "fake" };

describe("the E2E settle override", () => {
  it("the production default is exactly 10 minutes", async () => {
    expect(SEQUENCE_SETTLE_MS).toBe(600_000);
    expect(await settle({})).toBe(600_000);
  });

  it("applies only in memory mode with the fake transport", async () => {
    expect(await settle({ ...OVERRIDE, ...MEMORY, ...FAKE })).toBe(15_000);
  });

  it("never in Supabase / Postgres persistence, even with the fake-transport variable", async () => {
    expect(await settle({ ...OVERRIDE, ...SUPABASE, ...FAKE })).toBe(600_000);
    expect(await settle({ ...OVERRIDE, ...SUPABASE })).toBe(600_000);
  });

  it("never on a real transport, even in memory mode", async () => {
    expect(await settle({ ...OVERRIDE, ...MEMORY })).toBe(600_000);
    expect(await settle({ ...OVERRIDE, ...MEMORY, PRISM_STUDIO_ANALYSIS_TRANSPORT: "real" })).toBe(600_000);
  });

  it.each(["0", "-5", "abc", "Infinity", ""])("ignores the invalid value %j", async (v) => {
    expect(await settle({ PRISM_STUDIO_E2E_SEQUENCE_SETTLE_MS: v, ...MEMORY, ...FAKE })).toBe(600_000);
  });

  it("no other code reads it: the domain and the provider path never see the variable", () => {
    for (const file of [
      "src/domain/continuity/sequence-automation.ts",
      "src/continuity/sequence-automation.ts",
      "src/continuity/providers/gemini/analyzer.ts",
      "src/continuity/providers/gemini/config.ts",
      "src/continuity/providers/gemini/sdk-transport.ts",
    ])
      expect(readFileSync(file, "utf8"), file).not.toContain("PRISM_STUDIO_E2E_SEQUENCE_SETTLE_MS");
  });
});
