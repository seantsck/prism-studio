import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAnalysisProviders } from "../../../src/continuity/analysis/registry";
import { previewAnalysis } from "../../../src/continuity/analysis/prepare";
import { computeQaInputs } from "../../../src/continuity/service";
import { buildSyntheticFixture, FIXTURE_SLUG, LEGACY_FIXTURE_SLUG } from "../continuity-fixture.mjs";
import { renderSyntheticCharacter } from "../synthetic-character.mjs";

const USER = "00000000-0000-4000-8000-000000000001";
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

describe("semantic synthetic continuity fixture", () => {
  const fx = buildSyntheticFixture({ userId: USER });
  const byPurpose = (p: string) => fx.data.assets.find((a) => a.purpose === p)!;

  it("uses its own slug; the legacy abstract fixture keeps its slug (Run 5 history is never touched)", () => {
    expect(fx.slug).toBe(FIXTURE_SLUG);
    expect(fx.data.project.slug).toBe("continuity-semantic-test");
    expect(LEGACY_FIXTURE_SLUG).toBe("continuity-smoke-test");
    expect(buildSyntheticFixture({ userId: USER, variant: "abstract" }).data.project.slug).toBe(
      LEGACY_FIXTURE_SLUG,
    );
  });

  it("draws three distinct real PNGs: identity (grey top), Look (black), output (red) of ONE character", () => {
    const sums = ["identity_ref", "look_ref", "generation_output"].map((p) => byPurpose(p).checksum);
    expect(new Set(sums).size).toBe(3);
    for (const a of fx.data.assets) {
      const bytes = fx.bytes.get(a.id)!;
      expect([...bytes.slice(0, 8)]).toEqual(PNG);
      expect(sha(bytes)).toBe(a.checksum);
      expect(a.width).toBe(768);
      expect(a.height).toBe(432);
    }
    expect(fx.pictures.identity).toMatch(/shoulder-length hair, round glasses and a blue scarf.*grey top/);
    expect(fx.pictures.look).toMatch(/black formal jacket/);
    expect(fx.pictures.output).toMatch(/red formal jacket/);
    // the same character in identity/look/output
    for (const p of [fx.pictures.identity, fx.pictures.look, fx.pictures.output])
      expect(p).toMatch(/round glasses and a blue scarf/);
  });

  it("is deterministic: the same inputs give identical bytes", { timeout: 60_000 }, () => {
    const a = renderSyntheticCharacter({ character: "A", outfit: "red" });
    const b = renderSyntheticCharacter({ character: "A", outfit: "red" });
    expect(sha(a.png)).toBe(sha(b.png));
    expect(sha(a.png)).not.toBe(sha(renderSyntheticCharacter({ character: "A", outfit: "black" }).png));
    expect(sha(a.png)).toBe(byPurpose("generation_output").checksum);
  });

  it("--mismatch swaps in a DIFFERENT character, not a different outfit only", { timeout: 60_000 }, () => {
    const m = buildSyntheticFixture({ userId: USER, mismatch: true });
    expect(m.pictures.output).toMatch(/different fictional adult/);
    expect(m.data.assets.find((a) => a.purpose === "generation_output")!.checksum).not.toBe(
      byPurpose("generation_output").checksum,
    );
  });

  it("Prism supplies production truth only; no expected verdict is written anywhere in the project data", () => {
    const look = fx.data.looks[0]!;
    expect(look.name).toBe("Black Formal Look");
    expect(look.wardrobe).toBe("Black formal jacket over a white shirt.");
    const blob = JSON.stringify({ ...fx.data, attempts: fx.data.attempts });
    expect(blob).not.toMatch(/\bred\b/i);
    expect(blob).not.toMatch(
      /\b(should|must) (pass|fail)\b|expected (result|pass|fail)|\bwardrobe[^"]{0,20}fail/i,
    );
  });

  it("plans exactly identity + wardrobe as one bounded image set, within the $0.10 ceiling", () => {
    const trap = (async () => {
      throw new Error("no network in a planning test");
    }) as unknown as typeof fetch;
    const providers = createAnalysisProviders(
      {
        PRISM_STUDIO_CONTINUITY_ANALYZERS: "mock,openai",
        OPENAI_API_KEY: "placeholder-not-a-credential",
        PRISM_STUDIO_ANALYSIS_MAX_TRANSPORT_CALLS: "4",
      },
      { fetchImpl: trap },
    );
    const inputs = computeQaInputs({ data: fx.data, view: fx.view, delivery: null })!;
    const prev = previewAnalysis({
      inputs,
      assets: fx.data.assets,
      output: { frames: [], contactSheet: null },
      subject: inputs.subject!,
      provider: providers.get("openai")!,
      policy: { enabled: true, maxUsdPerRun: 0.1, maxUsdPerDay: null },
      spentLast24hUsd: 0,
      now: new Date(),
    });
    expect(prev.preview.summary.analysed).toBe(2);
    expect(prev.preview.mode).toBe("image_set");
    expect(prev.preview.summary.requests).toBe(2);
    expect(prev.preview.summary.referencesSent).toBe(2);
    expect(prev.preview.summary.outputImagesSent).toBe(1);
    expect(prev.preview.estimate.maxUsd).toBeGreaterThan(0);
    expect(prev.preview.estimate.maxUsd).toBeLessThan(0.1);
    // 2 requests + 1 correction must fit the proposed smoke ceiling of 4 transport calls
    expect(prev.preview.summary.requests + 1).toBeLessThanOrEqual(4);
  });
});
