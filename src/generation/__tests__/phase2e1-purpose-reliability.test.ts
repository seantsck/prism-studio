import { describe, expect, it } from "vitest";
import { projectSchema } from "@/domain/schemas";
import { catalogModel, estimateCredits } from "@/domain/generation/models/catalog";
import { aggregateByModel, providerReliability, type OutcomeRecord } from "@/domain/generation/performance";

const rec = (over: Partial<OutcomeRecord>): OutcomeRecord => ({
  attemptId: "a",
  projectId: "p",
  provider: "runway",
  model: "gen4_turbo",
  decision: "unreviewed",
  negativeTags: [],
  positiveTags: [],
  preferred: false,
  inCandidateSet: true,
  actualCostUsd: null,
  estimatedCostUsd: null,
  generationMs: null,
  totalMs: null,
  profile: null,
  benchmark: false,
  status: "succeeded",
  createdAt: "2026-10-14T00:00:00.000Z",
  ...over,
});

describe("project purpose (explicit enum, never inferred)", () => {
  it("accepts production, benchmark and test, defaults to production, refuses anything else", () => {
    const shape = projectSchema.shape.purpose;
    expect(shape.parse(undefined)).toBe("production");
    for (const v of ["production", "benchmark", "test"]) expect(shape.parse(v)).toBe(v);
    expect(() => shape.parse("staging")).toThrow();
  });
});

describe("provider reliability is operational and separate from creative quality", () => {
  const rows = [
    rec({ attemptId: "1", model: "gen4_turbo", status: "failed", errorCategory: "provider_unavailable" }),
    rec({ attemptId: "2", model: "hailuo3", status: "failed", errorCategory: "invalid_request" }),
    rec({ attemptId: "3", model: "gen4.5", status: "succeeded", decision: "reject", negativeTags: [] }),
    rec({
      attemptId: "4",
      model: "gen4.5",
      status: "failed",
      errorCategory: "permanent",
      errorCode: "submission_outcome_unknown",
    }),
    rec({ attemptId: "5", model: "gen4.5", status: "queued" }),
    rec({
      attemptId: "6",
      model: "gen4.5",
      status: "failed",
      errorCategory: "provider_unavailable",
      benchmark: true,
    }),
  ];

  it("classifies provider failure, invalid request and ambiguous submission separately", () => {
    const m = Object.fromEntries(providerReliability(rows).map((r) => [r.model, r]));
    expect(m["gen4_turbo"]).toMatchObject({
      terminal: 1,
      providerFailed: 1,
      invalidRequest: 0,
      succeeded: 0,
    });
    expect(m["hailuo3"]).toMatchObject({ terminal: 1, invalidRequest: 1, providerFailed: 0 });
    expect(m["gen4.5"]).toMatchObject({ terminal: 2, succeeded: 1, ambiguousSubmission: 1 });
  });

  it("is scoped: benchmark records stay out of production reliability and vice versa", () => {
    expect(providerReliability(rows, "benchmark").map((r) => r.model)).toEqual(["gen4.5"]);
    expect(providerReliability(rows, "benchmark")[0]).toMatchObject({ providerFailed: 1 });
  });

  it("a provider failure or invalid request never counts as a creative rejection", () => {
    const perf = Object.fromEntries(aggregateByModel(rows).map((p) => [p.model, p]));
    expect(perf["gen4_turbo"]).toMatchObject({ failed: 1, rejected: 0, reviewed: 0 });
    expect(perf["hailuo3"]).toMatchObject({ failed: 1, rejected: 0, reviewed: 0 });
    // the human reject stays a creative reject, and is not an operational failure
    expect(perf["gen4.5"]!.rejected).toBe(1);
  });
});

describe("Seedance 2.5 honours its 80-credit minimum charge", () => {
  it("a 2 s / 480p generation would bill the minimum, a 5 s one the per-second price", () => {
    const m = catalogModel("runway", "seedance2_5")!;
    const price = (seconds: number, tierId: string) =>
      estimateCredits(m, {
        seconds,
        tierId,
        nativeAudio: false,
        referenceImages: 0,
        referenceVideoSeconds: 0,
        startFrame: false,
        endFrame: false,
      }).credits;
    expect(price(2, "480p")).toBe(80);
    expect(price(5, "480p")).toBe(100);
    expect(price(5, "720p")).toBe(150);
  });
});
