"use server";

import { randomUUID } from "node:crypto";
import { getSiteUrl } from "@/lib/auth/site-url";
import { agentOnline } from "@/lib/local-agent/protocol";
import { UserFacingError } from "./action-result";
import { getOwnerAgentStore, localAgentsEnabled, remoteJobsForOwner } from "./local-agent";
import { failJobsOfAgent } from "./local-agent/jobs/service";
import {
  createPairingOffer,
  OwnerAgentError,
  pairingOfferState,
  renameAgent,
  revokeAgent,
  type PairingState,
} from "./local-agent/service";
import type { DeviceRecord } from "./local-agent/store";
import { requireProjectFresh } from "./repo";

/**
 * The project owner's remote Local Agent management (Phase 2F M2D.3C1). Every action re-reads the project through the
 * signed-in user's RLS-bound repository (so only its owner gets past `requireProjectFresh`), and every store call is
 * itself RLS-bound to that user. The browser receives SAFE views only: never a secret digest, a counter, raw
 * capability JSON or a credential. The plaintext pairing code is returned exactly once, by `createLocalAgentPairing`.
 */

export type AgentActionResult<T> = ({ ok: true } & T) | { ok: false; error: string };

async function guarded<T>(body: () => Promise<AgentActionResult<T>>): Promise<AgentActionResult<T>> {
  try {
    return await body();
  } catch (err) {
    if (err instanceof OwnerAgentError || err instanceof UserFacingError)
      return { ok: false, error: err.message };
    const digest = (err as { digest?: unknown } | null)?.digest;
    if (typeof digest === "string") throw err;
    const ref = randomUUID().slice(0, 8);
    console.error(`[local-agents ${ref}]`, err instanceof Error ? err.name : "unknown error");
    return { ok: false, error: `Something went wrong with local agents (ref ${ref}).` };
  }
}

async function context(slug: string) {
  if (!localAgentsEnabled()) throw new UserFacingError("Local agents are not enabled on this Prism server.");
  const data = await requireProjectFresh(slug);
  return { projectId: data.project.id, store: await getOwnerAgentStore() };
}

export interface AgentToolchainView {
  state: string;
  colmapVersion: string | null;
  colmapProvenance: string;
  brushVersion: string | null;
  vulkanLoader: boolean | null;
  checkedAt: string;
}

export interface AgentDeviceView {
  id: string;
  label: string;
  platform: string;
  arch: string;
  agentVersion: string;
  protocolVersion: number;
  status: "active" | "revoked";
  online: boolean;
  pairedAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  /** sha256 of the public key; the page shows a short form and the full value under Diagnostics */
  fingerprint: string;
  publicKey: string;
  toolchain: AgentToolchainView | null;
}

function view(d: DeviceRecord, nowMs: number): AgentDeviceView {
  const t = d.capabilities?.toolchain;
  return {
    id: d.id,
    label: d.label,
    platform: d.platform,
    arch: d.arch,
    agentVersion: d.agentVersion,
    protocolVersion: d.protocolVersion,
    status: d.status,
    online: agentOnline(d.status, d.lastSeenAt, nowMs),
    pairedAt: d.createdAt,
    lastSeenAt: d.lastSeenAt,
    revokedAt: d.revokedAt,
    fingerprint: d.fingerprint,
    publicKey: d.publicKey,
    toolchain: t
      ? {
          state: t.state,
          colmapVersion: t.colmap.version,
          colmapProvenance: t.colmap.provenance,
          brushVersion: t.brush.version,
          vulkanLoader: t.gpu.vulkanLoader,
          checkedAt: t.checkedAt,
        }
      : null,
  };
}

export interface LocalAgentsState {
  devices: AgentDeviceView[];
  serverTime: string;
}

export async function localAgentsState(slug: string): Promise<AgentActionResult<LocalAgentsState>> {
  return guarded(async () => {
    const { projectId, store } = await context(slug);
    const now = Date.now();
    const devices = (await store.listDevices(projectId)).map((d) => view(d, now));
    return { ok: true, devices, serverTime: new Date(now).toISOString() };
  });
}

export interface PairingOfferView {
  pairingId: string;
  /** shown ONCE; never stored in plaintext and never returned again */
  code: string;
  expiresAt: string;
  serverOrigin: string;
  command: string;
}

export async function createLocalAgentPairing(
  slug: string,
): Promise<AgentActionResult<{ pairing: PairingOfferView }>> {
  return guarded(async () => {
    const { projectId, store } = await context(slug);
    const offer = await createPairingOffer(store, projectId);
    const serverOrigin = getSiteUrl();
    return {
      ok: true,
      pairing: {
        pairingId: offer.pairingId,
        code: offer.code,
        expiresAt: offer.expiresAt,
        serverOrigin,
        command: `npm run local:agent -- pair --server ${serverOrigin} --code ${offer.code}`,
      },
    };
  });
}

export async function localAgentPairingState(
  slug: string,
  pairingId: string,
): Promise<
  AgentActionResult<{ state: PairingState; expiresAt: string; device: { id: string; label: string } | null }>
> {
  return guarded(async () => {
    const { projectId, store } = await context(slug);
    const s = await pairingOfferState(store, projectId, pairingId, Date.now());
    if (!s) throw new UserFacingError("That pairing code is not part of this project.");
    return { ok: true, ...s };
  });
}

export async function cancelLocalAgentPairing(
  slug: string,
  pairingId: string,
): Promise<AgentActionResult<object>> {
  return guarded(async () => {
    const { projectId, store } = await context(slug);
    await store.cancelPairing(projectId, pairingId);
    return { ok: true };
  });
}

export async function renameLocalAgent(
  slug: string,
  deviceId: string,
  label: string,
): Promise<AgentActionResult<{ device: AgentDeviceView }>> {
  return guarded(async () => {
    const { projectId, store } = await context(slug);
    return { ok: true, device: view(await renameAgent(store, projectId, deviceId, label), Date.now()) };
  });
}

export async function revokeLocalAgent(
  slug: string,
  deviceId: string,
): Promise<AgentActionResult<{ device: AgentDeviceView }>> {
  return guarded(async () => {
    const { projectId, store } = await context(slug);
    const device = await revokeAgent(store, projectId, deviceId);
    // a revoked workstation's active remote jobs fail now (never left running, never reassigned)
    const jobs = await remoteJobsForOwner();
    if (jobs) await failJobsOfAgent(jobs, projectId, device.createdBy, device.id);
    return { ok: true, device: view(device, Date.now()) };
  });
}
