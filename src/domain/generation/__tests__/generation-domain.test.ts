import { describe, expect, it } from "vitest";
import { buildSeedProject } from "@/data/seed";
import { buildShotContext } from "@/domain/context";
import { assembleGenerationPackage, type GenerationPackage } from "@/domain/generation-package";
import { runPreflight } from "@/domain/preflight";
import { MockProvider } from "@/generation/providers/mock";
import { evaluateCompatibility } from "../compatibility";
import { estimateCostFromCapabilities } from "../cost";
import {
  DEFAULT_RETRY_POLICY,
  GenerationProviderError,
  backoffDelayMs,
  decideRetry,
  isRetryable,
} from "../errors";
import { buildGenerationRequest, evaluateGate, extendPreflightWithCompatibility } from "../gate";
import {
  ACTIVE_STATUSES,
  IllegalTransitionError,
  TERMINAL_STATUSES,
  allowedTransitions,
  assertTransition,
  canTransition,
} from "../job-state";
import { deriveShotGenerationState } from "../lifecycle";
import { buildPromptPlan, renderPromptPlan } from "../prompt-plan";
import { JOB_STATUSES, modelAvailabilitySchema, type GenerationModel } from "../schemas";
import { generationSignature } from "../signature";

const provider = new MockProvider({ stageDelayMs: 0 });
const models = provider.listModels();
const model = (id: string): GenerationModel => models.find((m) => m.modelId === id)!;

function seededPackage(code = "3A") {
  const data = buildSeedProject();
  const shot = data.shots.find((s) => s.shotCode === code)!;
  const ctx = buildShotContext(data, shot.id);
  return { data, ctx, pkg: assembleGenerationPackage(ctx, new Date("2026-01-01T00:00:00Z")) };
}

/** Deep copy with a mutation applied, so fixtures never leak between tests. */
function withPackage(pkg: GenerationPackage, mutate: (p: GenerationPackage) => void): GenerationPackage {
  const copy = structuredClone(pkg);
  mutate(copy);
  return copy;
}

describe("job state machine", () => {
  it("terminal states have no way out; active states are exactly the non-terminal ones", () => {
    for (const s of TERMINAL_STATUSES) expect(allowedTransitions(s)).toEqual([]);
    expect([...ACTIVE_STATUSES, ...TERMINAL_STATUSES].sort()).toEqual([...JOB_STATUSES].sort());
  });

  it("allows the documented happy path and retry loop", () => {
    const path = ["queued", "submitting", "submitted", "processing", "ingesting", "succeeded"] as const;
    for (let i = 0; i < path.length - 1; i++) expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
    expect(canTransition("submitting", "queued")).toBe(true); // transient submit error → retry
    expect(canTransition("processing", "cancel_requested")).toBe(true);
    expect(canTransition("cancel_requested", "cancelled")).toBe(true);
  });

  it("rejects illegal transitions with a typed error", () => {
    expect(canTransition("queued", "succeeded")).toBe(false);
    expect(canTransition("succeeded", "queued")).toBe(false);
    expect(canTransition("cancelled", "processing")).toBe(false);
    expect(() => assertTransition("failed", "queued")).toThrow(IllegalTransitionError);
  });
});

describe("retry policy", () => {
  it("only transient-ish categories retry; policy rejections never do", () => {
    for (const c of ["transient", "rate_limit", "provider_unavailable", "timeout"] as const) {
      expect(isRetryable(c)).toBe(true);
    }
    for (const c of ["invalid_request", "content_rejected", "auth", "quota", "permanent"] as const) {
      expect(isRetryable(c)).toBe(false);
    }
    expect(new GenerationProviderError("content_rejected", "x", "m").retryable).toBe(false);
    expect(new GenerationProviderError("timeout", "job_timeout", "m", { retryable: false }).retryable).toBe(
      false,
    );
  });

  it("backoff grows exponentially, is capped and honours Retry-After", () => {
    const rnd = () => 0;
    const d = [1, 2, 3, 4].map((n) => backoffDelayMs(n, DEFAULT_RETRY_POLICY, null, rnd));
    expect(d).toEqual([5000, 10_000, 20_000, 40_000]);
    expect(backoffDelayMs(20, DEFAULT_RETRY_POLICY, null, rnd)).toBe(DEFAULT_RETRY_POLICY.maxDelayMs);
    expect(backoffDelayMs(1, DEFAULT_RETRY_POLICY, 60_000, rnd)).toBe(60_000);
  });

  it("stops after max attempts", () => {
    expect(decideRetry({ category: "transient" }, 1, 3).retry).toBe(true);
    expect(decideRetry({ category: "transient" }, 3, 3)).toMatchObject({
      retry: false,
      reason: "attempts_exhausted",
    });
    expect(decideRetry({ category: "content_rejected" }, 1, 3)).toMatchObject({
      retry: false,
      reason: "not_retryable",
    });
  });
});

describe("cost estimation", () => {
  it("is deterministic from declared pricing and never invents numbers", () => {
    const e = estimateCostFromCapabilities(model("mock-video-1").capabilities, {
      durationMs: 4500,
      outputs: 1,
    });
    expect(e.amount).toBe(0.225);
    expect(e.currency).toBe("USD");
    const lite = estimateCostFromCapabilities(model("mock-image-1").capabilities, {
      durationMs: null,
      outputs: 2,
    });
    expect(lite.amount).toBe(0.04);
    const unknown = estimateCostFromCapabilities(
      {
        ...model("mock-video-1").capabilities,
        commercial: { pricing: "unknown", currency: "USD", costUnit: "", unitCost: null },
      },
      { durationMs: 4500, outputs: 1 },
    );
    expect(unknown.amount).toBeNull();
  });
});

describe("compatibility engine", () => {
  const { pkg } = seededPackage("3A");

  it("a fully capable model is compatible with 3A and keeps performed audio", () => {
    const r = evaluateCompatibility(pkg, model("mock-video-1"));
    expect(r.errors).toEqual([]);
    expect(r.compatible).toBe(true);
    expect(r.modality).toBe("image_to_video");
    expect(r.used.durationMs).toBe(pkg.timing.durationMs); // never rounded
    expect(r.used.audioAssetIds.length).toBeGreaterThan(0);
    expect(r.ignoredFeatures.map((f) => f.id)).not.toContain("performance_audio");
  });

  it("does not silently round duration: 4.5 s against a 5 s / 10 s model is an error", () => {
    const r = evaluateCompatibility(pkg, model("mock-video-lite"));
    expect(r.compatible).toBe(false);
    const err = r.errors.find((e) => e.id === "duration.unsupported")!;
    expect(err.message).toContain("4.5s");
    expect(err.message).toContain("5s, 10s");
    expect(r.duration).toMatchObject({ productionMs: 4500, ok: false });
    expect(r.used.durationMs).toBeNull();
  });

  it("lists, never drops, the intent a model cannot honour", () => {
    const withEnd = withPackage(pkg, (p) => {
      const startFrame = p.references.startFrameAssetId;
      p.references.endFrameAssetId = Object.keys(p.assets).find((a) => a !== startFrame) ?? startFrame;
    });
    const r = evaluateCompatibility(withEnd, model("mock-video-lite"));
    const ids = r.ignoredFeatures.map((f) => f.id);
    expect(ids).toContain("end_frame");
    expect(ids).toContain("performance_audio");
    const audio = r.ignoredFeatures.find((f) => f.id === "performance_audio")!;
    expect(audio.impact).toMatch(/will NOT condition/);
    expect(r.inputs.some((i) => i.kind === "audio" && !i.used)).toBe(true);
  });

  it("too many references is a hard error naming both numbers", () => {
    const r = evaluateCompatibility(pkg, {
      ...model("mock-video-1"),
      capabilities: {
        ...model("mock-video-1").capabilities,
        references: { ...model("mock-video-1").capabilities.references, maxReferences: 1 },
      },
    });
    const e = r.errors.find((x) => x.id === "references.too_many");
    expect(e?.message).toMatch(/at most 1/);
  });

  it("unsupported aspect ratio is an error", () => {
    const r = evaluateCompatibility(
      withPackage(pkg, (p) => (p.style.aspectRatio = "5:4")),
      model("mock-video-lite"),
    );
    expect(r.errors.map((e) => e.id)).toContain("aspect_ratio.unsupported");
  });

  it("an image model cannot satisfy a video shot", () => {
    const r = evaluateCompatibility(pkg, model("mock-image-1"));
    expect(r.compatible).toBe(false);
    expect(r.errors[0]!.id).toBe("modality.unsupported");
  });

  it("image_to_video without any start frame is an error, not a silent text-to-video", () => {
    const noFrame = withPackage(pkg, (p) => {
      p.references.startFrameAssetId = null;
      p.references.approvedStoryboardFrame = null;
      p.generation.modality = "image_to_video";
    });
    const r = evaluateCompatibility(noFrame, model("mock-video-1"));
    expect(r.errors.map((e) => e.id)).toContain("start_frame.missing");
  });
});

describe("prompt plan", () => {
  it("is deterministic and sectioned, not one paragraph", () => {
    const { pkg } = seededPackage("3A");
    const a = buildPromptPlan(pkg);
    const b = buildPromptPlan(structuredClone(pkg));
    expect(a).toEqual(b);
    const keys = a.sections.map((s) => s.key);
    expect(keys).toEqual(
      expect.arrayContaining(["subject", "wardrobe", "environment", "camera", "timing", "performance"]),
    );
    expect(renderPromptPlan(a)).not.toMatch(/Negative constraints:/);
    expect(renderPromptPlan(a, { includeNegative: true })).toContain("Timing:");
  });
});

describe("gate", () => {
  const { ctx, pkg } = seededPackage("3A");
  const preflight = runPreflight(ctx);
  const mk = (
    modelId: string,
    ack: string[] = [],
    over: Partial<Parameters<typeof evaluateGate>[0]> = {},
  ) => {
    const m = model(modelId);
    const compat = evaluateCompatibility(pkg, m);
    return evaluateGate({
      preflight,
      pkg,
      model: m,
      availability: modelAvailabilitySchema.parse({
        provider: m.provider,
        providerName: "Mock",
        modelId: m.modelId,
        displayName: m.displayName,
        description: m.description,
        kind: m.kind,
        modalities: m.capabilities.modalities,
        paidGenerationEnabled: true,
        enabled: true,
        configured: true,
        missingConfig: [],
        available: true,
        lifecycle: m.lifecycle,
      }),
      compatibility: compat,
      acknowledged: ack,
      ...over,
    });
  };

  it("3A is ready and allowed with a capable model", () => {
    expect(preflight.ready).toBe(true);
    expect(mk("mock-video-1").allowed).toBe(true);
  });

  it("duration incompatibility blocks with a structured blocker", () => {
    const g = mk("mock-video-lite");
    expect(g.allowed).toBe(false);
    expect(g.blockers.map((b) => b.code)).toContain("compatibility.duration.unsupported");
  });

  it("ignored features block until each one is acknowledged", () => {
    const tweaked = withPackage(pkg, (p) => {
      p.timing.durationMs = 5000;
    });
    const m = model("mock-video-lite");
    const compat = evaluateCompatibility(tweaked, m);
    expect(compat.errors).toEqual([]);
    expect(compat.ignoredFeatures.length).toBeGreaterThan(0);
    const base = {
      preflight,
      pkg: tweaked,
      model: m,
      availability: {
        available: true,
        enabled: true,
        configured: true,
        missingConfig: [],
        lifecycle: "active",
        providerName: "Mock",
      } as never,
      compatibility: compat,
    };
    expect(evaluateGate({ ...base, acknowledged: [] }).allowed).toBe(false);
    expect(evaluateGate({ ...base, acknowledged: compat.ignoredFeatures.map((f) => f.id) }).allowed).toBe(
      true,
    );
  });

  it("a stale storyboard blocks generation", () => {
    const stale = withPackage(pkg, (p) => {
      p.freshness.storyboard = { ...p.freshness.storyboard, status: "stale", messages: ["Camera changed"] };
    });
    const g = mk("mock-video-1", [], { pkg: stale });
    expect(g.blockers.map((b) => b.code)).toContain("freshness.storyboard_stale");
  });

  it("an unconfigured or disabled model is refused with the missing configuration NAMED", () => {
    const g = mk("mock-video-1", [], {
      availability: {
        provider: "x",
        providerName: "Provider X",
        modelId: "m",
        displayName: "M",
        description: "",
        kind: "real",
        modalities: ["text_to_video"],
        enabled: true,
        configured: false,
        paidGenerationEnabled: true,
        missingConfig: ["PRISM_STUDIO_PROVIDER_X_API_KEY"],
        available: false,
        lifecycle: "active",
      },
    });
    const msg = g.blockers.find((b) => b.code === "model.not_configured")!.message;
    expect(msg).toContain("PRISM_STUDIO_PROVIDER_X_API_KEY");
  });

  it("compatibility results appear as preflight items", () => {
    const compat = evaluateCompatibility(pkg, model("mock-video-lite"));
    const extended = extendPreflightWithCompatibility(preflight, compat);
    expect(extended.ready).toBe(false);
    expect(extended.blockers.some((b) => b.ruleId.startsWith("generation.compat."))).toBe(true);
    expect(preflight.ready).toBe(true); // input untouched
  });

  it("the request an adapter receives carries only what the model will use", () => {
    const m = model("mock-video-1");
    const compat = evaluateCompatibility(pkg, m);
    const req = buildGenerationRequest({
      pkg,
      model: m,
      compatibility: compat,
      plan: buildPromptPlan(pkg),
      idempotencyKey: "abcdefgh-key",
    });
    expect(req.modality).toBe("image_to_video");
    expect(req.durationMs).toBe(pkg.timing.durationMs);
    expect(req.references.every((r) => typeof r.order === "number")).toBe(true);
    expect(JSON.stringify(req)).not.toMatch(/api[_-]?key|secret|authorization/i);
  });
});

describe("shot generation lifecycle (derived, not stored)", () => {
  const a = (
    n: number,
    status: "queued" | "running" | "succeeded" | "failed" | "cancelled",
    review: "unreviewed" | "approved" | "rejected",
  ) => ({
    id: `a${n}`,
    attemptNumber: n,
    status,
    reviewStatus: review,
    approved: review === "approved",
  });
  const j = (attemptId: string, status: (typeof JOB_STATUSES)[number]) => ({ attemptId, status });

  it("walks READY → QUEUED → GENERATING → READY FOR REVIEW → NEEDS REDO → APPROVED", () => {
    expect(deriveShotGenerationState({ ready: false, attempts: [], jobs: [] })).toBe("not_ready");
    expect(deriveShotGenerationState({ ready: true, attempts: [], jobs: [] })).toBe("ready");
    expect(
      deriveShotGenerationState({
        ready: true,
        attempts: [a(1, "queued", "unreviewed")],
        jobs: [j("a1", "queued")],
      }),
    ).toBe("queued");
    expect(
      deriveShotGenerationState({
        ready: true,
        attempts: [a(1, "running", "unreviewed")],
        jobs: [j("a1", "processing")],
      }),
    ).toBe("generating");
    expect(
      deriveShotGenerationState({
        ready: true,
        attempts: [a(1, "succeeded", "unreviewed")],
        jobs: [j("a1", "succeeded")],
      }),
    ).toBe("ready_for_review");
    expect(
      deriveShotGenerationState({
        ready: true,
        attempts: [a(1, "succeeded", "rejected")],
        jobs: [j("a1", "succeeded")],
      }),
    ).toBe("needs_redo");
    expect(
      deriveShotGenerationState({
        ready: true,
        attempts: [a(1, "failed", "unreviewed")],
        jobs: [j("a1", "failed")],
      }),
    ).toBe("needs_redo");
    expect(
      deriveShotGenerationState({
        ready: false,
        attempts: [a(1, "succeeded", "rejected"), a(2, "succeeded", "approved")],
        jobs: [],
      }),
    ).toBe("approved");
  });
});

describe("status signature", () => {
  it("changes when state changes and is order independent", () => {
    const base = [
      { attemptId: "aaaaaaaa-1", jobStatus: "queued", attemptStatus: "queued", review: "unreviewed" },
      { attemptId: "bbbbbbbb-2", jobStatus: "succeeded", attemptStatus: "succeeded", review: "approved" },
    ];
    const s1 = generationSignature(base);
    expect(generationSignature([...base].reverse())).toBe(s1);
    expect(generationSignature([{ ...base[0]!, jobStatus: "processing" }, base[1]!])).not.toBe(s1);
  });
});
