import { describe, expect, it } from "vitest";
import { buildShotContext } from "@/domain/context";
import { assembleGenerationPackage, briefToText, renderGenerationBrief } from "@/domain/generation-package";
import { seed, shotByCode } from "./helpers";

describe("generation package", () => {
  const data = seed();
  const pkg = assembleGenerationPackage(
    buildShotContext(data, shotByCode(data, "3A").id),
    new Date("2026-01-01T00:00:00Z"),
  );

  it("assembles story, character, look, set, camera, performance and timing", () => {
    expect(pkg.shot.code).toBe("3A");
    expect(pkg.characters[0].name).toBe("Yumeko");
    expect(pkg.characters[0].look?.name).toBe("Episode 1 — Formal Black");
    expect(pkg.characters[0].look?.wardrobe).toContain("satin");
    expect(pkg.characters[0].identityReferenceAssetIds).toHaveLength(4);
    expect(pkg.set?.name).toBe("Grand Celeste Lobby");
    expect(pkg.camera.lens).toBe("85mm");
    expect(pkg.performance[0].text).toBe("もう帰りたい……");
    expect(pkg.performance[0].selectedTake?.durationMs).toBe(2800);
    expect(pkg.timing.durationMs).toBe(4500);
    expect(pkg.timing.source).toBe("performance");
  });

  it("injects project guardrails and derived hard constraints", () => {
    expect(pkg.constraints.guardrails).toContain("Never invent additional companions.");
    expect(pkg.constraints.hard.join(" ")).toMatch(/Only these named characters appear: Yumeko/);
    expect(pkg.constraints.hard.join(" ")).toMatch(/locked Look/);
    expect(pkg.prompt.negative).toContain("Never invent additional companions.");
  });

  it("falls back to the approved storyboard frame as start frame and reports readiness", () => {
    expect(pkg.references.approvedStoryboardFrame).not.toBeNull();
    expect(pkg.references.startFrameAssetId).toBe(pkg.references.approvedStoryboardFrame?.assetId);
    expect(pkg.readiness.ready).toBe(true);
  });

  it("renders a readable brief", () => {
    const text = briefToText(renderGenerationBrief(pkg));
    expect(text).toContain("## Performance");
    expect(text).toContain("READY TO GENERATE");
    expect(text).toContain("Selected take #1");
  });
});
