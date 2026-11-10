import { describe, expect, it } from "vitest";
import { seedWithFrame } from "@/domain/__tests__/production-frame-fixtures";
import { shotByCode } from "@/domain/__tests__/helpers";
import { buildShotContext } from "@/domain/context";
import { assembleGenerationPackage, type GenerationPackage } from "@/domain/generation-package";
import {
  adaptAnimationProviderPrompt,
  adaptProviderPrompt,
  providerPromptPolicyFor,
  VISIBLE_MOTION_POLICY,
  type ProviderPromptPolicyChoice,
} from "@/domain/generation/provider-prompt";

/** The hosted DEV Shot 3A story wording (composure language) applied to the seed Shot, in memory only. */
function shot3a(wording: "composure" | "mask" = "composure") {
  const { data } = seedWithFrame("3A");
  const shot = shotByCode(data, "3A");
  if (wording === "composure") {
    shot.action = {
      ...shot.action,
      beginningPose: "Neutral, composed, guarded expression",
      endingPose: "Eyes open, composure restored",
    };
    shot.characters = shot.characters.map((c) => ({ ...c, expression: "Composure slips; exhausted" }));
  }
  const pkg = assembleGenerationPackage(buildShotContext(data, shot.id));
  return { data, shot, pkg };
}

const TURBO = { provider: "runway", modelId: "gen4_turbo", purpose: "animate_production_frame" } as const;
const adapt = (pkg: GenerationPackage) => adaptProviderPrompt(pkg, TURBO)!;
const withBudget = (pkg: GenerationPackage, limit: number, target: number) =>
  adaptAnimationProviderPrompt(pkg, {
    ...TURBO,
    choice: { policy: VISIBLE_MOTION_POLICY, budget: { limit, target } } satisfies ProviderPromptPolicyChoice,
  });

describe("provider-prompt adaptation: visible-motion v1 (Phase 5B)", () => {
  it("applies to Runway Gen-4 Turbo animation only, with a target well below the provider limit", () => {
    expect(providerPromptPolicyFor(TURBO)).toEqual({
      policy: { id: "visible-motion", version: 1 },
      budget: { limit: 1000, target: 900 },
    });
    expect(providerPromptPolicyFor({ ...TURBO, purpose: "shot_output" })).toBeNull();
    expect(providerPromptPolicyFor({ ...TURBO, modelId: "gen4.5" })).toBeNull();
    expect(adaptProviderPrompt(shot3a().pkg, { ...TURBO, purpose: "production_frame" })).toBeNull();
  });

  it("turns abstract story language into concrete visible behaviour", () => {
    const p = adapt(shot3a("composure").pkg);
    expect(p.text).toContain("She begins with a calm, guarded, neutral expression.");
    expect(p.text).toContain("Her expression briefly softens, she looks visibly exhausted");
    expect(p.text).toContain("her shoulders lower subtly");
    expect(p.text).toContain("she closes her eyes briefly and she breathes naturally.");
    expect(p.text).toContain("Then her eyes open and she returns to a calm, controlled neutral expression.");
    expect(p.adaptations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "Composure slips", rule: "slip-softens" }),
        expect.objectContaining({ source: "composure restored", rule: "restore-to-neutral" }),
        expect.objectContaining({ source: "exhausted", rule: "exhaustion-visible" }),
        expect.objectContaining({ source: "Shoulders fall", rule: "shoulders-lower" }),
      ]),
    );
  });

  it("translates the figurative mask wording the same way (never sends 'mask' or 'composure')", () => {
    for (const wording of ["mask", "composure"] as const) {
      const p = adapt(shot3a(wording).pkg);
      expect(p.text).not.toMatch(/\bmask(ed|s)?\b/i);
      expect(p.text).not.toMatch(/\bcomposure\b/i);
      expect(p.text).toContain("returns to a calm, controlled neutral expression");
      expect(p.text).toContain("expression briefly softens");
    }
  });

  it("other abstract states become visible behaviour; an untranslatable figurative note is omitted and recorded", () => {
    const { pkg } = shot3a();
    const variant: GenerationPackage = {
      ...pkg,
      characters: pkg.characters.map((c) => ({
        ...c,
        expression: "Tense; hesitates",
        posture: "Confident",
        gestures: "Hides behind a social mask",
      })),
    };
    const p = adapt(variant);
    expect(p.text).toContain("She shows visible tension in her jaw and shoulders");
    expect(p.text).toContain("she pauses briefly before moving");
    expect(p.text).toContain("she holds an upright posture and a steady gaze");
    expect(p.text).not.toMatch(/mask/i);
    expect(p.adaptations).toContainEqual(
      expect.objectContaining({
        source: "Hides behind a social mask",
        provider: null,
        rule: "figurative-omitted",
      }),
    );
  });

  it("leaves the authoritative story data untouched", () => {
    const { data, shot, pkg } = shot3a();
    const before = JSON.stringify(data);
    const pkgBefore = JSON.stringify(pkg);
    adapt(pkg);
    withBudget(pkg, 1000, 200);
    expect(JSON.stringify(data)).toBe(before);
    expect(JSON.stringify(pkg)).toBe(pkgBefore);
    expect(shot.action.endingPose).toBe("Eyes open, composure restored");
    expect(pkg.timing.endingPose).toBe("Eyes open, composure restored");
  });

  it("keeps internal metadata out of the provider prompt (it stays in provenance)", () => {
    const { pkg } = shot3a();
    const p = adapt(pkg);
    expect(p.text).not.toContain(pkg.shot.code);
    expect(p.text).not.toContain(pkg.shot.title);
    expect(p.text).not.toMatch(/Production Frame/i);
    expect(p.text).not.toMatch(/\(v\d+\)/);
    expect(p.text).not.toMatch(/Purpose:/);
    expect(p.text).not.toMatch(/\d+\s*\/\s*10\b/);
    expect(p.text).not.toMatch(/aspect ratio|2\.39/i);
    expect(p.text).not.toContain(pkg.storyIntent.dramaticPurpose);
    for (const c of pkg.characters) if (c.look) expect(p.text).not.toContain(c.look.name);
    expect(p.text).not.toMatch(/[぀-ヿ]/); // no dialogue text
    expect(p.excluded).toEqual(
      expect.arrayContaining([
        "Production Frame version",
        "performance intensity score",
        "Shot code and title",
      ]),
    );
  });

  it("Shot 3A states orientation, eyeline, no camera look, the calm ending and full continuity", () => {
    const p = adapt(shot3a().pkg);
    expect(p.text).toContain(
      "She keeps her head turned toward screen-right with her eyes down and away throughout and never looks into the camera.",
    );
    expect(p.text).toContain("Keep the camera locked at eye level with no push-in, pan or reframing.");
    expect(p.text).toContain("She stands at the elevator, back to the lobby.");
    expect(p.text).toMatch(
      /Preserve the starting composition and her identity, apparent age, facial structure, hairstyle \(.+\), wardrobe \(.+\), jewelry \(.+\), lighting and background exactly as in the first frame\./,
    );
    expect(p.text).toContain("Do not introduce new objects or people.");
    expect(p.text).not.toMatch(/distress|worried/i);
    expect(p.adaptations).toContainEqual(
      expect.objectContaining({ field: "camera.movement", rule: "imperceptible-movement-locked" }),
    );
  });

  it("is deterministic for an identical package", () => {
    const { data, shot } = shot3a();
    const a = adapt(assembleGenerationPackage(buildShotContext(data, shot.id)));
    const b = adapt(assembleGenerationPackage(buildShotContext(data, shot.id)));
    expect(b).toEqual(a);
    // a separately seeded project with the same story gets the same prose (only its source fingerprint differs)
    expect(adapt(shot3a().pkg).text).toBe(a.text);
  });

  it("a changed story changes the derived prompt and its source fingerprint", () => {
    const { data, shot } = shot3a();
    const before = adapt(assembleGenerationPackage(buildShotContext(data, shot.id)));
    shot.action = { ...shot.action, endingPose: "Eyes closed, calm" };
    const after = adapt(assembleGenerationPackage(buildShotContext(data, shot.id)));
    expect(after.sourceFingerprint).not.toBe(before.sourceFingerprint);
    expect(after.text).not.toBe(before.text);
    expect(after.text).toContain("Then her eyes closed and she settles into a calm expression.");
  });

  it("stays under the Runway limit and the policy target, and records every section's fate", () => {
    const p = adapt(shot3a().pkg);
    expect(p.ok).toBe(true);
    expect(p.length).toBe(p.text.length);
    expect(p.length).toBeLessThanOrEqual(p.budget.target);
    expect(p.length).toBeLessThanOrEqual(1000);
    expect(p.sections.filter((s) => s.required).every((s) => s.included)).toBe(true);
    expect(p.sections.map((s) => s.key)).toEqual([
      "subject",
      "visible_action",
      "performance",
      "camera",
      "composition",
      "continuity",
      "look_detail",
      "setting",
    ]);
  });

  it("drops optional sections whole, in priority order, deterministically — never a sentence part-way", () => {
    const { pkg } = shot3a();
    const all = withBudget(pkg, 5000, 5000);
    expect(all.omitted).toEqual([]);
    const required = withBudget(pkg, 1000, 1);
    expect(required.omitted.map((o) => o.key)).toEqual(["performance", "look_detail", "setting"]);
    // with room for exactly one optional section, the highest-priority one is chosen
    const perf = all.sections.find((s) => s.key === "performance")!;
    const one = withBudget(pkg, 1000, required.length + 1 + perf.length);
    expect(one.sections.filter((s) => !s.required && s.included).map((s) => s.key)).toEqual(["performance"]);
    expect(one.omitted.map((o) => o.key)).toEqual(["look_detail", "setting"]);
    expect(withBudget(pkg, 1000, required.length + 1 + perf.length)).toEqual(one);
    // every kept sentence is whole: the text is exactly the full sentences of the included sections
    for (const p of [all, required, one]) {
      expect(p.text.endsWith(".")).toBe(true);
      for (const sentence of all.text.split(/(?<=\.)\s+/)) {
        if (p.text.includes(sentence.slice(0, 20))) expect(p.text).toContain(sentence);
      }
    }
  });

  it("refuses (never truncates) when the required content alone exceeds the provider limit", () => {
    const p = withBudget(shot3a().pkg, 300, 300);
    expect(p.ok).toBe(false);
    expect(p.problem).toMatch(/accepts at most 300/);
    expect(p.length).toBeGreaterThan(300); // the full required text is kept for inspection, not cut
    expect(p.text.endsWith(".")).toBe(true);
  });
});
