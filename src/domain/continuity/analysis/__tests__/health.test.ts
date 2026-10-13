import { describe, expect, it } from "vitest";
import { providerHealth, type HealthJob } from "../health";

const job = (over: Partial<HealthJob>): HealthJob => ({
  analyzer: "gemini",
  status: "failed",
  lastErrorCategory: "overloaded",
  finishedAt: "2026-10-13T10:00:00Z",
  ...over,
});

describe("provider health (informational, never routes)", () => {
  it("disabled / not configured come from configuration", () => {
    expect(providerHealth({ providerId: "openai", configState: "disabled", jobs: [] }).state).toBe(
      "disabled",
    );
    expect(providerHealth({ providerId: "openai", configState: "missing_credential", jobs: [] }).state).toBe(
      "not_configured",
    );
    expect(providerHealth({ providerId: "openai", configState: "unsupported_model", jobs: [] }).note).toMatch(
      /unsupported/,
    );
  });

  it("configured with no history is 'configured' (availability unknown)", () => {
    expect(providerHealth({ providerId: "openai", configState: "configured", jobs: [] })).toMatchObject({
      state: "configured",
      failures: 0,
    });
  });

  it("repeated overload failures are visible: recent_provider_failure with the count", () => {
    const h = providerHealth({
      providerId: "gemini",
      configState: "configured",
      jobs: [
        job({ finishedAt: "2026-10-13T10:00:00Z" }),
        job({ finishedAt: "2026-10-13T11:00:00Z", lastErrorCategory: "provider_overloaded_retry_exhausted" }),
      ],
    });
    expect(h.state).toBe("recent_provider_failure");
    expect(h.failures).toBe(2);
    expect(h.note).toMatch(/recent failure/);
    expect(h.lastFailureCategory).toBe("provider_overloaded_retry_exhausted");
  });

  it("a later success becomes 'available' but earlier failures are still counted (history never disappears)", () => {
    const h = providerHealth({
      providerId: "gemini",
      configState: "configured",
      jobs: [
        job({}),
        job({ status: "succeeded", lastErrorCategory: null, finishedAt: "2026-10-13T12:00:00Z" }),
      ],
    });
    expect(h.state).toBe("available");
    expect(h.failures).toBe(1);
    expect(h.note).toMatch(/earlier failure/);
  });

  it("only the provider's own jobs count; policy/input failures do not make a provider look unhealthy", () => {
    const h = providerHealth({
      providerId: "openai",
      configState: "configured",
      jobs: [job({ analyzer: "gemini" }), job({ analyzer: "openai", lastErrorCategory: "budget" })],
    });
    expect(h.state).toBe("configured");
    expect(h.failures).toBe(0);
  });

  it("active jobs are ignored", () => {
    expect(
      providerHealth({
        providerId: "gemini",
        configState: "configured",
        jobs: [job({ status: "queued", finishedAt: null })],
      }).state,
    ).toBe("configured");
  });
});
