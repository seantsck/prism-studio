import "server-only";
import type { MemoryRepository } from "@/data/memory-repository";
import { rlsPreamble } from "@/data/postgres-repository";
import { persistenceMode } from "@/lib/supabase/config";
import { PostgresEpisodeRenderData } from "@/render/postgres";
import type { EpisodeRenderRepository } from "@/render/repository";
import { EpisodeRenderWorker } from "@/render/worker";
import { requireUser } from "./auth";
import { getPool } from "./db";
import { getRepo } from "./repo";
import { getUploadStorage } from "./storage";

declare global {
  var __prismInlineRenderWorker: { kick(): void; idle(): Promise<void> } | undefined;
}

/**
 * Phase 5B-V4 Episode renders for the CURRENT user (owner RLS in Supabase mode). Rendering itself never runs inside a
 * request: in Supabase mode the durable render worker (`npm run worker:render`, its own least-privilege database role)
 * claims queued renders; memory / demo mode has no database to share, so the SAME worker loop runs in-process and is
 * kicked when a render is requested (like the other demo workers).
 */
export async function getEpisodeRenderRepo(): Promise<EpisodeRenderRepository> {
  if (persistenceMode() === "memory") return ((await getRepo()) as MemoryRepository).renders;
  const user = await requireUser();
  return new PostgresEpisodeRenderData(getPool(), rlsPreamble({ sub: user.id, email: user.email }));
}

/** Memory mode only: start (or nudge) the in-process render worker. Never in Supabase mode. */
export async function kickInlineRenderWorker(): Promise<void> {
  if (persistenceMode() !== "memory" || process.env.PRISM_STUDIO_INLINE_WORKER === "0") return;
  if (!globalThis.__prismInlineRenderWorker) {
    const repo = (await getRepo()) as MemoryRepository;
    const storage = await getUploadStorage();
    const worker = new EpisodeRenderWorker({
      store: repo.renders,
      storage,
      storageProvider: "local",
      bucket: null,
      workerId: "inline-demo-render-worker",
      logger: (line) => console.log(`[render] ${line}`),
    });
    let running: Promise<void> | null = null;
    let again = false;
    const loop = async () => {
      do {
        again = false;
        await worker.drain();
      } while (again);
      running = null;
    };
    globalThis.__prismInlineRenderWorker = {
      kick: () => {
        if (running) again = true;
        else running = loop();
      },
      idle: async () => {
        while (running) await running;
      },
    };
  }
  globalThis.__prismInlineRenderWorker.kick();
}
