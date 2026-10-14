import { describe, expect, it } from "vitest";
import { currentFailedAnalysis, latestAnalysisJob } from "../latest";

const job = (id: string, status: string, createdAt: string) => ({ id, status, createdAt });

describe("current analysis status banner", () => {
  const gemini = ["1", "2", "3", "4"].map((n, i) => job(`g${n}`, "failed", `2026-10-13T1${i}:00:00.000Z`));

  it("a newer success supersedes older failures (the Run 5 regression)", () => {
    const jobs = [job("o5", "succeeded", "2026-10-13T22:09:21.000Z"), ...gemini.slice().reverse()];
    expect(latestAnalysisJob(jobs)?.id).toBe("o5");
    expect(currentFailedAnalysis(jobs)).toBeNull();
  });

  it("is independent of input order", () => {
    const jobs = [...gemini, job("o5", "succeeded", "2026-10-13T22:09:21.000Z")];
    expect(currentFailedAnalysis(jobs)).toBeNull();
  });

  it("shows the failure when the latest job is the failed one", () => {
    const jobs = [gemini[3]!, gemini[2]!, job("ok", "succeeded", "2026-10-13T05:00:00.000Z")];
    expect(currentFailedAnalysis(jobs)?.id).toBe("g4");
  });

  it("a newer active, queued or cancelled job hides an older failure", () => {
    for (const status of ["queued", "processing", "claimed", "cancelled", "cancel_requested"])
      expect(currentFailedAnalysis([...gemini, job("n", status, "2026-10-14T00:00:00.000Z")])).toBeNull();
  });

  it("no jobs, no banner", () => {
    expect(currentFailedAnalysis([])).toBeNull();
    expect(latestAnalysisJob([])).toBeNull();
  });

  it("history is not mutated or filtered by the selection", () => {
    const jobs = [...gemini, job("o5", "succeeded", "2026-10-13T22:09:21.000Z")];
    const copy = JSON.stringify(jobs);
    currentFailedAnalysis(jobs);
    expect(JSON.stringify(jobs)).toBe(copy);
    expect(jobs).toHaveLength(5);
  });
});
