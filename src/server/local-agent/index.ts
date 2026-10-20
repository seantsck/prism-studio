import "server-only";
import type { MemoryRepository } from "@/data/memory-repository";
import { rlsPreamble } from "@/data/postgres-repository";
import { getSiteUrl } from "@/lib/auth/site-url";
import { persistenceMode } from "@/lib/supabase/config";
import { requireUser } from "../auth";
import { getPool } from "../db";
import { getRepo } from "../repo";
import { PostgresAgentAuthStore, PostgresOwnerAgentStore } from "./postgres-store";
import type { AgentServiceDeps } from "./service";
import { MemoryAgentStore, type OwnerAgentStore } from "./store";

/**
 * Server wiring for remote Local Agents (Phase 2F M2D.3C1). SERVER ONLY: this module reaches the guarded database
 * connection and must never enter a client bundle (the `server-only` import makes such an import a build error).
 *
 * Local agents are OFF unless PRISM_LOCAL_AGENTS_ENABLED=1: the agent endpoints answer `not_enabled` and the
 * management page says so.
 */

export const LOCAL_AGENTS_ENABLED_ENV = "PRISM_LOCAL_AGENTS_ENABLED";

export function localAgentsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.PRISM_LOCAL_AGENTS_ENABLED === "1";
}

declare global {
  var __prismAgentStore: MemoryAgentStore | undefined;
}

async function memoryStore(): Promise<MemoryAgentStore> {
  const repo = (await getRepo()) as MemoryRepository;
  globalThis.__prismAgentStore ??= new MemoryAgentStore({
    ownerOf: (id) => repo.projectOwner(id)?.userId ?? null,
    projectTitle: (id) => repo.projectOwner(id)?.title ?? null,
    userId: () => repo.currentUserId(),
  });
  return globalThis.__prismAgentStore;
}

/** The agent-facing service dependencies (no user session: the device signature or pairing secret authenticates). */
export async function agentServiceDeps(): Promise<AgentServiceDeps> {
  const store = persistenceMode() === "memory" ? await memoryStore() : new PostgresAgentAuthStore(getPool());
  return { store, canonicalOrigin: getSiteUrl(), now: Date.now };
}

/** The signed-in project owner's store (RLS-bound in Supabase mode). */
export async function getOwnerAgentStore(): Promise<OwnerAgentStore> {
  if (persistenceMode() === "memory") return memoryStore();
  const user = await requireUser();
  return new PostgresOwnerAgentStore(getPool(), rlsPreamble({ sub: user.id, email: user.email }));
}
