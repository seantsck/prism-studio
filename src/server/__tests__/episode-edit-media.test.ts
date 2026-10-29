import { describe, expect, it, vi } from "vitest";
import { seed } from "@/domain/__tests__/helpers";

vi.mock("server-only", () => ({}));
const getGenerationRepo = vi.fn(async (_opts?: unknown) => ({
  getAttemptView: async () => null,
}));
const getMediaQaRepo = vi.fn(async (_opts?: unknown) => ({
  listProjectDeliveries: async () => [],
  listAttemptDerivations: async () => [],
}));
const getCandidateRepo = vi.fn(async (_opts?: unknown) => ({ listSets: async () => [] }));
vi.mock("../generation", () => ({ getGenerationRepo: (o?: unknown) => getGenerationRepo(o) }));
vi.mock("../media-qa", () => ({ getMediaQaRepo: (o?: unknown) => getMediaQaRepo(o) }));
vi.mock("../candidates", () => ({ getCandidateRepo: (o?: unknown) => getCandidateRepo(o) }));

const { loadEditMediaFacts } = await import("../episode-edit-media");

/**
 * Phase 3A.4B review: `loadEditMediaFacts` (the Episode Edit and Continuity Supervisor read) obtains every repository
 * read-only, so reading it never starts a memory-mode inline worker.
 */
describe("loadEditMediaFacts", () => {
  it("requests generation, media-QA and candidate access without starting an inline worker", async () => {
    const data = seed();
    await loadEditMediaFacts(data, data.episodes[0].id);
    const readOnly = { startInlineWorker: false };
    expect(getGenerationRepo).toHaveBeenCalledWith(readOnly);
    expect(getMediaQaRepo).toHaveBeenCalledWith(readOnly);
    expect(getCandidateRepo).toHaveBeenCalledWith(readOnly);
    for (const fn of [getGenerationRepo, getMediaQaRepo, getCandidateRepo])
      for (const call of fn.mock.calls) expect(call[0]).toEqual(readOnly);
  });
});
