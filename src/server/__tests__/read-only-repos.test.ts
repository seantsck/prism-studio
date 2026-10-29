import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryRepository } from "@/data/memory-repository";

vi.mock("server-only", () => ({}));

/**
 * Phase 3A.4B review: a pure READ never starts a memory-mode inline worker. The worker is what claims queued jobs, so a
 * read that does not start it cannot begin queued work; a path that submits work still starts it (the default).
 * Memory persistence only; no provider, network or paid call (no job is ever queued here, the workers only poll).
 */

process.env.PRISM_STUDIO_PERSISTENCE = "memory";
delete process.env.PRISM_STUDIO_INLINE_WORKER;
process.env.PRISM_STUDIO_WORKER_IDLE_POLL_MS = "20";

const { getMediaQaRepo } = await import("../media-qa");
const { getGenerationRepo } = await import("../generation");
const { getCandidateRepo } = await import("../candidates");
const { getRepo } = await import("../repo");

const memory = async () => (await getRepo()) as MemoryRepository;
const settle = () => new Promise((r) => setTimeout(r, 120));

afterEach(() => {
  globalThis.__prismInlineAnalysisWorker?.stop();
  globalThis.__prismInlineAnalysisWorker = undefined;
  globalThis.__prismInlineWorker?.stop();
  globalThis.__prismInlineWorker = undefined;
  vi.restoreAllMocks();
});

describe("media-QA repository: read-only access never starts the continuity analysis worker", () => {
  it("read-only: the same memory store, no worker, nothing claims a job", async () => {
    const service = (await memory()).mediaQa;
    const claim = vi.spyOn(service, "claim");
    expect(await getMediaQaRepo({ startInlineWorker: false })).toBe(service);
    await settle();
    expect(globalThis.__prismInlineAnalysisWorker).toBeUndefined();
    expect(claim).not.toHaveBeenCalled();
  });

  it("the default (every action / job path) still starts it, and it polls for queued jobs", async () => {
    const service = (await memory()).mediaQa;
    const claim = vi.spyOn(service, "claim");
    expect(await getMediaQaRepo()).toBe(service);
    expect(globalThis.__prismInlineAnalysisWorker).toBeDefined();
    await vi.waitFor(() => expect(claim).toHaveBeenCalled(), { timeout: 3000 });
  });
});

describe("generation / candidate repositories: read-only access never starts the generation worker", () => {
  it("read-only: no worker, nothing claims a generation job", async () => {
    const service = (await memory()).generation;
    const claim = vi.spyOn(service, "claim");
    expect(await getGenerationRepo({ startInlineWorker: false })).toBe(service);
    await getCandidateRepo({ startInlineWorker: false });
    await settle();
    expect(globalThis.__prismInlineWorker).toBeUndefined();
    expect(claim).not.toHaveBeenCalled();
  });

  it("the default still starts it", async () => {
    const service = (await memory()).generation;
    const claim = vi.spyOn(service, "claim");
    await getCandidateRepo();
    expect(globalThis.__prismInlineWorker).toBeDefined();
    await vi.waitFor(() => expect(claim).toHaveBeenCalled(), { timeout: 3000 });
  });
});
