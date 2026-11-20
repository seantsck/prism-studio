import { describe, expect, it } from "vitest";
import { seedWithFrame } from "@/domain/__tests__/production-frame-fixtures";
import { shotByCode } from "@/domain/__tests__/helpers";
import { buildShotContext } from "@/domain/context";
import { assembleGenerationPackage, type GenerationPackage } from "@/domain/generation-package";
import {
  adaptAnimationProviderPrompt,
  adaptAnimationProviderPromptV2,
  adaptProviderPrompt,
  negativePhrasing,
  notesNotSent,
  parseFrozenProviderPrompt,
  providerPromptPolicyFor,
  VISIBLE_MOTION_POLICY,
  VISIBLE_MOTION_V2_POLICY,
  type ProviderPromptPolicyChoice,
} from "@/domain/generation/provider-prompt";
import { seed } from "@/domain/__tests__/helpers";

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
const withBudget = (pkg: GenerationPackage, limit: number, target: number) =>
  adaptAnimationProviderPrompt(pkg, {
    ...TURBO,
    choice: { policy: VISIBLE_MOTION_POLICY, budget: { limit, target } } satisfies ProviderPromptPolicyChoice,
  });
/** visible-motion v1 exactly as attempts froze it (limit 1000, target 900): historical, derived on request for audit. */
const v1 = (pkg: GenerationPackage, modelId: "gen4_turbo" | "gen4.5" = "gen4_turbo") =>
  adaptAnimationProviderPrompt(pkg, {
    ...TURBO,
    modelId,
    choice: { policy: VISIBLE_MOTION_POLICY, budget: { limit: 1000, target: 900 } },
  });
const adapt = (pkg: GenerationPackage) => v1(pkg);

describe("provider-prompt policy table", () => {
  it("Runway Gen-4 Turbo and Gen-4.5 animation use visible-motion v2, with a target far below the provider limit", () => {
    expect(providerPromptPolicyFor(TURBO)).toEqual({
      policy: { id: "visible-motion", version: 2 },
      budget: { limit: 1000, target: 600 },
    });
    expect(providerPromptPolicyFor({ ...TURBO, purpose: "shot_output" })).toBeNull();
    expect(providerPromptPolicyFor({ ...TURBO, modelId: "gen4.5" })).toEqual({
      policy: { id: "visible-motion", version: 2 },
      budget: { limit: 1000, target: 600 },
    });
    expect(providerPromptPolicyFor({ ...TURBO, modelId: "veo3.1_fast" })).toBeNull();
    expect(adaptProviderPrompt(shot3a().pkg, { ...TURBO, purpose: "production_frame" })).toBeNull();
    expect(adaptProviderPrompt(shot3a().pkg, TURBO)!.policy).toEqual(VISIBLE_MOTION_V2_POLICY);
  });
});

describe("provider-prompt adaptation: visible-motion v1 (historical; still derivable for audit)", () => {
  it("turns abstract story language into concrete visible behaviour", () => {
    const p = adapt(shot3a("composure").pkg);
    expect(p.text).toContain("She begins calm, guarded and neutral.");
    expect(p.text).toContain("Her expression briefly softens, she looks visibly exhausted");
    expect(p.text).toContain("her shoulders lower subtly and she closes her eyes briefly.");
    expect(p.text).toContain("Then her eyes open and she ends calm and neutral.");
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
      expect(p.text).toContain("she ends calm and neutral");
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
      "She keeps the first frame's three-quarter orientation toward screen-right: head and torso stay screen-right, never rotating through frontal or toward screen-left, her eyes down and away, never looking into the camera.",
    );
    expect(p.text).toContain("Keep the camera locked at eye level with no push-in, pan or reframing.");
    // image-to-video: the first frame establishes the composition; the blocking sentence is optional, dropped whole here
    expect(p.text).not.toContain("She stands at the elevator");
    expect(p.omitted).toContainEqual({ key: "composition", label: "Composition", reason: "over_budget" });
    expect(p.text).toContain(
      "Preserve her identity, apparent age, facial structure, sleek low chignon, floor-length black satin evening gown, mother's pearl drop earrings, lighting and background.",
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

  describe("held orientation (a Gen-4.5 Shot 3A take turned through frontal to screen-left)", () => {
    const withBlocking = (pkg: GenerationPackage, blocking: Partial<GenerationPackage["blocking"]>) =>
      v1({ ...pkg, blocking: { ...pkg.blocking, ...blocking } }, "gen4.5");
    const g45 = () => v1(shot3a().pkg, "gen4.5");

    it("pins head AND torso to the first frame's three-quarter screen-right orientation", () => {
      const t = g45().text;
      expect(t).toContain("keeps the first frame's three-quarter orientation toward screen-right");
      expect(t).toContain("head and torso stay screen-right");
    });

    it("explicitly prohibits rotating through frontal and turning toward screen-left", () => {
      const t = g45().text;
      expect(t).toContain("never rotating through frontal or toward screen-left");
      expect(t.match(/screen-left/g)).toHaveLength(1); // screen-left is only ever named as prohibited
    });

    it("keeps the eyes down and away and never looks into the camera", () => {
      expect(g45().text).toContain("her eyes down and away, never looking into the camera");
    });

    it("limits motion to the face, eyelids, breathing and a small shoulder drop", () => {
      const p = g45();
      expect(p.text).toContain(
        "Limit motion to her face, eyelids, breathing and a small shoulder drop; no larger head or body movement.",
      );
      expect(p.text).not.toContain("breathes naturally"); // breathing is part of the envelope, not a separate clause
      expect(p.adaptations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: "blocking.screenDirection",
            source: "Faces screen-right",
            rule: "held-orientation",
          }),
          expect.objectContaining({ rule: "motion-envelope-limited" }),
        ]),
      );
    });

    it("ends calm and neutral, with no distress", () => {
      const t = g45().text;
      expect(t).toContain("Then her eyes open and she ends calm and neutral.");
      expect(t).not.toMatch(/distress|worried|upset|tears|cries/i);
    });

    it("stays under the 900 target and 1000 limit, without mask/composure or internal metadata", () => {
      const p = g45();
      expect(p.ok).toBe(true);
      expect(p.length).toBe(882);
      expect(p.length).toBeLessThanOrEqual(900);
      expect(p.budget).toEqual({ limit: 1000, target: 900 });
      expect(p.text).not.toMatch(
        /\b(mask|masked|masks|composure)\b|Production Frame|\(v\d+\)|Purpose:|\b3A\b|[0-9a-f]{8}-[0-9a-f]{4}-|animate_production_frame|\d+\s*\/\s*10\b/i,
      );
      expect(adapt(shot3a().pkg).text).toBe(p.text); // Turbo and Gen-4.5 share the policy prose
    });

    it("a profile direction says profile; a moving or unsided Shot keeps the plain head-turn wording", () => {
      const { pkg } = shot3a();
      const profile = withBlocking(pkg, { screenDirection: "Profile, faces screen-left" });
      expect(profile.text).toContain("keeps the first frame's profile orientation toward screen-left");
      expect(profile.text).toContain("never rotating through frontal or toward screen-right");
      const moving = withBlocking(pkg, { exitPoint: "Frame left" });
      expect(moving.text).toContain(
        "She keeps her head turned toward screen-right with her eyes down and away throughout and never looks into the camera.",
      );
      expect(moving.text).toContain("she breathes naturally");
      expect(moving.text).not.toContain("Limit motion");
      const unsided = withBlocking(pkg, { screenDirection: "" });
      expect(unsided.text).not.toMatch(/three-quarter|torso/);
    });
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
    expect(required.omitted.map((o) => o.key)).toEqual([
      "composition",
      "performance",
      "look_detail",
      "setting",
    ]);
    // with room for exactly one optional section, the highest-priority one is chosen
    const comp = all.sections.find((s) => s.key === "composition")!;
    const one = withBudget(pkg, 1000, required.length + 1 + comp.length);
    expect(one.sections.filter((s) => !s.required && s.included).map((s) => s.key)).toEqual(["composition"]);
    expect(one.omitted.map((o) => o.key)).toEqual(["performance", "look_detail", "setting"]);
    expect(withBudget(pkg, 1000, required.length + 1 + comp.length)).toEqual(one);
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

describe("provider-prompt adaptation: visible-motion v2 (the provider's documented prompting contract)", () => {
  const G45 = { provider: "runway", modelId: "gen4.5", purpose: "animate_production_frame" } as const;
  const v2 = (pkg: GenerationPackage, model: typeof G45 | typeof TURBO = G45) =>
    adaptProviderPrompt(pkg, model)!;
  const withBlocking = (pkg: GenerationPackage, blocking: Partial<GenerationPackage["blocking"]>) =>
    v2({ ...pkg, blocking: { ...pkg.blocking, ...blocking } });

  it("Shot 3A: camera, held orientation, the visible change, the calm ending and the motion envelope — nothing else", () => {
    const p = v2(shot3a().pkg);
    expect(p.text).toBe(
      "The locked-off camera remains perfectly still. " +
        "The subject holds her position, turned toward the right side of the frame, and her gaze stays down and away. " +
        "Her expression briefly softens, she looks visibly exhausted, her shoulders lower subtly and she closes her eyes briefly. " +
        "Then her eyes open and she ends calm and neutral. " +
        "Minimal subject motion only: her face, eyelids and breathing, with a slight drop of the shoulders. " +
        "The pace is slow.",
    );
    expect(p).toMatchObject({ ok: true, problem: null, policy: { id: "visible-motion", version: 2 } });
    expect(p.length).toBe(443);
    expect(p.omitted).toEqual([]); // nothing is over budget: no "prompt.budget" acknowledgement is needed
    expect(v2(shot3a().pkg, TURBO).text).toBe(p.text); // Turbo and Gen-4.5 share the policy prose
    expect(v2(shot3a("mask").pkg).text).toBe(p.text); // the figurative "mask" wording translates the same way
  });

  it("POSITIVE PHRASING ONLY: none of v1's negations is sent", () => {
    const old = v1(shot3a().pkg, "gen4.5").text;
    // what v1 sent for this very Shot, and why v2 exists
    for (const phrase of [
      "never rotating through frontal or toward screen-left",
      "never looking into the camera",
      "no larger head or body movement",
      "no push-in, pan or reframing",
      "Do not introduce new objects or people",
    ])
      expect(old).toContain(phrase);
    const text = v2(shot3a().pkg).text;
    expect(negativePhrasing(old)).toBe("never");
    expect(negativePhrasing(text)).toBeNull();
    expect(text).not.toMatch(/\b(no|not|never|without|avoid)\b|n't/i);
    // the opposite side and the frontal pass are not named at all (naming them invites them)
    expect(text).not.toMatch(/screen-left|left side|frontal|into the camera/i);
  });

  it("MOTION ONLY: what the first frame already shows is not restated, and the omissions are recorded", () => {
    const { pkg } = shot3a();
    const p = v2(pkg);
    // subject description, Look, Location, lighting and the beginning pose stay out of the prose
    expect(p.text).not.toMatch(/Japanese|woman|late 20s|Yumeko/i);
    expect(p.text).not.toMatch(/chignon|gown|satin|earring|pearl|burgundy/i);
    expect(p.text).not.toMatch(/Lobby|elevator|chandelier|night|lighting|background/i);
    expect(p.text).not.toMatch(/begins|guarded/i);
    expect(p.text).not.toMatch(/identity|facial structure|apparent age/i);
    expect(p.excluded).toEqual(
      expect.arrayContaining([
        "Look details: hair, wardrobe, jewelry (established by the first frame)",
        "subject description (established by the first frame)",
        "negative phrasing (unsupported by the provider; may produce the opposite result)",
        "Shot code and title",
      ]),
    );
    expect(p.adaptations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "timing.beginningPose",
          provider: null,
          rule: "established-by-first-frame",
        }),
        expect.objectContaining({
          field: "blocking.subjectBlocking",
          source: "Yumeko stands at the elevator, back to the lobby",
          provider: null,
          rule: "established-by-first-frame",
        }),
        expect.objectContaining({ field: "camera.framing", rule: "framing-established-by-first-frame" }),
        expect.objectContaining({ field: "blocking.screenDirection", rule: "held-orientation-positive" }),
        expect.objectContaining({ rule: "motion-envelope-positive" }),
        expect.objectContaining({ field: "camera.movement", rule: "imperceptible-movement-locked" }),
      ]),
    );
  });

  it("refers to the subject in general terms: 'the subject' first, then a pronoun; never a name or internal metadata", () => {
    const { pkg } = shot3a();
    const p = v2(pkg);
    expect(p.text.match(/The subject\b/g)).toHaveLength(1);
    expect(p.text).not.toContain(pkg.shot.code);
    expect(p.text).not.toContain(pkg.shot.title);
    expect(p.text).not.toMatch(/Production Frame|\(v\d+\)|Purpose:|aspect ratio|2\.39|\d+\s*\/\s*10\b/i);
    expect(p.text).not.toMatch(/\b(mask|masked|masks|composure)\b/i);
    expect(p.text).not.toMatch(/[\u3040-\u30ff]/); // no dialogue text
    for (const c of pkg.characters) if (c.look) expect(p.text).not.toContain(c.look.name);
  });

  it("a Shot note phrased negatively is NOT sent, and the filmmaker is told how to fix it", () => {
    const { pkg } = shot3a();
    const variant: GenerationPackage = {
      ...pkg,
      characters: pkg.characters.map((c) => ({
        ...c,
        expression: "Composure slips; never smiles",
        gestures: "Closes eyes briefly, doesn't look at the camera",
      })),
      blocking: { ...pkg.blocking, eyelines: "Down and away, never at the lens" },
    };
    const p = v2(variant);
    expect(p.ok).toBe(true);
    expect(negativePhrasing(p.text)).toBeNull();
    expect(p.text).toContain("her gaze stays down and away");
    expect(p.text).toContain("she closes her eyes briefly");
    expect(p.text).not.toMatch(/smile|lens|camera\b(?! remains)/i);
    expect(notesNotSent(p)).toEqual([
      expect.objectContaining({ field: "blocking.eyelines", source: "never at the lens" }),
      expect.objectContaining({ field: "characters.expression", source: "never smiles" }),
      expect.objectContaining({ field: "characters.gestures", source: "doesn't look at the camera" }),
    ]);
    for (const n of notesNotSent(p)) expect(n.reason).toMatch(/rephrase as what should happen/);
    // a figurative note no rule understands is reported the same way
    const fig = v2({
      ...pkg,
      characters: pkg.characters.map((c) => ({ ...c, gestures: "Hides behind a social mask" })),
    });
    expect(fig.text).not.toMatch(/mask/i);
    expect(notesNotSent(fig)).toContainEqual(
      expect.objectContaining({
        source: "Hides behind a social mask",
        reason: expect.stringMatching(/figurative/),
      }),
    );
  });

  it("camera: a still camera is asked for positively; a move states only the move", () => {
    const { pkg } = shot3a();
    const cam = (camera: Partial<GenerationPackage["camera"]>) =>
      v2({ ...pkg, camera: { ...pkg.camera, ...camera } }).text;
    const LOCKED = "The locked-off camera remains perfectly still.";
    for (const movement of ["", "Static", "Locked off", "Imperceptible push-in", "No movement"])
      expect(cam({ movement, movementSpeed: "" })).toContain(LOCKED);
    expect(cam({ movement: "Slow push-in", movementSpeed: "Very slow" })).toContain(
      "The camera makes a slow push-in.",
    );
    expect(cam({ movement: "Push-in", movementSpeed: "Very slow" })).toContain(
      "The camera makes a very slow push-in.",
    );
    expect(cam({ movement: "Arc left", movementSpeed: "" })).toContain("The camera makes an arc left.");
    expect(cam({ movement: "Parallel track", movementSpeed: "Match car" })).toContain(
      "The camera makes a parallel track, match car.",
    );
    for (const t of [cam({ movement: "Dolly right" }), cam({ movement: "No movement" })])
      expect(t).not.toMatch(/no other reframing|at eye level/);
  });

  it("orientation: profile, a moving Shot, an unsided Shot and a note that there is no eyeline", () => {
    const { pkg } = shot3a();
    expect(withBlocking(pkg, { screenDirection: "Profile, faces screen-left" }).text).toContain(
      "The subject holds her position, in profile toward the left side of the frame, and her gaze stays down and away.",
    );
    const moving = withBlocking(pkg, { exitPoint: "Frame left" }).text;
    expect(moving).toContain(
      "The subject stays turned toward the right side of the frame and her gaze stays down and away.",
    );
    expect(moving).toContain("she breathes naturally");
    expect(moving).not.toContain("Minimal subject motion only");
    const unsided = withBlocking(pkg, { screenDirection: "" }).text;
    expect(unsided).toContain("The subject's gaze stays down and away.");
    expect(unsided).not.toMatch(/holds her position|side of the frame/);
    const noEyeline = withBlocking(pkg, { eyelines: "N/A (foot)" }).text;
    expect(noEyeline).toContain("The subject holds her position, turned toward the right side of the frame.");
    expect(noEyeline).not.toMatch(/n\/a|gaze|eyeline/i);
    // the subject is named once even when no orientation sentence introduces them
    const bare = withBlocking(pkg, { screenDirection: "", eyelines: "" }).text;
    expect(bare).toContain("The subject's expression briefly softens");
    expect(bare.match(/The subject\b/g)).toHaveLength(1);
  });

  it("never invents a subject or a claim: no Character, several Characters, and notes no rule understands", () => {
    const data = seed();
    const byCode = (code: string) =>
      v2(assembleGenerationPackage(buildShotContext(data, shotByCode(data, code).id))).text;
    // no Character in the Shot: camera only
    expect(byCode("1A")).toBe("The camera makes a slow push-in.");
    // several Characters: only what is true of all of them
    expect(byCode("6A")).toBe(
      "The locked-off camera remains perfectly still. The subjects hold their positions. Minimal subject motion only. The pace is slow.",
    );
    // a note that is not about the subject's look is sent in the filmmaker's words, never as "she looks <note>"
    const c1 = byCode("1C");
    expect(c1).toContain("Screen illuminates her face, her jaw tightens, she looks blank");
    expect(c1).toContain("Then thumb hovers over reply and locks the screen.");
    expect(c1).not.toMatch(/she looks (screen|thumb|then)/i);
  });

  it("holds for every Shot of the project: sendable, positive, deterministic, within budget", () => {
    const data = seed();
    for (const shot of data.shots) {
      const pkg = assembleGenerationPackage(buildShotContext(data, shot.id));
      const p = v2(pkg);
      expect(p.ok, shot.shotCode).toBe(true);
      expect(negativePhrasing(p.text), `${shot.shotCode}: ${p.text}`).toBeNull();
      expect(p.text.startsWith("The ")).toBe(true); // the camera sentence leads
      expect(p.text.endsWith(".")).toBe(true);
      expect(p.length).toBe(p.text.length);
      expect(p.length).toBeLessThanOrEqual(600);
      expect(p.text).not.toMatch(/\b(mask|composure)\b|undefined|null|\s{2,}/i);
      expect(v2(assembleGenerationPackage(buildShotContext(data, shot.id))).text).toBe(p.text);
      expect(parseFrozenProviderPrompt(JSON.parse(JSON.stringify(p)))).toEqual(p); // the frozen record round-trips
      expect(p.sourceFingerprint).toBe(pkg.provenance.fingerprint);
    }
  });

  it("budget and guards: over the limit is refused (never truncated); the optional pace is dropped whole", () => {
    const { pkg } = shot3a();
    const tight = adaptAnimationProviderPromptV2(pkg, {
      ...G45,
      choice: { policy: VISIBLE_MOTION_V2_POLICY, budget: { limit: 200, target: 200 } },
    });
    expect(tight.ok).toBe(false);
    expect(tight.problem).toMatch(/accepts at most 200/);
    expect(tight.text.endsWith(".")).toBe(true); // the full text is kept for inspection, not cut
    // the optional pace sentence is dropped whole when it does not fit the target
    const noPace = adaptAnimationProviderPromptV2(pkg, {
      ...G45,
      choice: { policy: VISIBLE_MOTION_V2_POLICY, budget: { limit: 1000, target: 430 } },
    });
    expect(noPace.ok).toBe(true);
    expect(noPace.text).not.toContain("The pace is");
    expect(noPace.omitted).toEqual([{ key: "performance", label: "Performance", reason: "over_budget" }]);
    // a negatively phrased camera note is never sent as written: the positive request is a still camera (recorded).
    // (Every input is filtered before it reaches the prose, so the final "contains a negation → not ok" check in the
    // policy is defence in depth against a future rule gap; it has no reachable input today.)
    const neg = v2({ ...pkg, camera: { ...pkg.camera, movement: "Does not move", movementSpeed: "" } });
    expect(neg.ok).toBe(true);
    expect(neg.text).toContain("The locked-off camera remains perfectly still.");
    expect(neg.adaptations).toContainEqual(
      expect.objectContaining({ field: "camera.movement", rule: "negative-phrasing-locked" }),
    );
  });

  it("leaves the authoritative story data untouched and follows it when it changes", () => {
    const { data, shot, pkg } = shot3a();
    const before = JSON.stringify(data);
    const first = v2(pkg);
    expect(JSON.stringify(data)).toBe(before);
    shot.action = { ...shot.action, endingPose: "Eyes closed, calm" };
    const after = v2(assembleGenerationPackage(buildShotContext(data, shot.id)));
    expect(after.sourceFingerprint).not.toBe(first.sourceFingerprint);
    expect(after.text).toContain("Then her eyes closed and she settles into a calm expression.");
  });
});
