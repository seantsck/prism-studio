import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  addImage,
  attachLocks,
  characterByName,
  lockFor,
  lookOf,
  uploadIdentity,
  uploadLookRef,
  yumekoIvory,
} from "@/domain/__tests__/character-continuity-fixtures";
import { seed, shotByCode } from "@/domain/__tests__/helpers";
import { attachViews, locationOf, viewFor } from "@/domain/__tests__/location-view-fixtures";
import { attach, draftFor, newUploadAsset, T } from "@/domain/__tests__/production-frame-fixtures";
import { buildShotContext } from "@/domain/context";
import { assembleGenerationPackage } from "@/domain/generation-package";
import type { OutcomeRecord } from "@/domain/generation/performance";
import {
  ACK_FRAME_LINEAGE,
  ACK_REFERENCE_MISSING,
  consumedAssetIds,
  referenceIntegrityAcknowledgements,
  shotReferenceIntegrity,
} from "@/domain/generation/reference-integrity";
import {
  ACK_IDENTICAL_RETAKE,
  isPreSpendAcknowledgement,
  priorTakes,
  retakeAcknowledgements,
  takeSignature,
} from "@/domain/generation/retake";
import type { GenerationRequest } from "@/domain/generation/schemas";
import type { ProductionFrame } from "@/domain/production-frame";
import {
  generationAttemptSchema,
  type Asset,
  type GenerationAttempt,
  type ProjectData,
} from "@/domain/schemas";
import { MemoryRepository } from "@/data/memory-repository";
import {
  animationPreSpendByModel,
  CandidateSetBlockedError,
  planCandidateSet,
  preSpendChecks,
  submitCandidateSet,
} from "../candidate-set";
import { readGenerationConfig } from "../config";
import { createRegistry } from "../registry";
import { evaluateShotForModel, prepareSubmission } from "../submission";

/**
 * Before spend on an animation (zero spend here: nothing is ever submitted to a provider).
 *
 *   1. Reference integrity: the video model receives only the Production Frame, so whether that frame was generated
 *      from the Shot's canonical references is checked from the frame's own lineage (its attempt's frozen inputs).
 *   2. Rejected takes: a request identical to a creatively rejected take is never re-sent silently.
 *
 * Both surface as explicit acknowledgements on PAID animation only, confirmed separately from the general list.
 */
const ENV = {
  NODE_ENV: "test",
  PRISM_STUDIO_GENERATION_PROVIDERS: "mock,runway",
  RUNWAYML_API_SECRET: "key_test_0123456789abcdef0123456789",
  PRISM_STUDIO_ALLOW_PAID_GENERATION: "true",
  PRISM_STUDIO_MAX_GENERATION_USD: "5",
  PRISM_STUDIO_MAX_CANDIDATE_SET_USD: "5",
};
const config = readGenerationConfig(ENV);
const registry = createRegistry(ENV, config);
const ADAPTED = { framing: "overscan_for_crop", duration: "generate_longer_then_trim" } as const;
const ANIM = "animate_production_frame" as const;

/** A succeeded Production Frame attempt of the Shot with these frozen inputs and this output image. */
function frameAttempt(
  data: ProjectData,
  shotId: string,
  o: { inputs: string[]; output: string; edit?: boolean },
): GenerationAttempt {
  const shot = data.shots.find((s) => s.id === shotId)!;
  const a = generationAttemptSchema.parse({
    id: randomUUID(),
    projectId: data.project.id,
    shotId,
    attemptNumber: data.attempts.filter((x) => x.shotId === shotId).length + 1,
    provider: "mock",
    model: "mock-image-1",
    modality: shot.generation.modality,
    prompt: "production frame",
    negativePrompt: "",
    packageSnapshot: {},
    packageFingerprint: "fixture",
    modelSettings: { purpose: "production_frame" },
    inputAssetIds: [...o.inputs].sort(),
    outputAssetId: o.output,
    costUsd: null,
    durationMs: null,
    status: "succeeded",
    reviewStatus: "unreviewed",
    rejectionCategories: [],
    reviewedAt: null,
    rejectionReason: "",
    notes: "",
    approved: false,
    requestModality: o.inputs.length ? "image_to_image" : "text_to_image",
    promptPlan: null,
    request: { purpose: "production_frame" },
    compatibility: null,
    acknowledgedIgnored: [],
    adaptationPlan: null,
    createdBy: null,
    createdAt: T,
  });
  data.attempts.push(a);
  return a;
}

/** A generated still (what a provider output is), added to the project. */
function generatedImage(data: ProjectData, label: string): Asset {
  const a = newUploadAsset(data.project.id, { label, width: 1536, height: 642 });
  a.purpose = "generation_output";
  a.source = "provider_output";
  data.assets.push(a);
  return a;
}

/** Yumeko's Visual Bible for Shot 3A as the handoff describes it: canonical identity, Formal Black Look, a Lobby view. */
function withVisualBible(data: ProjectData) {
  const shot = shotByCode(data, "3A");
  const canonical = uploadIdentity(data, "Yumeko", "additional", "yumeko-canonical");
  canonical.source = "generated"; // a generated reference is labelled as one, never as a photograph
  data.identityRefs.find((r) => r.assetId === canonical.id)!.metadata = { visualRole: "canonical" };
  const lookRef = uploadLookRef(data, lookOf(data, "Yumeko"), "formal-black-ref");
  const lobby = locationOf(data, "3A");
  const viewImage = addImage(data, "lobby-entrance", { width: 1536, height: 864 });
  viewImage.purpose = "location_ref";
  const view = viewFor(data, lobby.id, viewImage, { name: "Entrance toward elevators", kind: "entrance" });
  attachViews(data, [view], [{ shotId: shot.id, view }]);
  return { shot, canonical, lookRef, viewImage, view };
}

/** Selects a GENERATED Production Frame for 3A whose attempt consumed exactly `inputs`. */
function generatedFrame(data: ProjectData, inputs: string[], label = "frame-3A") {
  const shot = shotByCode(data, "3A");
  const image = generatedImage(data, label);
  const attempt = frameAttempt(data, shot.id, { inputs, output: image.id });
  const draft = draftFor(data, "3A", {
    asset: image,
    source: "generation_output",
    sourceGenerationAttemptId: attempt.id,
  });
  const frame: ProductionFrame = { ...draft, version: (data.productionFrames?.length ?? 0) + 1 };
  attach(data, [...(data.productionFrames ?? []), frame], frame);
  return { image, attempt, frame, draft };
}

const integrityOf = (data: ProjectData) => {
  const ctx = buildShotContext(data, shotByCode(data, "3A").id);
  return shotReferenceIntegrity(ctx, assembleGenerationPackage(ctx), data.attempts);
};

describe("reference integrity: slots, origins and the Production Frame's lineage", () => {
  it("the seeded Shot 3A has no stored reference at all: every slot is words only", () => {
    const r = integrityOf(seed());
    expect(r.slots.map((s) => [s.id.split(":")[0], s.status])).toEqual([
      ["identity", "missing"],
      ["look", "missing"],
      ["location_view", "missing"],
    ]);
    expect(r.slots[0]!.detail).toMatch(
      /4 identity entries have no stored image: Yumeko is described in words only/,
    );
    expect(r.slots[1]!.detail).toMatch(/Formal Black Look has no stored reference image/);
    expect(r.slots[2]!.detail).toMatch(/No Location View is selected/);
    expect(r.lineage).toMatchObject({ status: "none", frame: null });
    expect(r.verified).toBe(false);
    expect(referenceIntegrityAcknowledgements(r)).toEqual([]); // nothing to animate yet
  });

  it("VERIFIED: the frame's generation consumed the canonical identity, the Look and the Location View", () => {
    const data = seed();
    const vb = withVisualBible(data);
    const { frame } = generatedFrame(data, [vb.canonical.id, vb.lookRef.id, vb.viewImage.id]);
    const r = integrityOf(data);
    expect(r.slots).toEqual([
      expect.objectContaining({
        kind: "identity",
        subject: "Yumeko",
        label: "Canonical Identity",
        status: "ready",
        assetId: vb.canonical.id,
        origin: "generated",
      }),
      expect.objectContaining({
        kind: "look",
        label: "Episode 1 — Formal Black Look",
        status: "ready",
        assetId: vb.lookRef.id,
        origin: "uploaded",
      }),
      expect.objectContaining({
        kind: "location_view",
        subject: "Grand Celeste Lobby",
        label: 'Location View "Entrance toward elevators"',
        status: "ready",
        assetId: vb.viewImage.id,
      }),
    ]);
    expect(r.lineage).toMatchObject({
      status: "verified",
      frame: { frameId: frame.id, version: 1, source: "generation_output" },
      missing: [],
    });
    expect(r.lineage.consumed.map((s) => s.kind)).toEqual(["identity", "look", "location_view"]);
    expect(r.lineage.message).toBe(
      'Production Frame v1 was generated from Yumeko — Canonical Identity, Yumeko — Episode 1 — Formal Black Look and Grand Celeste Lobby — Location View "Entrance toward elevators".',
    );
    expect(r.verified).toBe(true);
    expect(referenceIntegrityAcknowledgements(r)).toEqual([]);
  });

  it("PARTIAL: a frame generated without the canonical identity is named, and animating it needs an acknowledgement", () => {
    const data = seed();
    const vb = withVisualBible(data);
    generatedFrame(data, [vb.viewImage.id]); // the request relied on the location and on words
    const r = integrityOf(data);
    expect(r.lineage.status).toBe("partial");
    expect(r.lineage.missing.map((s) => s.label)).toEqual([
      "Canonical Identity",
      "Episode 1 — Formal Black Look",
    ]);
    expect(r.lineage.consumed.map((s) => s.kind)).toEqual(["location_view"]);
    expect(r.verified).toBe(false);
    const acks = referenceIntegrityAcknowledgements(r);
    expect(acks).toHaveLength(1);
    expect(acks[0]).toMatchObject({
      id: ACK_FRAME_LINEAGE,
      label:
        "Production Frame v1 was generated without Yumeko — Canonical Identity and Yumeko — Episode 1 — Formal Black Look",
    });
    expect(acks[0]!.impact).toMatch(/video model receives only this frame/);
    expect(isPreSpendAcknowledgement(acks[0]!.id)).toBe(true);
  });

  it("UNREFERENCED: a frame generated while the Shot had no reference image came from words only", () => {
    const data = seed();
    generatedFrame(data, []);
    const r = integrityOf(data);
    expect(r.lineage.status).toBe("unreferenced");
    expect(r.lineage.message).toMatch(/every appearance in it comes from words only/);
    const acks = referenceIntegrityAcknowledgements(r);
    expect(acks.map((a) => a.id)).toEqual([ACK_REFERENCE_MISSING]);
    expect(acks[0]!.label).toMatch(
      /^No stored reference image for Yumeko — Identity, Yumeko — Episode 1 — Formal Black Look and /,
    );
  });

  it("UNVERIFIABLE: an uploaded frame is the filmmaker's own picture; it is disclosed, never gated", () => {
    const data = seed();
    withVisualBible(data);
    const image = newUploadAsset(data.project.id, { label: "upload-3A", width: 1536, height: 642 });
    data.assets.push(image);
    const frame: ProductionFrame = { ...draftFor(data, "3A", { asset: image }), version: 1 };
    attach(data, [frame], frame);
    const r = integrityOf(data);
    expect(r.lineage.status).toBe("unverifiable");
    expect(r.lineage.message).toMatch(/Uploaded, not generated from this Shot's references.*check it by eye/);
    expect(r.verified).toBe(false);
    expect(referenceIntegrityAcknowledgements(r)).toEqual([]);
  });

  it("an edit inherits what the image it was edited from consumed (lineage follows the chain)", () => {
    const data = seed();
    const vb = withVisualBible(data);
    const shot = shotByCode(data, "3A");
    const first = generatedImage(data, "first-still");
    frameAttempt(data, shot.id, {
      inputs: [vb.canonical.id, vb.lookRef.id, vb.viewImage.id],
      output: first.id,
    });
    // the selected frame is an EDIT of that still: its own request carried only the source image
    generatedFrame(data, [first.id], "edited-still");
    const r = integrityOf(data);
    expect(r.lineage.status).toBe("verified");
    const edit = data.attempts[data.attempts.length - 1]!;
    expect([...consumedAssetIds(edit.id, data.attempts)].sort()).toEqual(
      [first.id, vb.canonical.id, vb.lookRef.id, vb.viewImage.id].sort(),
    );
  });

  it("without a designated Canonical Identity the first stored identity image is the slot, and it says so", () => {
    const data = seed();
    const front = uploadIdentity(data, "Yumeko", "front");
    const r = integrityOf(data);
    expect(r.slots[0]).toMatchObject({
      status: "ready",
      assetId: front.id,
      label: "Identity reference (no Canonical Identity is designated)",
      origin: "uploaded",
    });
    expect(characterByName(data, "Yumeko").name).toBe("Yumeko");
  });

  it("with a selected Continuity Lock the slots are the Lock's frozen images, and lineage is checked against them", () => {
    const data = seed();
    const { front, ivory, ivoryRef } = yumekoIvory(data, "3A");
    const lock = lockFor(data, "Yumeko", ivory, { name: "Yumeko — Ivory" });
    attachLocks(data, [lock], [{ code: "3A", lock }]);
    generatedFrame(data, [front.id]); // the Look image never reached this frame
    const r = integrityOf(data);
    expect(r.slots[0]).toMatchObject({
      kind: "identity",
      label: 'Continuity Lock "Yumeko — Ivory" identity',
      status: "ready",
      assetId: front.id,
      detail: "Frozen by the selected Continuity Lock.",
    });
    expect(r.slots[1]).toMatchObject({
      kind: "look",
      label: "Ivory Suit Look",
      status: "ready",
      assetId: ivoryRef.id,
    });
    expect(r.lineage.status).toBe("partial");
    expect(r.lineage.consumed.map((s) => s.kind)).toEqual(["identity"]);
    expect(r.lineage.missing.map((s) => s.label)).toEqual(["Ivory Suit Look"]);
  });
});

/** A fresh, selected, GENERATED Production Frame for 3A (hosted geometry), with the Visual Bible in place. */
function animatable(inputs: (vb: ReturnType<typeof withVisualBible>) => string[]) {
  const data = seed();
  const vb = withVisualBible(data);
  const made = generatedFrame(data, inputs(vb));
  return { data, shot: vb.shot, vb, ...made };
}

const evaluate = (
  data: ProjectData,
  shotId: string,
  modelId: string,
  provider = "runway",
  verdicts?: OutcomeRecord[],
) =>
  evaluateShotForModel({
    data,
    shotId,
    registry,
    provider,
    modelId,
    purpose: ANIM,
    adaptation: provider === "runway" ? ADAPTED : undefined,
    verdicts,
  });

describe("the spend gate asks for the reference check on a paid animation", () => {
  it("a verified frame adds nothing; a partial one adds the lineage acknowledgement (Gen-4.5 and Gen-4 Turbo)", () => {
    const ok = animatable((vb) => [vb.canonical.id, vb.lookRef.id, vb.viewImage.id]);
    const bad = animatable((vb) => [vb.viewImage.id]);
    for (const modelId of ["gen4.5", "gen4_turbo"]) {
      const clean = evaluate(ok.data, ok.shot.id, modelId);
      expect(clean.gate.blockers).toEqual([]);
      expect(clean.gate.unacknowledged.filter((f) => isPreSpendAcknowledgement(f.id))).toEqual([]);
      const flagged = evaluate(bad.data, bad.shot.id, modelId);
      expect(flagged.gate.blockers).toEqual([]);
      expect(flagged.gate.allowed).toBe(false); // not until acknowledged
      expect(flagged.gate.unacknowledged.map((f) => f.id)).toContain(ACK_FRAME_LINEAGE);
    }
  });

  it("the request itself carries the frame and no reference image: that is why the frame is what gets checked", () => {
    const { data, shot, image } = animatable((vb) => [vb.canonical.id, vb.lookRef.id, vb.viewImage.id]);
    const ev = evaluate(data, shot.id, "gen4.5");
    const prepared = prepareSubmission({
      data,
      shotId: shot.id,
      registry,
      provider: "runway",
      modelId: "gen4.5",
      acknowledged: ev.gate.unacknowledged.map((f) => f.id),
      adaptation: ADAPTED,
      purpose: ANIM,
      userId: null,
      idempotencyKey: "pre-spend-01",
      config,
    });
    const request = prepared.input!.attempt.request as unknown as GenerationRequest;
    expect(request.startFrameAssetId).toBe(image.id);
    expect(request.references).toEqual([]);
    expect(prepared.input!.attempt.inputAssetIds).toEqual([image.id]);
    // the model's inability to take references is disclosed for the references that exist
    expect(ev.gate.unacknowledged.map((f) => f.id)).toEqual(expect.arrayContaining(["references.identity"]));
  });

  it("free (mock) models are never gated by it; the acknowledgement is recorded on a paid attempt", () => {
    const { data, shot } = animatable((vb) => [vb.viewImage.id]);
    // every free video model that can take this Shot: the same partial frame, no pre-spend acknowledgement
    const free = registry
      .models()
      .filter((m) => m.capabilities.video != null && !registry.billsMoney(m))
      .map((m) =>
        evaluateShotForModel({
          data,
          shotId: shot.id,
          registry,
          provider: m.provider,
          modelId: m.modelId,
          purpose: ANIM,
          adaptation: ADAPTED,
        }),
      )
      .filter((e) => e.compatibility?.compatible);
    expect(free.length).toBeGreaterThan(0);
    for (const e of free)
      expect(e.gate.unacknowledged.filter((f) => isPreSpendAcknowledgement(f.id))).toEqual([]);

    const ev = evaluate(data, shot.id, "gen4_turbo");
    const prepared = prepareSubmission({
      data,
      shotId: shot.id,
      registry,
      provider: "runway",
      modelId: "gen4_turbo",
      acknowledged: ev.gate.unacknowledged.map((f) => f.id),
      adaptation: ADAPTED,
      purpose: ANIM,
      userId: null,
      idempotencyKey: "pre-spend-02",
      config,
    });
    expect(prepared.input).not.toBeNull();
    expect(prepared.input!.attempt.acknowledgedIgnored).toContain(ACK_FRAME_LINEAGE);
    const frozen = prepared.input!.attempt.compatibility as { ignoredFeatures: Array<{ id: string }> };
    expect(frozen.ignoredFeatures.map((f) => f.id)).toContain(ACK_FRAME_LINEAGE);
  });
});

/** A succeeded animation attempt exactly as `prepareSubmission` freezes it, optionally rejected on the attempt. */
function priorAnimation(data: ProjectData, shotId: string, modelId: string, key: string): GenerationAttempt {
  const ev = evaluate(data, shotId, modelId);
  const prepared = prepareSubmission({
    data,
    shotId,
    registry,
    provider: "runway",
    modelId,
    acknowledged: ev.gate.unacknowledged.map((f) => f.id),
    adaptation: ADAPTED,
    purpose: ANIM,
    userId: null,
    idempotencyKey: key,
    config,
  });
  const attempt: GenerationAttempt = {
    ...prepared.input!.attempt,
    attemptNumber: data.attempts.filter((a) => a.shotId === shotId).length + 1,
    status: "succeeded",
    outputAssetId: randomUUID(),
  };
  data.attempts.push(attempt);
  return attempt;
}

const rejected = (attempt: GenerationAttempt, tags: OutcomeRecord["negativeTags"]): OutcomeRecord =>
  ({
    attemptId: attempt.id,
    projectId: attempt.projectId,
    provider: attempt.provider,
    model: attempt.model,
    purpose: ANIM,
    decision: "reject",
    negativeTags: tags,
    positiveTags: [],
    preferred: false,
    inCandidateSet: true,
    actualCostUsd: 0.6,
    estimatedCostUsd: 0.6,
    generationMs: null,
    totalMs: null,
    profile: null,
    benchmark: false,
    status: "succeeded",
    createdAt: T,
  }) satisfies OutcomeRecord;

describe("rejected takes inform the next attempt", () => {
  const VERIFIED = (vb: ReturnType<typeof withVisualBible>) => [
    vb.canonical.id,
    vb.lookRef.id,
    vb.viewImage.id,
  ];

  it("a request identical to a rejected take needs its own acknowledgement, with the recorded reasons", () => {
    const { data, shot } = animatable(VERIFIED);
    const take = priorAnimation(data, shot.id, "gen4.5", "pre-spend-take-1");
    const verdicts = [rejected(take, ["body_motion", "composition"])];
    const ev = evaluate(data, shot.id, "gen4.5", "runway", verdicts);
    const ack = ev.gate.unacknowledged.find((f) => f.id === ACK_IDENTICAL_RETAKE)!;
    expect(ack.label).toBe(
      `Identical to rejected take #${take.attemptNumber} (rejected for body motion, composition)`,
    );
    expect(ack.impact).toMatch(/same frame, model, prompt and duration would be sent again/);
    expect(isPreSpendAcknowledgement(ack.id)).toBe(true);
    // an unreviewed or approved identical take asks for nothing; neither does the SAME verdict on another model
    expect(evaluate(data, shot.id, "gen4.5").gate.unacknowledged.map((f) => f.id)).not.toContain(
      ACK_IDENTICAL_RETAKE,
    );
    expect(
      evaluate(data, shot.id, "gen4_turbo", "runway", verdicts).gate.unacknowledged.map((f) => f.id),
    ).not.toContain(ACK_IDENTICAL_RETAKE);
  });

  it("an attempt rejected through the Shot-output review counts too, with its categories", () => {
    const { data, shot } = animatable(VERIFIED);
    const take = priorAnimation(data, shot.id, "gen4_turbo", "pre-spend-take-2");
    take.reviewStatus = "rejected";
    take.rejectionCategories = ["bad_motion"];
    take.rejectionReason = "Turned through frontal to screen-left.";
    const ev = evaluate(data, shot.id, "gen4_turbo");
    expect(ev.gate.unacknowledged.find((f) => f.id === ACK_IDENTICAL_RETAKE)!.label).toMatch(
      /^Identical to rejected take #\d+ \(rejected for /,
    );
  });

  it("a take sent under the historical v1 prompt is NOT identical to today's request (the instruction changed)", () => {
    const { data, shot } = animatable(VERIFIED);
    const take = priorAnimation(data, shot.id, "gen4.5", "pre-spend-take-3");
    // what the rejected Gen-4.5 take actually froze: the v1 text (negations and restated Look)
    const req = take.request as {
      providerOptions: { prismProviderPrompt: { text: string; length: number; policy: { version: number } } };
    };
    const v1Text = `${req.providerOptions.prismProviderPrompt.text} She never rotates through frontal.`;
    req.providerOptions.prismProviderPrompt = {
      ...req.providerOptions.prismProviderPrompt,
      text: v1Text,
      length: v1Text.length,
      policy: { ...req.providerOptions.prismProviderPrompt.policy, version: 1 },
    };
    const verdicts = [rejected(take, ["body_motion"])];
    const now = prepareSubmission({
      data,
      shotId: shot.id,
      registry,
      provider: "runway",
      modelId: "gen4.5",
      acknowledged: evaluate(data, shot.id, "gen4.5", "runway", verdicts).gate.unacknowledged.map(
        (f) => f.id,
      ),
      adaptation: ADAPTED,
      purpose: ANIM,
      userId: null,
      idempotencyKey: "pre-spend-take-4",
      config,
      verdicts,
    }).input!.attempt.request as unknown as GenerationRequest;
    const prior = priorTakes({ attempts: data.attempts, verdicts, shotId: shot.id, request: now });
    expect(prior).toEqual([
      expect.objectContaining({
        attemptId: take.id,
        decision: "reject",
        reasons: ["Body motion"],
        promptPolicy: "visible-motion@v1",
        identical: false,
      }),
    ]);
    expect(retakeAcknowledgements(prior)).toEqual([]);
    expect(takeSignature(now)).not.toBe(takeSignature(take.request as unknown as GenerationRequest));
  });

  it("takes from another Production Frame are not this frame's history", () => {
    const { data, shot, vb } = animatable(VERIFIED);
    const take = priorAnimation(data, shot.id, "gen4.5", "pre-spend-take-5");
    const verdicts = [rejected(take, ["character_identity"])];
    generatedFrame(data, [vb.canonical.id, vb.lookRef.id, vb.viewImage.id], "frame-3A-v2");
    const ev = evaluate(data, shot.id, "gen4.5", "runway", verdicts);
    expect(ev.gate.unacknowledged.map((f) => f.id)).not.toContain(ACK_IDENTICAL_RETAKE);
  });
});

describe("candidate sets: the pre-spend check is confirmed on its own, never inside 'acknowledge all'", () => {
  const selections = [{ provider: "runway", modelId: "gen4_turbo" }];

  /** A repository holding the project AND the same selected frame (a submit re-checks the selection in storage). */
  async function repoWith(data: ProjectData, draft: ReturnType<typeof generatedFrame>["draft"]) {
    const repo = new MemoryRepository([data]);
    await repo.productionFrames.create({ draft, newAsset: null, select: true, userId: null, now: T });
    return repo;
  }

  it("the plan lists the checks per paid model, and the comparison panel gets the same list", () => {
    const { data, shot } = animatable((vb) => [vb.viewImage.id]);
    const plan = planCandidateSet({
      data,
      shotId: shot.id,
      registry,
      config,
      selections,
      outcomes: [],
      purpose: ANIM,
    });
    expect(plan.allowed).toBe(true);
    expect(preSpendChecks(plan)).toEqual([
      expect.objectContaining({
        provider: "runway",
        modelId: "gen4_turbo",
        check: expect.objectContaining({ id: ACK_FRAME_LINEAGE }),
      }),
    ]);
    const byModel = animationPreSpendByModel({ data, shotId: shot.id, registry, config, outcomes: [] });
    expect(byModel["runway/gen4_turbo"]!.map((c) => c.id)).toEqual([ACK_FRAME_LINEAGE]);
    expect(byModel["runway/gen4.5"]!.map((c) => c.id)).toEqual([ACK_FRAME_LINEAGE]);
    expect(Object.keys(byModel).every((k) => k.startsWith("runway/"))).toBe(true); // never a free model
  });

  it("'acknowledge all' alone is refused; with the separate confirmation the set is created (nothing is sent)", async () => {
    const { data, shot, draft } = animatable((vb) => [vb.viewImage.id]);
    const repo = await repoWith(data, draft);
    const submit = (acknowledgePreSpend: boolean) =>
      submitCandidateSet({
        data,
        shotId: shot.id,
        registry,
        config,
        generation: repo.generation,
        candidates: repo.candidates,
        selections,
        acknowledgeAll: true,
        acknowledgePreSpend,
        confirmedTotalUsd: 0.25,
        title: "Animation candidates",
        purpose: "pre-spend",
        userId: null,
        projectRevision: null,
        generationPurpose: ANIM,
      });
    await expect(submit(false)).rejects.toThrowError(CandidateSetBlockedError);
    await expect(submit(false)).rejects.toThrow(
      /Confirm the pre-spend check before generating: Production Frame v1 was generated without Yumeko — Canonical Identity/,
    );
    expect(
      (await repo.loadProject(data.project.slug))!.attempts.filter(
        (a) => a.shotId === shot.id && a.provider === "runway",
      ),
    ).toEqual([]);
    const out = await submit(true);
    expect(out.failed).toEqual([]);
    expect(out.submitted).toBe(1);
    const created = (await repo.loadProject(data.project.slug))!.attempts.find(
      (a) => a.provider === "runway",
    )!;
    expect(created.status).toBe("queued"); // queued only: no worker ran, no provider was called
    expect(created.acknowledgedIgnored).toContain(ACK_FRAME_LINEAGE);
  });

  it("a verified frame needs no separate confirmation", async () => {
    const { data, shot, draft } = animatable((vb) => [vb.canonical.id, vb.lookRef.id, vb.viewImage.id]);
    const repo = await repoWith(data, draft);
    const out = await submitCandidateSet({
      data,
      shotId: shot.id,
      registry,
      config,
      generation: repo.generation,
      candidates: repo.candidates,
      selections,
      acknowledgeAll: true,
      confirmedTotalUsd: 0.25,
      title: "Animation candidates",
      purpose: "pre-spend",
      userId: null,
      projectRevision: null,
      generationPurpose: ANIM,
    });
    expect(out.failed).toEqual([]);
    expect(out.submitted).toBe(1);
  });
});
