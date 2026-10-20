import { randomUUID } from "node:crypto";
import { DEVICE_SCHEMA, PAIRING_TTL_MS, type AgentCapabilities } from "@/lib/local-agent/protocol";

/**
 * Persistence for remote Local Agents (Phase 2F M2D.3C1), split by AUTHORITY:
 *
 *   AgentAuthStore   the agent-facing server path (pairing redemption, signed-request authentication). Fixed
 *                    statements on the Prism server's own connection; the workstation never touches the database.
 *                    Every decision runs inside ONE transaction with the row locked, so a pairing is consumed at
 *                    most once and a request counter is accepted at most once.
 *   OwnerAgentStore  the project owner's browser path, bound to the signed-in user (RLS in Supabase mode).
 *
 * The memory implementation (demo mode and tests) keeps the same contract: every decision is synchronous between
 * reading and writing, so concurrent callers in one process are serialised exactly like the row lock does.
 */

export interface PairingRecord {
  id: string;
  projectId: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
  cancelledAt: string | null;
}

export interface DeviceRecord {
  id: string;
  projectId: string;
  createdBy: string;
  pairingId: string;
  schemaVersion: typeof DEVICE_SCHEMA;
  protocolVersion: number;
  label: string;
  platform: "win32" | "linux" | "darwin";
  arch: string;
  agentVersion: string;
  /** Ed25519 SPKI DER, base64 (public; shown only under diagnostics) */
  publicKey: string;
  fingerprint: string;
  status: "active" | "revoked";
  revokedAt: string | null;
  lastCounter: number;
  lastSeenAt: string | null;
  capabilities: AgentCapabilities | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewDevice {
  label: string;
  platform: DeviceRecord["platform"];
  arch: string;
  agentVersion: string;
  protocolVersion: number;
  publicKey: string;
  fingerprint: string;
}

/** A pairing offer as seen by redemption, with the ownership re-check done in the same transaction. */
export interface LockedPairing extends PairingRecord {
  /** the offer's creator still owns its project (false when the project changed hands or is gone) */
  ownerOk: boolean;
}

/** A device as seen by request authentication, locked for the rest of the transaction. */
export interface LockedDevice extends DeviceRecord {
  ownerOk: boolean;
  projectTitle: string | null;
}

export type Decision<E> = { ok: true } | { ok: false; error: E };

export interface DeviceUpdate {
  lastCounter: number;
  capabilities?: AgentCapabilities;
  agentVersion?: string;
  protocolVersion?: number;
}

export interface AgentAuthStore {
  /**
   * Atomically: find the offer by secret digest (locked), let `decide` accept or refuse it (with the store's clock),
   * and on acceptance consume it and create the device bound to its project. `null` when no offer has that digest.
   * `key_in_use` when the public key is already registered to a device (nothing is consumed).
   */
  redeemPairing<E>(
    secretHash: string,
    decide: (p: LockedPairing, nowMs: number) => Decision<E>,
    device: NewDevice,
  ): Promise<
    | { kind: "none" }
    | { kind: "refused"; error: E }
    | { kind: "key_in_use" }
    | { kind: "paired"; device: DeviceRecord }
  >;
  /**
   * Atomically: lock the device, let `decide` authenticate the request (with the store's clock), and on acceptance
   * apply its update (counter advance, last seen, capabilities). `null` when there is no such device.
   */
  authenticate<E>(
    deviceId: string,
    decide: (d: LockedDevice, nowMs: number) => Decision<E> & { update?: DeviceUpdate },
  ): Promise<
    | { kind: "none" }
    | { kind: "refused"; error: E }
    | { kind: "accepted"; device: DeviceRecord; projectTitle: string | null }
  >;
}

export interface OwnerAgentStore {
  /** Creates a pairing offer (cancelling the project's earlier unused ones: one live code per project). */
  createPairing(projectId: string, secretHash: string): Promise<PairingRecord>;
  getPairing(
    projectId: string,
    pairingId: string,
  ): Promise<(PairingRecord & { device: { id: string; label: string } | null }) | null>;
  cancelPairing(projectId: string, pairingId: string): Promise<boolean>;
  listDevices(projectId: string): Promise<DeviceRecord[]>;
  /** null when the device is not this project's or is revoked (revoked history never changes) */
  renameDevice(projectId: string, deviceId: string, label: string): Promise<DeviceRecord | null>;
  /** null when the device is not this project's; an already revoked device is returned unchanged */
  revokeDevice(projectId: string, deviceId: string): Promise<DeviceRecord | null>;
}

// ───────────────────────── memory (demo mode, tests) ─────────────────────────

interface MemoryPairing extends PairingRecord {
  secretHash: string;
}

export interface MemoryAgentStoreOptions {
  /** the owner of a project, or null when it does not exist */
  ownerOf: (projectId: string) => string | null;
  projectTitle?: (projectId: string) => string | null;
  /** the user acting through the owner store (memory mode: the single local user) */
  userId: () => string;
  now?: () => number;
}

const clone = <T>(v: T): T => structuredClone(v);

export class MemoryAgentStore implements AgentAuthStore, OwnerAgentStore {
  readonly pairings = new Map<string, MemoryPairing>();
  readonly devices = new Map<string, DeviceRecord>();

  constructor(private readonly o: MemoryAgentStoreOptions) {}

  private nowMs() {
    return (this.o.now ?? Date.now)();
  }
  private iso() {
    return new Date(this.nowMs()).toISOString();
  }
  private owns(projectId: string) {
    return this.o.ownerOf(projectId) === this.o.userId();
  }

  // ── agent path ──

  async redeemPairing<E>(
    secretHash: string,
    decide: (p: LockedPairing, nowMs: number) => Decision<E>,
    device: NewDevice,
  ) {
    const p = [...this.pairings.values()].find((x) => x.secretHash === secretHash);
    if (!p) return { kind: "none" as const };
    const { secretHash: _omit, ...pub } = p;
    void _omit;
    const d = decide({ ...pub, ownerOk: this.o.ownerOf(p.projectId) === p.createdBy }, this.nowMs());
    if (!d.ok) return { kind: "refused" as const, error: d.error };
    if ([...this.devices.values()].some((x) => x.fingerprint === device.fingerprint))
      return { kind: "key_in_use" as const };
    const at = this.iso();
    p.consumedAt = at;
    const rec: DeviceRecord = {
      id: randomUUID(),
      projectId: p.projectId,
      createdBy: p.createdBy,
      pairingId: p.id,
      schemaVersion: DEVICE_SCHEMA,
      protocolVersion: device.protocolVersion,
      label: device.label,
      platform: device.platform,
      arch: device.arch,
      agentVersion: device.agentVersion,
      publicKey: device.publicKey,
      fingerprint: device.fingerprint,
      status: "active",
      revokedAt: null,
      lastCounter: 0,
      lastSeenAt: null,
      capabilities: null,
      createdAt: at,
      updatedAt: at,
    };
    this.devices.set(rec.id, rec);
    return { kind: "paired" as const, device: clone(rec) };
  }

  async authenticate<E>(
    deviceId: string,
    decide: (d: LockedDevice, nowMs: number) => Decision<E> & { update?: DeviceUpdate },
  ) {
    const d = this.devices.get(deviceId);
    if (!d) return { kind: "none" as const };
    const projectTitle = this.o.projectTitle?.(d.projectId) ?? null;
    const r = decide(
      { ...clone(d), ownerOk: this.o.ownerOf(d.projectId) === d.createdBy, projectTitle },
      this.nowMs(),
    );
    if (!r.ok) return { kind: "refused" as const, error: r.error };
    if (r.update) {
      if (r.update.lastCounter < d.lastCounter) throw new Error("counter never moves backwards");
      d.lastCounter = r.update.lastCounter;
      d.lastSeenAt = this.iso();
      d.updatedAt = d.lastSeenAt;
      if (r.update.capabilities) d.capabilities = clone(r.update.capabilities);
      if (r.update.agentVersion) d.agentVersion = r.update.agentVersion;
      if (r.update.protocolVersion) d.protocolVersion = r.update.protocolVersion;
    }
    return { kind: "accepted" as const, device: clone(d), projectTitle };
  }

  // ── owner path ──

  async createPairing(projectId: string, secretHash: string): Promise<PairingRecord> {
    if (!this.owns(projectId)) throw new Error("not the project owner");
    const now = this.nowMs();
    for (const p of this.pairings.values())
      if (p.projectId === projectId && !p.consumedAt && !p.cancelledAt) p.cancelledAt = this.iso();
    const rec: MemoryPairing = {
      id: randomUUID(),
      projectId,
      createdBy: this.o.userId(),
      secretHash,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + PAIRING_TTL_MS).toISOString(),
      consumedAt: null,
      cancelledAt: null,
    };
    this.pairings.set(rec.id, rec);
    const { secretHash: _omit, ...pub } = rec;
    void _omit;
    return pub;
  }

  async getPairing(projectId: string, pairingId: string) {
    const p = this.pairings.get(pairingId);
    if (!p || p.projectId !== projectId || !this.owns(projectId)) return null;
    const { secretHash: _omit, ...pub } = p;
    void _omit;
    const dev = [...this.devices.values()].find((d) => d.pairingId === p.id);
    return { ...pub, device: dev ? { id: dev.id, label: dev.label } : null };
  }

  async cancelPairing(projectId: string, pairingId: string) {
    const p = this.pairings.get(pairingId);
    if (!p || p.projectId !== projectId || !this.owns(projectId) || p.consumedAt || p.cancelledAt)
      return false;
    p.cancelledAt = this.iso();
    return true;
  }

  async listDevices(projectId: string) {
    if (!this.owns(projectId)) return [];
    return [...this.devices.values()]
      .filter((d) => d.projectId === projectId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map(clone);
  }

  async renameDevice(projectId: string, deviceId: string, label: string) {
    const d = this.devices.get(deviceId);
    if (!d || d.projectId !== projectId || !this.owns(projectId) || d.status === "revoked") return null;
    d.label = label;
    d.updatedAt = this.iso();
    return clone(d);
  }

  async revokeDevice(projectId: string, deviceId: string) {
    const d = this.devices.get(deviceId);
    if (!d || d.projectId !== projectId || !this.owns(projectId)) return null;
    if (d.status === "active") {
      d.status = "revoked";
      d.revokedAt = this.iso();
      d.updatedAt = d.revokedAt;
    }
    return clone(d);
  }
}
