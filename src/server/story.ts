import "server-only";
import type { MemoryRepository } from "@/data/memory-repository";
import type { MemoryStoryService } from "@/data/story-memory";
import type { StoryProposalRepository } from "@/data/story-repository";
import type { WritingRepository } from "@/data/writing-repository";
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
    const repo = (await getRepo()) as MemoryRepository;
    if (opts.startInlineWorker !== false) ensureInlineStoryWorker(repo.story, repo);
    return repo.story;
  }
  const user = await requireUser();
  const { PostgresStoryData } = await import("@/data/story-postgres");
  const { rlsPreamble } = await import("@/data/postgres-repository");
  return new PostgresStoryData(getPool(), rlsPreamble({ sub: user.id, email: user.email }));
}

/** Phase 5B-S2: writing sessions, revision proposals and script revisions, as the signed-in user. */
export async function getWritingRepo(opts: { startInlineWorker?: boolean } = {}): Promise<WritingRepository> {
  if (persistenceMode() === "memory") {
    const repo = (await getRepo()) as MemoryRepository;
    if (opts.startInlineWorker !== false) ensureInlineStoryWorker(repo.story, repo);
    return repo.writing;
  }
  const user = await requireUser();
  const { PostgresWritingData } = await import("@/data/writing-postgres");
  const { rlsPreamble } = await import("@/data/postgres-repository");
  return new PostgresWritingData(getPool(), rlsPreamble({ sub: user.id, email: user.email }));
}

function ensureInlineStoryWorker(service: MemoryStoryService, repo?: MemoryRepository) {
  if (globalThis.__prismInlineStoryWorker || process.env.PRISM_STUDIO_INLINE_WORKER === "0") return;
  const worker = new StoryWorker({
    store: service,
    ...(repo ? { writing: repo.writing } : {}),
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
  const repo = (await getRepo()) as MemoryRepository;
  return new StoryWorker({
    store: repo.story,
    writing: repo.writing,
    registry: getStoryRegistry(),
    workerId: "tick-story-worker",
  }).tick(5);
}

/**
 * Phase 5B-S2: whether an accepted screenplay change flagged this Scene "Story changed after production breakdown"
 * and nobody has reviewed it yet. A database without migration 0055 reports false (no history to read).
 */
export async function openStoryChangeFor(projectId: string, sceneId: string): Promise<boolean> {
  try {
    const open = await (await getWritingRepo({ startInlineWorker: false })).openSceneChanges(projectId);
    return open.some((c) => c.sceneId === sceneId);
  } catch (err) {
    if ((err as { code?: string }).code === "42P01") return false;
    throw err;
  }
}
