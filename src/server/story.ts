import "server-only";
import type { MemoryRepository } from "@/data/memory-repository";
import type { MemoryStoryService } from "@/data/story-memory";
import type { StoryProposalRepository } from "@/data/story-repository";
import { persistenceMode } from "@/lib/supabase/config";
import { createStoryRegistry, type StoryRegistry } from "@/story/registry";
import { StoryWorker } from "@/story/worker";
import { requireUser } from "./auth";
import { getPool } from "./db";
import { getRepo } from "./repo";

/**
 * Phase 5B-S1: Story Intelligence for the web. The web lists and prices models and QUEUES proposals; it never calls a
 * provider in Supabase mode (the Story worker does, `npm run worker:story`). Memory/demo mode has no shared database,
 * so — exactly like the generation worker — the same worker loop runs in-process there.
 */
declare global {
  var __prismInlineStoryWorker: { stop: () => void } | undefined;
}

export function getStoryRegistry(): StoryRegistry {
  return createStoryRegistry(process.env);
}

export async function getStoryRepo(
  opts: { startInlineWorker?: boolean } = {},
): Promise<StoryProposalRepository> {
  if (persistenceMode() === "memory") {
    const service = ((await getRepo()) as MemoryRepository).story;
    if (opts.startInlineWorker !== false) ensureInlineStoryWorker(service);
    return service;
  }
  const user = await requireUser();
  const { PostgresStoryData } = await import("@/data/story-postgres");
  const { rlsPreamble } = await import("@/data/postgres-repository");
  return new PostgresStoryData(getPool(), rlsPreamble({ sub: user.id, email: user.email }));
}

function ensureInlineStoryWorker(service: MemoryStoryService) {
  if (globalThis.__prismInlineStoryWorker || process.env.PRISM_STUDIO_INLINE_WORKER === "0") return;
  const worker = new StoryWorker({
    store: service,
    registry: getStoryRegistry(),
    workerId: "inline-story-worker",
  });
  const controller = new AbortController();
  void worker.run(controller.signal, 250);
  globalThis.__prismInlineStoryWorker = { stop: () => controller.abort() };
}

/** Tests / dev: one worker step against the in-memory service. */
export async function tickInlineStoryWorker(): Promise<number> {
  if (persistenceMode() !== "memory") throw new Error("tick is only available in memory mode");
  const service = ((await getRepo()) as MemoryRepository).story;
  return new StoryWorker({
    store: service,
    registry: getStoryRegistry(),
    workerId: "tick-story-worker",
  }).tick(5);
}
