import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_CORRECTIONS,
  DEFAULT_MAX_TRANSPORT_CALLS,
  MAX_RETRY_AFTER_MS,
  OVERLOAD_BACKOFF_SECONDS,
  overloadBackoffMs,
} from "../retry";

describe("durable overload backoff", () => {
  it("is exponential: 15 s, 45 s, 120 s, 300 s, 600 s (±10 % deterministic jitter)", () => {
    OVERLOAD_BACKOFF_SECONDS.forEach((s, i) => {
      const ms = overloadBackoffMs(i + 1, "job-a");
      expect(ms).toBeGreaterThanOrEqual(s * 1000 * 0.9);
      expect(ms).toBeLessThanOrEqual(s * 1000 * 1.1);
    });
  });

  it("is deterministic per job and ordinal, and differs between jobs (no lock-step retries)", () => {
    expect(overloadBackoffMs(1, "job-a")).toBe(overloadBackoffMs(1, "job-a"));
    const spread = new Set(["a", "b", "c", "d", "e", "f"].map((j) => overloadBackoffMs(2, j)));
    expect(spread.size).toBeGreaterThan(1);
  });

  it("plateaus at the last step and never exceeds the cap", () => {
    expect(overloadBackoffMs(99, "x")).toBeLessThanOrEqual(660_000);
    expect(overloadBackoffMs(1, "x", 10 * 3600_000)).toBe(MAX_RETRY_AFTER_MS);
  });

  it("honours a provider Retry-After only when it is longer than the schedule", () => {
    expect(overloadBackoffMs(1, "x", 1_000)).toBeGreaterThanOrEqual(13_500);
    expect(overloadBackoffMs(1, "x", 90_000)).toBe(90_000);
  });

  it("defaults: six transport calls and one schema correction per run", () => {
    expect(DEFAULT_MAX_TRANSPORT_CALLS).toBe(6);
    expect(DEFAULT_MAX_CORRECTIONS).toBe(1);
  });
});
