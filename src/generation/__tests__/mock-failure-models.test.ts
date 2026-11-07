import { describe, expect, it } from "vitest";
import { MOCK_FAILURE_SIMULATION_MODELS, MockProvider } from "../providers/mock";
import { createRegistry } from "../registry";

/** Phase 5A.2: engineering failure-simulation fixtures are never offered in customer-facing environments. */
describe("5A.2 mock failure-simulation models", () => {
  const ids = (env: Record<string, string | undefined>) =>
    createRegistry({
      PRISM_STUDIO_ENABLE_MOCK_PROVIDER: "1",
      PRISM_STUDIO_GENERATION_PROVIDERS: "mock",
      ...env,
    })
      .models()
      .map((m) => m.modelId);

  it("development, staging and tests keep them (existing e2e and worker tests rely on them)", () => {
    for (const env of [{}, { NEXT_PUBLIC_PRISM_STUDIO_ENVIRONMENT: "staging" }])
      for (const id of MOCK_FAILURE_SIMULATION_MODELS) expect(ids(env), id).toContain(id);
  });

  it("production and rehearsal neither list them nor accept them by id", async () => {
    for (const environment of ["production", "rehearsal"]) {
      const listed = ids({ NEXT_PUBLIC_PRISM_STUDIO_ENVIRONMENT: environment });
      for (const id of MOCK_FAILURE_SIMULATION_MODELS)
        expect(listed, `${environment} ${id}`).not.toContain(id);
      expect(listed, "ordinary mock models stay").toContain("mock-video-1");
    }
    const p = new MockProvider({ failureSimulations: false });
    await expect(
      p.submit({ modelId: "mock-video-flaky" } as never, {} as never, {} as never),
    ).rejects.toThrow(/Unknown mock model/);
  });
});
