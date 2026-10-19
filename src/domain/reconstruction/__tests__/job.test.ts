import { describe, expect, it } from "vitest";
import {
  applyJobPatch,
  canTransition,
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
    expect(validateSources(orderedSources(Array.from({ length: 9 }, (_, i) => src(`s${i}`)))).ok).toBe(false);
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
