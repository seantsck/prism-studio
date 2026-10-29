import "server-only";
import type { GenerationRepository } from "@/data/generation-repository";
import { MemoryGenerationService } from "@/data/generation-memory";
import { PostgresGenerationData } from "@/data/generation-postgres";
import { MemoryRepository } from "@/data/memory-repository";
import { rlsPreamble } from "@/data/postgres-repository";
import { readGenerationConfig, type GenerationConfig } from "@/generation/config";
import { consoleLogger } from "@/generation/log";
import { createRegistry, type ModelRegistry } from "@/generation/registry";
import { LocalDiskSink } from "@/generation/sink";
import { GenerationWorker } from "@/generation/worker";
import { persistenceMode } from "@/lib/supabase/config";
import { requireUser } from "./auth";
import { getPool } from "./db";
import { getRepo } from "./repo";

declare global {
  var __prismRegistry: ModelRegistry | undefined;
  var __prismInlineWorker: { stop(): void } | undefined;
}

export function getGenerationConfig(): GenerationConfig {
  return readGenerationConfig(process.env);
}

/** Server-side model registry (credentials stay in the environment; the UI only sees availability). */
export function getRegistry(): ModelRegistry {
  globalThis.__prismRegistry ??= createRegistry(process.env, getGenerationConfig());
  return globalThis.__prismRegistry;
}

/**
 * Generation persistence for the CURRENT user. Memory mode: the in-process service. Supabase mode: the same
 * SQL the worker uses, but inside an RLS transaction for the verified session, so Postgres enforces ownership.
 * In memory mode the default also starts the demo's in-process generation worker; a pure READ passes
 * `{ startInlineWorker: false }` so visiting a page never begins queued generation work.
 */
export async function getGenerationRepo(
  opts: { startInlineWorker?: boolean } = {},
): Promise<GenerationRepository> {
  if (persistenceMode() === "memory") {
    const repo = (await getRepo()) as MemoryRepository;
    if (opts.startInlineWorker !== false) ensureInlineWorker(repo.generation);
    return repo.generation;
  }
  const user = await requireUser();
  return new PostgresGenerationData(getPool(), rlsPreamble({ sub: user.id, email: user.email }));
}

/**
 * Memory/demo mode has no database to share with a separate worker process, so the demo server runs the very
 * same worker loop in-process. Supabase mode never does this: use `npm run worker:generation`.
 */
function ensureInlineWorker(service: MemoryGenerationService) {
  if (globalThis.__prismInlineWorker || process.env.PRISM_STUDIO_INLINE_WORKER === "0") return;
  const config = getGenerationConfig();
  const worker = new GenerationWorker({
    store: service,
    registry: getRegistry(),
    sink: new LocalDiskSink(),
    config,
    logger: consoleLogger,
    workerId: "inline-demo-worker",
  });
  const controller = new AbortController();
  void worker.run(controller.signal);
  globalThis.__prismInlineWorker = { stop: () => controller.abort() };
}

/** For the dev tick route and tests: run one worker step against the in-memory service. */
export async function tickInlineWorker(limit = 5): Promise<number> {
  if (persistenceMode() !== "memory") throw new Error("tick is only available in memory mode");
  const repo = (await getRepo()) as MemoryRepository;
  const worker = new GenerationWorker({
    store: repo.generation,
    registry: getRegistry(),
    sink: new LocalDiskSink(),
    config: getGenerationConfig(),
    logger: consoleLogger,
    workerId: "tick-worker",
    heartbeatMs: 0,
  });
  return worker.tick(limit);
}
