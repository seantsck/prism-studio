import { describe, expect, it } from "vitest";
import {
  applyJobPatch,
  canTransition,
  FREE_COST_ESTIMATE,
  inputModeOf,
  isProviderId,
  jobCostEstimateSchema,
  jobSourceSchema,
  idempotencyKey,
  JOB_STATUSES,
  JobTransitionError,
  jobFingerprint,
  newJobRecord,
  orderedSources,
  sanitizeErrorMessage,
  sanitizeProviderPayload,
  validateSources,
  type JobIdentity,
  type NewReconstructionJob,
} from "../job";

const src = (id: string, checksum = `sum-${id}`) => ({
  assetId: id,
  checksum,
  mime: "image/png",
  width: 640,
  height: 480,
  byteSize: 1234,
});
const identity = (over: Partial<JobIdentity> = {}): JobIdentity => ({
  projectId: "p",
  locationId: "l",
  sources: orderedSources([src("a"), src("b"), src("c")]),
  provider: "worldlabs_marble",
  capability: "worlds:generate",
  model: "marble-1.1",
  resultKind: "gaussian_splat",
  options: { displayName: null, provider: { reconstructImages: false } },
  ...over,
});

describe("job fingerprint", () => {
  it("is deterministic and ignores the display name and option key order", () => {
    const a = jobFingerprint(identity());
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(jobFingerprint(identity())).toBe(a);
    expect(
      jobFingerprint(identity({ options: { displayName: "Lobby", provider: { reconstructImages: false } } })),
    ).toBe(a);
    expect(
      jobFingerprint(
        identity({ options: { displayName: null, provider: { seed: 3, reconstructImages: true } } }),
      ),
    ).toBe(
      jobFingerprint(
        identity({ options: { displayName: null, provider: { reconstructImages: true, seed: 3 } } }),
      ),
    );
  });
  it("INPUT ORDER is identity: the primary image matters", () => {
    const reordered = identity({ sources: orderedSources([src("b"), src("a"), src("c")]) });
    expect(jobFingerprint(reordered)).not.toBe(jobFingerprint(identity()));
  });
  it("changes with content, provider, capability, model, result kind and provider options", () => {
    const base = jobFingerprint(identity());
    expect(
      jobFingerprint(identity({ sources: orderedSources([src("a", "NEW"), src("b"), src("c")]) })),
    ).not.toBe(base);
    expect(jobFingerprint(identity({ provider: "mock_reconstruction" }))).not.toBe(base);
    expect(jobFingerprint(identity({ capability: "other" }))).not.toBe(base);
    expect(jobFingerprint(identity({ model: "marble-1.0-draft" }))).not.toBe(base);
    expect(jobFingerprint(identity({ resultKind: "mesh" }))).not.toBe(base);
    expect(
      jobFingerprint(identity({ options: { displayName: null, provider: { reconstructImages: true } } })),
    ).not.toBe(base);
    expect(jobFingerprint(identity({ locationId: "other" }))).not.toBe(base);
  });
  it("excludes status, progress, operation ids, timestamps and poll counts (they are not inputs)", () => {
    const input: NewReconstructionJob = {
      ...identity(),
      id: "j1",
      attempt: 1,
      previousJobId: null,
      status: "queued",
      userId: null,
      now: "2026-10-18T00:00:00Z",
      costEstimate: null,
    };
    const r = newJobRecord(input);
    const later = {
      ...r,
      status: "running" as const,
      progress: 0.5,
      providerOperationId: "op",
      lastPolledAt: "x",
      updatedAt: "y",
    };
    expect(jobFingerprint({ ...later, options: later.options })).toBe(r.jobFingerprint);
  });
});

describe("sources", () => {
  it("keep the user's order (never sorted) and are validated", () => {
    const s = orderedSources([src("z"), src("a")]);
    expect(s.map((x) => [x.ordinal, x.assetId])).toEqual([
      [0, "z"],
      [1, "a"],
    ]);
    expect(validateSources(s)).toEqual({ ok: true });
    expect(validateSources([]).ok).toBe(false);
    expect(validateSources(orderedSources([src("a"), src("a")])).ok).toBe(false);
    expect(validateSources(orderedSources([{ ...src("a"), mime: "video/mp4" }])).ok).toBe(false);
    // Prism's own ceiling is 300 (a local capture needs many photos); each provider declares a lower maximum
    expect(validateSources(orderedSources(Array.from({ length: 9 }, (_, i) => src(`s${i}`)))).ok).toBe(true);
    expect(validateSources(orderedSources(Array.from({ length: 301 }, (_, i) => src(`s${i}`)))).ok).toBe(
      false,
    );
  });
});

describe("status transitions", () => {
  it("follow the explicit matrix; terminal states never move", () => {
    expect(canTransition("queued", "submitting")).toBe(true);
    expect(canTransition("submitting", "running")).toBe(true);
    expect(canTransition("running", "running")).toBe(true);
    expect(canTransition("running", "ingesting")).toBe(true);
    expect(canTransition("ingesting", "succeeded")).toBe(true);
    expect(canTransition("queued", "running")).toBe(false);
    expect(canTransition("submitting", "succeeded")).toBe(false);
    expect(canTransition("ingesting", "running")).toBe(false);
    for (const t of ["succeeded", "failed", "cancelled"] as const)
      for (const to of JOB_STATUSES) expect(canTransition(t, to)).toBe(false);
  });

  const job = (status: NewReconstructionJob["status"] = "queued") =>
    newJobRecord({
      ...identity(),
      id: "j1",
      attempt: 1,
      previousJobId: null,
      status,
      userId: null,
      now: "t0",
      costEstimate: null,
    });

  it("applyJobPatch enforces the matrix, the frozen operation id, failure codes and CAS revision", () => {
    const q = job();
    const s = applyJobPatch(q, { status: "submitting" }, "t1");
    expect(s.revision).toBe(2);
    expect(() => applyJobPatch(q, { status: "running" }, "t1")).toThrow(JobTransitionError);
    expect(() => applyJobPatch(s, { status: "running" }, "t2")).toThrow(/operation id/);
    const r = applyJobPatch(s, { status: "running", providerOperationId: "op-1" }, "t2");
    expect(() => applyJobPatch(r, { providerOperationId: "op-2" }, "t3")).toThrow(/never replaced/);
    expect(() => applyJobPatch(r, { status: "failed" }, "t3")).toThrow(/error code/);
    const f = applyJobPatch(r, { status: "failed", errorCode: "provider_failed", errorMessage: "x" }, "t3");
    expect(f.completedAt).toBe("t3");
    expect(() => applyJobPatch(f, { progress: 0.2 }, "t4")).toThrow(/immutable/);
    expect(() => applyJobPatch(r, { status: "ingesting" }, "t4")).not.toThrow();
    // success only through completeReconstructionJob (with its reconstruction)
    const i = applyJobPatch(r, { status: "ingesting" }, "t4");
    expect(() => applyJobPatch(i, { status: "succeeded" }, "t5")).toThrow(/together with its reconstruction/);
  });
});

describe("idempotency key", () => {
  it("is stable per job attempt, differs per attempt, and fits provider limits", () => {
    const k = idempotencyKey("job-1", 1);
    expect(k).toBe(idempotencyKey("job-1", 1));
    expect(k).not.toBe(idempotencyKey("job-1", 2));
    expect(k).not.toBe(idempotencyKey("job-2", 1));
    expect(k.length).toBeLessThanOrEqual(32);
    expect(k).toMatch(/^pj[0-9a-f]{30}$/);
  });
});

describe("sanitising provider payloads and errors", () => {
  it("drops URLs, secret-named keys and bounds size", () => {
    const out = sanitizeProviderPayload({
      world_id: "w1",
      spz_urls: { full_res: "https://cdn.example/x.spz?X-Goog-Signature=abc" },
      upload_url: "https://storage.googleapis.com/x",
      api_key: "secret",
      progress: { status: "IN_PROGRESS", description: "Generating" },
      long: "x".repeat(2000),
    }) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toMatch(/https?:|Signature|secret/);
    expect(out.world_id).toBe("w1");
    expect((out.long as string).length).toBe(500);
  });
  it("redacts URLs and key material from error messages", () => {
    const m = sanitizeErrorMessage("failed at https://x.y/z?token=1 with WLT-Api-Key: abc123 api_key=zzz");
    expect(m).not.toMatch(/https?:|abc123|zzz/);
  });
});

describe("free-first readiness (provider ids, input kinds, cost provenance)", () => {
  it("provider ids are identifiers checked by shape, not a closed list (the registry decides what is known)", () => {
    for (const id of ["local_capture", "worldlabs_marble", "mock_reconstruction", "future_provider_2"])
      expect(isProviderId(id)).toBe(true);
    for (const id of ["", "Local", "1abc", "has-dash", "x".repeat(65), "drop table;", null, 3])
      expect(isProviderId(id)).toBe(false);
  });

  it("image-only jobs keep the fingerprint they had before input kinds existed", () => {
    // computed with the committed pre-0037 job.ts (HEAD 867a0c5) for exactly this identity
    expect(jobFingerprint(identity())).toBe(
      "c29e9b735804dbe48cd8799e5a9b23615536f52ec18b1b0d88ebb83c6c7f44e2",
    );
    // a stored pre-0037 source (no `kind`) reads back as an image
    expect(jobSourceSchema.parse({ ordinal: 0, ...src("a") }).kind).toBe("image");
  });

  it("represents a future video input: its own kind, its own fingerprint, exactly one per job", () => {
    const video = orderedSources([{ ...src("v"), kind: "video", mime: "video/mp4" }]);
    expect(video[0]!.kind).toBe("video");
    expect(validateSources(video)).toEqual({ ok: true });
    expect(inputModeOf(video)).toBe("video");
    const asImage = orderedSources([{ ...src("v"), mime: "video/mp4" }]);
    expect(validateSources(asImage).ok).toBe(false); // a video Asset is never silently treated as an image
    expect(
      validateSources(orderedSources([{ ...src("v"), kind: "video", mime: "video/mp4" }, src("a")])).ok,
    ).toBe(false);
    expect(jobFingerprint(identity({ sources: video }))).not.toBe(
      jobFingerprint(identity({ sources: orderedSources([src("v")]) })),
    );
  });

  it("derives the input mode from the ordered sources", () => {
    expect(inputModeOf(orderedSources([src("a")]))).toBe("single_image");
    expect(inputModeOf(orderedSources([src("a"), src("b")]))).toBe("multi_image");
  });

  it("cost estimates are bounded, validated and honest about unknowns", () => {
    expect(jobCostEstimateSchema.parse(FREE_COST_ESTIMATE("local"))).toMatchObject({
      costClass: "free",
      usd: { min: 0, max: 0 },
    });
    const unknown = {
      costClass: "unknown",
      usd: null,
      providerUnits: null,
      basis: "x",
      pricingSource: null,
      pricingCheckedAt: null,
    };
    expect(jobCostEstimateSchema.parse(unknown).usd).toBeNull();
    expect(() =>
      jobCostEstimateSchema.parse({ ...unknown, costClass: "paid", usd: { min: 2, max: 1 } }),
    ).toThrow();
  });

  it("an estimate is frozen with the request; an actual cost is only what a provider reports", () => {
    const rec = newJobRecord({
      ...identity(),
      id: "j1",
      attempt: 1,
      previousJobId: null,
      status: "queued",
      userId: null,
      now: "t0",
      costEstimate: FREE_COST_ESTIMATE("mock"),
    });
    expect(rec.costEstimate?.costClass).toBe("free");
    expect(rec.actualCost).toBeNull();
    const s = applyJobPatch(rec, { status: "submitting" }, "t1");
    expect(s.costEstimate).toEqual(rec.costEstimate);
    expect(s.actualCost).toBeNull();
    const r = applyJobPatch(
      s,
      {
        status: "running",
        providerOperationId: "op",
        actualCost: { usd: 1.264, providerUnits: { unit: "credits", amount: 1580 }, reportedAt: "t2" },
      },
      "t2",
    );
    expect(r.actualCost?.providerUnits?.amount).toBe(1580);
  });
});
