import "server-only";
import { randomUUID } from "node:crypto";
import type { MemoryRepository } from "@/data/memory-repository";
import { rlsPreamble } from "@/data/postgres-repository";
import { getSiteUrl } from "@/lib/auth/site-url";
import { readReconstructionConfig } from "@/lib/reconstruction/registry";
import { remoteAgentView, type RemoteAgentView } from "@/lib/reconstruction/remote-agent-capture";
import { persistenceMode } from "@/lib/supabase/config";
import { requireUser } from "../auth";
import { getPool } from "../db";
import { getRepo } from "../repo";
import type { RemoteJobDeps } from "./jobs/service";
import { memoryRemoteJobStore, postgresRemoteJobStore, type RemoteJobStore } from "./jobs/store";
import { PostgresAgentAuthStore, PostgresOwnerAgentStore } from "./postgres-store";
import { agentRelaySink } from "./relay-storage";
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
  return {
    store,
    canonicalOrigin: getSiteUrl(),
    now: Date.now,
    remoteJobs: (await remoteJobStore()) !== null,
  };
}

/**
 * The remote-job persistence of THIS server, or null when it cannot serve remote jobs: reconstruction jobs are off,
 * or (Supabase mode) the dedicated agent-relay Storage key is absent. Fail closed: nothing else is tried.
 */
async function remoteJobStore(): Promise<RemoteJobStore | null> {
  if (!readReconstructionConfig().jobsEnabled) return null;
  const mode = persistenceMode();
  const sink = agentRelaySink(process.env, mode);
  if (!sink) return null;
  if (mode === "memory") return memoryRemoteJobStore((await getRepo()) as MemoryRepository, sink);
  return postgresRemoteJobStore(getPool(), sink);
}

/** Dependencies of the signed remote-job routes (lease, sources, progress, fail, result). */
export async function remoteJobDeps(): Promise<RemoteJobDeps> {
  const agent = await agentServiceDeps();
  const jobs = await remoteJobStore();
  const unavailable: RemoteJobStore = {
    persistence: persistenceMode(),
    listQueued: async () => [],
    listInFlight: async () => [],
    peek: async () => null,
    scope: async () => {
      throw new Error("remote jobs are not available on this server");
    },
  };
  return { agent, jobs: jobs ?? unavailable, available: jobs !== null, newId: () => randomUUID() };
}

/**
 * The signed-in owner's view of THIS project's paired workstations for the Remote Local Agent provider (counts only).
 * Computed per request from the owner's own devices (RLS-bound), never cached across projects.
 */
export async function remoteAgentAvailability(projectId: string): Promise<RemoteAgentView> {
  const enabled = localAgentsEnabled();
  const configured = enabled && (await remoteJobStore()) !== null;
  const devices = enabled && configured ? await (await getOwnerAgentStore()).listDevices(projectId) : [];
  return remoteAgentView(devices, Date.now(), { enabled, configured });
}

/** The server's remote-job store for owner-side cleanup (revocation), or null when remote jobs are unavailable. */
export async function remoteJobsForOwner(): Promise<RemoteJobStore | null> {
  return remoteJobStore();
}

/** The signed-in project owner's store (RLS-bound in Supabase mode). */
export async function getOwnerAgentStore(): Promise<OwnerAgentStore> {
  if (persistenceMode() === "memory") return memoryStore();
  const user = await requireUser();
  return new PostgresOwnerAgentStore(getPool(), rlsPreamble({ sub: user.id, email: user.email }));
}
