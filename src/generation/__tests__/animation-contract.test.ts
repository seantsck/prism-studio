import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  attach,
  draftFor,
  newUploadAsset,
  seedWithFrame,
} from "@/domain/__tests__/production-frame-fixtures";
import { shotByCode } from "@/domain/__tests__/helpers";
import { buildShotContext } from "@/domain/context";
import { assembleGenerationPackage } from "@/domain/generation-package";
import {
  ANIMATE_KEYFRAME_DISCLOSURE,
  ANIMATE_NO_PRODUCTION_FRAME,
  ANIMATE_OVERRIDE_CONFLICT,
  animationFreshness,
  animationProvenance,
  animationRequestViolations,
  animationSource,
  shotAnimationSummary,
} from "@/domain/generation/animation";
import { candidateSetPurpose } from "@/domain/generation/candidates";
import { evaluateCompatibility } from "@/domain/generation/compatibility";
import {
  ANIMATION_EXEMPT_RULES,
  buildGenerationRequest,
  preflightForPurpose,
} from "@/domain/generation/gate";
import { evaluateModelFit } from "@/domain/generation/models/matrix";
import { purposeOfRequestJson } from "@/domain/generation/outcomes";
import { ofPurpose, type OutcomeRecord } from "@/domain/generation/performance";
import {
  ANIMATION_BEGIN_LINE,
  ANIMATION_PRESERVE_LINE,
  buildPromptPlan,
} from "@/domain/generation/prompt-plan";
import {
  isAnimationAttempt,
  isProductionFrameAttempt,
  isShotOutputPurpose,
  parseGenerationPurpose,
  type GenerationModel,
} from "@/domain/generation/schemas";
import type { ProductionFrame } from "@/domain/production-frame";
import { runPreflight } from "@/domain/preflight";
import type { GenerationAttempt, ProjectData } from "@/domain/schemas";
import { readGenerationConfig } from "../config";
import { createRegistry } from "../registry";
import { evaluateShotForModel } from "../submission";

/**
 * Phase 2H — the Animate Production Frame contract, pure (no worker, no provider, no network, no spend): the selected,
 * CURRENT Production Frame is the exact image-to-video first frame, or nothing is generated.
 */

const env = { NODE_ENV: "test" };
const registry = createRegistry(env, readGenerationConfig(env));
const model = (id: string, provider = "mock"): GenerationModel => registry.model(provider, id)!;
const ANIM = "animate_production_frame" as const;

const pkgOf = (data: ProjectData, code: string) =>
  assembleGenerationPackage(buildShotContext(data, shotByCode(data, code).id));

/** A seed project whose Shot has a SELECTED fresh Production Frame (a stored 1912×800 upload). */
function withFrame(code = "3A") {
  return seedWithFrame(code);
}

/** Adds and selects a second frame (v2) for the Shot. */
function selectV2(data: ProjectData, code: string, v1: ProductionFrame): ProductionFrame {
  const asset = newUploadAsset(data.project.id, { label: `frame-${code}-v2` });
  data.assets.push(asset);
  const v2: ProductionFrame = { ...draftFor(data, code, { asset }), version: 2 };
  attach(data, [v2, v1], v2);
  return v2;
}

function requestFor(data: ProjectData, code: string, modelId = "mock-video-1") {
  const pkg = pkgOf(data, code);
  const m = model(modelId);
  const compatibility = evaluateCompatibility(pkg, m, { purpose: ANIM });
  const plan = buildPromptPlan(pkg, compatibility.adaptation?.promptAdaptation, { purpose: ANIM });
  return {
    pkg,
    compatibility,
    request: buildGenerationRequest({ pkg, model: m, compatibility, plan, idempotencyKey: "k-0000000001" }),
  };
}

/** The minimal attempt shape the animation helpers read, from a real frozen request + package. */
function attemptFrom(data: ProjectData, code: string, o: Partial<GenerationAttempt> = {}): GenerationAttempt {
  const { pkg, request } = requestFor(data, code);
  return {
    id: randomUUID(),
    shotId: shotByCode(data, code).id,
    status: "succeeded",
    approved: false,
    request: JSON.parse(JSON.stringify(request)) as Record<string, unknown>,
    packageSnapshot: JSON.parse(JSON.stringify(pkg)) as Record<string, unknown>,
    ...o,
  } as GenerationAttempt;
}

describe("purposes", () => {
  it("historical requests without a purpose are shot_output; unknown values never crash", () => {
    expect(parseGenerationPurpose(undefined)).toBe("shot_output");
    expect(parseGenerationPurpose("something_new")).toBe("shot_output");
    expect(parseGenerationPurpose(ANIM)).toBe(ANIM);
    expect(isProductionFrameAttempt({ request: null })).toBe(false);
    expect(isProductionFrameAttempt({ request: { purpose: "production_frame" } })).toBe(true);
    expect(isProductionFrameAttempt({ request: { purpose: ANIM } })).toBe(false);
    expect(isAnimationAttempt({ request: { purpose: ANIM } })).toBe(true);
    expect(isAnimationAttempt({ request: {} })).toBe(false);
  });

  it("shot_output and animate_production_frame are Shot output; production_frame is not", () => {
    expect(isShotOutputPurpose("shot_output")).toBe(true);
    expect(isShotOutputPurpose(ANIM)).toBe(true);
    expect(isShotOutputPurpose("production_frame")).toBe(false);
  });

  it("candidate-set purpose parsing: absent → shot_output, both explicit purposes kept, unknown → shot_output", () => {
    expect(candidateSetPurpose({ recommendation: null })).toBe("shot_output");
    expect(candidateSetPurpose({ recommendation: { generationPurpose: "production_frame" } })).toBe(
      "production_frame",
    );
    expect(candidateSetPurpose({ recommendation: { generationPurpose: ANIM } })).toBe(ANIM);
    expect(candidateSetPurpose({ recommendation: { generationPurpose: 42 } })).toBe("shot_output");
    expect(purposeOfRequestJson({ purpose: ANIM })).toBe(ANIM);
    expect(purposeOfRequestJson({})).toBeUndefined();
  });

  it("video outcome history is shared by both video purposes; still-image history stays separate", () => {
    const rec = (purpose?: OutcomeRecord["purpose"]) => ({ purpose }) as OutcomeRecord;
    const all = [rec(), rec("production_frame"), rec(ANIM)];
    expect(ofPurpose(all, ANIM)).toHaveLength(2);
    expect(ofPurpose(all, "shot_output")).toHaveLength(2);
    expect(ofPurpose(all, "production_frame")).toHaveLength(1);
  });
});

describe("source rules (hard, never acknowledgeable)", () => {
  it("PF selected (Asset A), approved Storyboard (Asset B), no override: the request starts from A, never B", () => {
    const { data, frame } = withFrame("3A");
    const pkg = pkgOf(data, "3A");
    expect(pkg.references.approvedStoryboardFrame?.assetId).toBeTruthy();
    expect(pkg.references.approvedStoryboardFrame?.assetId).not.toBe(frame.assetId);
    expect(animationSource(pkg)).toMatchObject({
      ok: true,
      frame: { frameId: frame.id, assetId: frame.assetId },
    });
    const { request, compatibility } = requestFor(data, "3A");
    expect(compatibility.compatible).toBe(true);
    expect(request.purpose).toBe(ANIM);
    expect(request.modality).toBe("image_to_video");
    expect(request.startFrameAssetId).toBe(frame.assetId);
    expect(request.startFrameAssetId).toBe(pkg.references.productionFrame!.assetId);
    // one Asset, one slot: the frame is not also a reference, and the Storyboard it supersedes is not sent
    expect(request.references.some((r) => r.role === "production_frame" || r.assetId === frame.assetId)).toBe(
      false,
    );
    expect(request.references.some((r) => r.role === "storyboard")).toBe(false);
    expect(animationRequestViolations(request, pkg)).toEqual([]);
  });

  it("no Production Frame: BLOCKED with the exact message (no Storyboard / text-to-video fallback)", () => {
    const { data } = withFrame("3A");
    attach(data, data.productionFrames ?? [], null);
    const pkg = pkgOf(data, "3A");
    expect(animationSource(pkg)).toMatchObject({
      ok: false,
      issues: [{ code: "no_production_frame", message: ANIMATE_NO_PRODUCTION_FRAME }],
    });
    const c = evaluateCompatibility(pkg, model("mock-video-1"), { purpose: ANIM });
    expect(c.compatible).toBe(false);
    expect(c.errors.map((e) => e.message)).toEqual([ANIMATE_NO_PRODUCTION_FRAME]);
    expect(c.used.startFrameAssetId).toBeNull();
    // the generic workflow keeps its historical Storyboard start frame
    const generic = evaluateCompatibility(pkg, model("mock-video-1"));
    expect(generic.errors.map((e) => e.id)).not.toContain("animate.no_production_frame");
  });

  it("stale Production Frame: BLOCKED, naming what changed; the frame stays selected and unchanged", () => {
    const { data, frame } = withFrame("3A");
    const shot = shotByCode(data, "3A");
    shot.lighting = { ...shot.lighting, mood: "storm light" };
    const pkg = pkgOf(data, "3A");
    const src = animationSource(pkg);
    expect(src.ok).toBe(false);
    if (src.ok) return;
    expect(src.issues[0]!.code).toBe("production_frame_stale");
    expect(src.issues[0]!.changedParts).toContain("lighting");
    expect(src.issues[0]!.message).toMatch(/Lighting changed after this Production Frame was made/);
    expect(evaluateCompatibility(pkg, model("mock-video-1"), { purpose: ANIM }).compatible).toBe(false);
    expect(pkg.references.productionFrame?.frameId).toBe(frame.id);
  });

  it("a different manual start-frame override: BLOCKED (never silently used, never silently ignored)", () => {
    const { data, frame } = withFrame("3A");
    const other = newUploadAsset(data.project.id, { label: "manual-start" });
    data.assets.push(other);
    shotByCode(data, "3A").generation.startFrameAssetId = other.id;
    const pkg = pkgOf(data, "3A");
    expect(pkg.references.startFrameAssetId).toBe(other.id); // generic precedence still prefers the override
    const c = evaluateCompatibility(pkg, model("mock-video-1"), { purpose: ANIM });
    expect(c.errors.map((e) => e.message)).toContain(ANIMATE_OVERRIDE_CONFLICT);
    expect(c.compatible).toBe(false);
    // an override equal to the selected frame's own Asset is allowed
    shotByCode(data, "3A").generation.startFrameAssetId = frame.assetId;
    const ok = evaluateCompatibility(pkgOf(data, "3A"), model("mock-video-1"), { purpose: ANIM });
    expect(ok.compatible).toBe(true);
    expect(ok.used.startFrameAssetId).toBe(frame.assetId);
  });
});

describe("image-to-video only", () => {
  it("a text-to-video-only model is INCOMPATIBLE (no fallback), with the exact reasons", () => {
    const { data } = withFrame("3A");
    const c = evaluateCompatibility(pkgOf(data, "3A"), model("mock-video-t2v"), { purpose: ANIM });
    expect(c.compatible).toBe(false);
    expect(c.modality).toBeNull();
    expect(c.errors[0]!.message).toMatch(
      /Animate Production Frame requires exact first-frame conditioning\./,
    );
    expect(c.errors[0]!.message).toMatch(
      /This workflow requires image-to-video from the canonical Production Frame\./,
    );
    // the same model is a perfectly good GENERIC text-to-video model
    const generic = evaluateCompatibility(pkgOf(data, "3A"), model("mock-video-t2v"), {
      modality: "text_to_video",
    });
    expect(generic.errors.map((e) => e.id)).not.toContain("modality.unsupported");
  });

  it("an explicit text-to-video modality is refused for the purpose", () => {
    const { data } = withFrame("3A");
    const c = evaluateCompatibility(pkgOf(data, "3A"), model("mock-video-1"), {
      purpose: ANIM,
      modality: "text_to_video",
    });
    expect(c.compatible).toBe(false);
    expect(c.errors.map((e) => e.id)).toContain("animate.image_to_video_required");
  });

  it("the adapter invariant rejects every tampered request", () => {
    const { data, frame } = withFrame("3A");
    const { pkg, request } = requestFor(data, "3A");
    expect(animationRequestViolations({ ...request, modality: "text_to_video" }, pkg)).toEqual([
      expect.stringMatching(/must be image-to-video/),
    ]);
    expect(animationRequestViolations({ ...request, startFrameAssetId: null }, pkg)[0]).toMatch(
      /no start frame/,
    );
    expect(animationRequestViolations({ ...request, startFrameAssetId: "other" }, pkg)).toEqual([
      "The start frame is not the frozen Production Frame.",
    ]);
    expect(
      animationRequestViolations(
        {
          ...request,
          references: [{ assetId: frame.assetId, role: "production_frame", order: 0, label: "PF" }],
        },
        pkg,
      )[0],
    ).toMatch(/must not also be sent as a reference/);
    expect(animationRequestViolations(request, { references: {} })).toEqual([
      "The frozen package has no Production Frame to animate.",
    ]);
    // other purposes are not this rule's business
    expect(
      animationRequestViolations({ ...request, purpose: undefined, modality: "text_to_video" }, pkg),
    ).toEqual([]);
  });
});

describe("keyframe mode and reference disclosure", () => {
  it("a keyframe-exclusive model keeps the exact first frame and discloses the omitted references truthfully", () => {
    const { data, frame } = withFrame("3A");
    const pkg = pkgOf(data, "3A");
    const seedance = model("seedance2_5", "runway");
    expect(seedance.capabilities.references.keyframesExcludeReferences).toBe(true);
    const c = evaluateCompatibility(pkg, seedance, { purpose: ANIM });
    expect(c.inputMode).toBe("keyframes");
    expect(c.used.startFrameAssetId).toBe(frame.assetId);
    expect(c.used.references).toEqual([]);
    const disclosed = c.ignoredFeatures.find((f) => f.id === "references.mode_exclusive");
    if (c.inputs.some((i) => i.kind === "reference"))
      expect(disclosed?.impact).toBe(ANIMATE_KEYFRAME_DISCLOSURE);
  });

  it("reference mode is never available: asking for it is an error, not a silent demotion of the frame", () => {
    const { data } = withFrame("3A");
    const c = evaluateCompatibility(pkgOf(data, "3A"), model("seedance2_5", "runway"), {
      purpose: ANIM,
      inputMode: "references",
    });
    expect(c.errors.map((e) => e.id)).toContain("animate.reference_mode");
    expect(c.inputMode).toBe("keyframes");
  });
});

describe("motion-first prompting (PromptPlan v1, same sections)", () => {
  it("begins from the frame, preserves what it establishes, leads with motion; Lock/View facts stay", () => {
    const { data } = withFrame("3A");
    const pkg = pkgOf(data, "3A");
    const plan = buildPromptPlan(pkg, null, { purpose: ANIM });
    expect(plan.version).toBe(1);
    const keys = plan.sections.map((s) => s.key);
    expect(keys.indexOf("camera")).toBeLessThan(keys.indexOf("identity"));
    expect(keys.indexOf("action")).toBeLessThan(keys.indexOf("wardrobe"));
    const lines = (k: string) => plan.sections.find((s) => s.key === k)?.lines ?? [];
    expect(lines("subject")[0]).toBe(`${ANIMATION_BEGIN_LINE.slice(0, -1)} (v1).`);
    expect(lines("hard_constraints")[0]).toBe(ANIMATION_PRESERVE_LINE);
    expect(lines("camera").join(" ")).toMatch(/push-in/i);
    // appearance is still described (what the motion must preserve), from the same package
    expect(lines("identity").length).toBeGreaterThan(0);
    // the generic plan is unchanged
    const generic = buildPromptPlan(pkg);
    expect(generic.sections.map((s) => s.key)[1]).toBe("identity");
    expect(generic.sections.flatMap((s) => s.lines)).not.toContain(ANIMATION_PRESERVE_LINE);
  });
});

describe("duration and framing (existing adaptation semantics)", () => {
  it("native: 4.5 s on a 1–12 s model is generated natively", () => {
    const { data } = withFrame("3A");
    const c = evaluateCompatibility(pkgOf(data, "3A"), model("mock-video-1"), { purpose: ANIM });
    expect(c.used.durationMs).toBe(4500);
    expect(c.adaptation?.duration.status).toBe("native");
  });

  it("longer-then-trim + framing adaptation: explicit, priced on the provider duration, the frame untouched", () => {
    const { data, frame } = withFrame("3A");
    const pkg = pkgOf(data, "3A");
    const m = model("mock-video-169");
    const fit = evaluateModelFit({
      pkg,
      model: m,
      catalog: null,
      availability: null,
      options: { purpose: ANIM },
    });
    expect(fit.status).toBe("adaptation_required");
    const c = fit.compatibility;
    expect(c.used.durationMs).toBe(5000);
    expect(c.adaptation?.duration).toMatchObject({ status: "adapted", productionMs: 4500, providerMs: 5000 });
    expect(c.adaptation?.conform.trimToMs).toBe(4500);
    expect(c.adaptation?.framing.status).toBe("adapted");
    expect(c.adaptation?.framing.productionLabel).toBe("2.39:1");
    expect(c.used.aspectRatio).toBe("16:9");
    expect(c.used.startFrameAssetId).toBe(frame.assetId);
    expect(fit.estimate?.amountUsd).toBeCloseTo(0.05 * 5, 6); // provider seconds, never production seconds
    // without the user's explicit choice nothing is adapted silently: it stays a blocker
    const bare = evaluateCompatibility(pkg, m, { purpose: ANIM });
    expect(bare.compatible).toBe(false);
  });

  it("unsupported duration without an adaptation: BLOCKED (never rounded)", () => {
    const { data } = withFrame("3A");
    const c = evaluateCompatibility(pkgOf(data, "3A"), model("mock-video-lite"), { purpose: ANIM });
    expect(c.errors.map((e) => e.id)).toContain("duration.unsupported");
  });
});

describe("gate", () => {
  it("Storyboard rules and the generic PF-freshness warning do not gate an animation; output readiness still does", () => {
    const { data } = withFrame("3A");
    const ctx = buildShotContext(data, shotByCode(data, "3A").id);
    const report = runPreflight(ctx);
    const forAnim = preflightForPurpose(report, ANIM);
    for (const i of forAnim.items)
      if (ANIMATION_EXEMPT_RULES.has(i.ruleId)) expect(i.status).not.toBe("fail");
    expect(forAnim.items.find((i) => i.ruleId === "story.duration")?.status).toBe(
      report.items.find((i) => i.ruleId === "story.duration")?.status,
    );
  });

  it("evaluation: the animate gate is allowed for a fresh frame on the free mock; the request records the purpose", () => {
    const { data } = withFrame("3A");
    const ev = evaluateShotForModel({
      data,
      shotId: shotByCode(data, "3A").id,
      registry,
      provider: "mock",
      modelId: "mock-video-1",
      purpose: ANIM,
    });
    expect(ev.compatibility?.modality).toBe("image_to_video");
    expect(ev.gate.blockers.filter((b) => b.code.startsWith("compatibility.animate"))).toEqual([]);
  });
});

describe("freshness, provenance and derived Sequence state", () => {
  it("PF v1 → select v2: the v1 animation is stale (history unchanged); a new request starts from v2", () => {
    const { data, frame } = withFrame("3A");
    const a1 = attemptFrom(data, "3A");
    const ctx1 = buildShotContext(data, a1.shotId);
    expect(animationFreshness(ctx1, a1).status).toBe("fresh");
    expect(animationProvenance(a1)).toMatchObject({ frameId: frame.id, version: 1, firstFrameMatches: true });
    const v2 = selectV2(data, "3A", frame);
    const ctx2 = buildShotContext(data, a1.shotId);
    const f = animationFreshness(ctx2, a1);
    expect(f.status).toBe("stale");
    expect(f.messages).toContain("The selected Production Frame changed");
    expect(animationProvenance(a1)?.frameId).toBe(frame.id);
    expect(requestFor(data, "3A").request.startFrameAssetId).toBe(v2.assetId);
  });

  it("timing / camera / performance changes stale an animation even when the still itself stays fresh", () => {
    const { data } = withFrame("3A");
    const a = attemptFrom(data, "3A");
    const shot = shotByCode(data, "3A");
    shot.durationMode = "manual";
    shot.targetDurationMs = 9000;
    const ctx = buildShotContext(data, shot.id);
    // the still does not depend on duration: the Production Frame itself stays fresh
    expect(animationSource(assembleGenerationPackage(ctx)).ok).toBe(true);
    const f = animationFreshness(ctx, a);
    expect(f.status).toBe("stale");
    expect(f.changed).toContain("timing");
    // a camera change stales it too
    shot.composition = { ...shot.composition, movement: "Fast whip pan" };
    expect(animationFreshness(buildShotContext(data, shot.id), a).changed).toEqual(
      expect.arrayContaining(["timing", "camera"]),
    );
  });

  it("a non-animation attempt has no animation provenance; a tampered start is reported as a mismatch", () => {
    const { data } = withFrame("3A");
    const a = attemptFrom(data, "3A");
    expect(animationProvenance({ ...a, request: { ...a.request, purpose: undefined } })).toBeNull();
    const bad = { ...a, request: { ...a.request, startFrameAssetId: "x" } };
    expect(animationProvenance(bad)?.firstFrameMatches).toBe(false);
  });

  it("Sequence state: not animated → candidates → final approved → stale (approval is never revoked)", () => {
    const { data, frame } = withFrame("3A");
    const shotId = shotByCode(data, "3A").id;
    const ctx = () => buildShotContext(data, shotId);
    expect(shotAnimationSummary(ctx(), []).state).toBe("not_animated");
    const a = attemptFrom(data, "3A");
    expect(shotAnimationSummary(ctx(), [a]).state).toBe("candidates");
    const approved = { ...a, approved: true };
    expect(shotAnimationSummary(ctx(), [approved])).toMatchObject({
      state: "final_approved",
      approvedAttemptId: a.id,
      approvedStale: false,
    });
    selectV2(data, "3A", frame);
    expect(shotAnimationSummary(ctx(), [approved])).toMatchObject({ state: "stale", approvedStale: true });
    expect(approved.approved).toBe(true);
    // generic Shot-output attempts are not animations
    const generic = { ...a, request: { ...a.request, purpose: undefined } };
    expect(shotAnimationSummary(ctx(), [generic]).state).toBe("not_animated");
  });
});
