import type { Pool, PoolClient } from "pg";
import { capabilitiesSchema } from "@/lib/local-agent/protocol";
import type {
  AgentAuthStore,
  Decision,
  DeviceRecord,
  DeviceUpdate,
  LockedDevice,
  LockedPairing,
  NewDevice,
  OwnerAgentStore,
  PairingRecord,
} from "./store";

/**
 * Postgres persistence for remote Local Agents (0038).
 *
 * PostgresAgentAuthStore runs on the Prism server's own guarded connection, because the agent path has no user
 * session (the pairing secret or the device signature is the credential). It is deliberately tiny: four fixed,
 * parameterised statements per operation, touching only local_agent_pairings, local_agents and projects
 * (ownership re-check, project title), each operation in ONE transaction with the decisive row locked
 * (`for update`). It never reads or writes any other table, and it is never given SQL from a request.
 *
 * PostgresOwnerAgentStore is the owner's browser path: every statement runs as role `authenticated` with the
 * signed-in user's claims (rlsPreamble), so RLS and the 0038 column grants decide what the owner may see and change.
 */

type Row = Record<string, unknown>;
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const isoOrNull = (v: unknown): string | null => (v == null ? null : iso(v));

const DEVICE_COLUMNS = `d.id, d.project_id, d.created_by, d.pairing_id, d.schema_version, d.protocol_version, d.label,
  d.platform, d.arch, d.agent_version, d.public_key, d.public_key_fingerprint, d.status, d.revoked_at, d.last_counter,
  d.last_seen_at, d.capabilities_json, d.created_at, d.updated_at`;

export function mapDevice(r: Row): DeviceRecord {
  const caps = r.capabilities_json == null ? null : capabilitiesSchema.safeParse(r.capabilities_json);
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    createdBy: String(r.created_by),
    pairingId: String(r.pairing_id),
    schemaVersion: "prism.local-agent.v1",
    protocolVersion: Number(r.protocol_version),
    label: String(r.label),
    platform: r.platform as DeviceRecord["platform"],
    arch: String(r.arch),
    agentVersion: String(r.agent_version),
    publicKey: String(r.public_key),
    fingerprint: String(r.public_key_fingerprint),
    status: r.status === "revoked" ? "revoked" : "active",
    revokedAt: isoOrNull(r.revoked_at),
    lastCounter: Number(r.last_counter),
    lastSeenAt: isoOrNull(r.last_seen_at),
    capabilities: caps?.success ? caps.data : null,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

const mapPairing = (r: Row): PairingRecord => ({
  id: String(r.id),
  projectId: String(r.project_id),
  createdBy: String(r.created_by),
  createdAt: iso(r.created_at),
  expiresAt: iso(r.expires_at),
  consumedAt: isoOrNull(r.consumed_at),
  cancelledAt: isoOrNull(r.cancelled_at),
});

async function inTx<T>(pool: Pool, preamble: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query(preamble);
    const r = await fn(c);
    await c.query("commit");
    return r;
  } catch (err) {
    await c.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

/** Raised inside a transaction to roll it back and report a refusal (nothing is written). */
class Refusal<E> {
  constructor(readonly result: E) {}
}

export class PostgresAgentAuthStore implements AgentAuthStore {
  constructor(private readonly pool: Pool) {}

  private async refusable<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    try {
      return await inTx(this.pool, "begin", fn);
    } catch (e) {
      if (e instanceof Refusal) return e.result as T;
      throw e;
    }
  }

  async redeemPairing<E>(
    secretHash: string,
    decide: (p: LockedPairing, nowMs: number) => Decision<E>,
    device: NewDevice,
  ) {
    type R =
      | { kind: "none" }
      | { kind: "refused"; error: E }
      | { kind: "key_in_use" }
      | { kind: "paired"; device: DeviceRecord };
    return this.refusable<R>(async (c) => {
      const found = await c.query(
        `select p.id, p.project_id, p.created_by, p.created_at, p.expires_at, p.consumed_at, p.cancelled_at,
                coalesce(pr.user_id = p.created_by, false) as owner_ok, now() as db_now
           from local_agent_pairings p left join projects pr on pr.id = p.project_id
          where p.secret_hash = $1
          for update of p`,
        [secretHash],
      );
      const row = found.rows[0];
      if (!row) throw new Refusal<R>({ kind: "none" });
      const d = decide(
        { ...mapPairing(row), ownerOk: row.owner_ok === true },
        new Date(row.db_now).getTime(),
      );
      if (!d.ok) throw new Refusal<R>({ kind: "refused", error: d.error });
      const taken = await c.query("select 1 from local_agents where public_key_fingerprint = $1", [
        device.fingerprint,
      ]);
      if (taken.rowCount) throw new Refusal<R>({ kind: "key_in_use" });
      await c.query("update local_agent_pairings set consumed_at = now() where id = $1", [row.id]);
      const ins = await c.query(
        `insert into local_agents as d (project_id, created_by, pairing_id, schema_version, protocol_version, label,
                                        platform, arch, agent_version, public_key, public_key_fingerprint)
         values ($1, $2, $3, 'prism.local-agent.v1', $4, $5, $6, $7, $8, $9, $10)
         returning ${DEVICE_COLUMNS}`,
        [
          row.project_id,
          row.created_by,
          row.id,
          device.protocolVersion,
          device.label,
          device.platform,
          device.arch,
          device.agentVersion,
          device.publicKey,
          device.fingerprint,
        ],
      );
      return { kind: "paired", device: mapDevice(ins.rows[0]) };
    });
  }

  async authenticate<E>(
    deviceId: string,
    decide: (d: LockedDevice, nowMs: number) => Decision<E> & { update?: DeviceUpdate },
  ) {
    type R =
      | { kind: "none" }
      | { kind: "refused"; error: E }
      | { kind: "accepted"; device: DeviceRecord; projectTitle: string | null };
    return this.refusable<R>(async (c) => {
      const found = await c.query(
        `select ${DEVICE_COLUMNS}, coalesce(pr.user_id = d.created_by, false) as owner_ok, pr.title as project_title,
                now() as db_now
           from local_agents d left join projects pr on pr.id = d.project_id
          where d.id = $1
          for update of d`,
        [deviceId],
      );
      const row = found.rows[0];
      if (!row) throw new Refusal<R>({ kind: "none" });
      const projectTitle = row.project_title == null ? null : String(row.project_title);
      const r = decide(
        { ...mapDevice(row), ownerOk: row.owner_ok === true, projectTitle },
        new Date(row.db_now).getTime(),
      );
      if (!r.ok) throw new Refusal<R>({ kind: "refused", error: r.error });
      if (!r.update) return { kind: "accepted", device: mapDevice(row), projectTitle };
      const u = r.update;
      const upd = await c.query(
        `update local_agents as d
            set last_counter = $2, last_seen_at = now(),
                capabilities_json = coalesce($3::jsonb, capabilities_json),
                agent_version = coalesce($4, agent_version),
                protocol_version = coalesce($5, protocol_version)
          where d.id = $1 and d.status = 'active' and d.last_counter < $2
          returning ${DEVICE_COLUMNS}`,
        [
          deviceId,
          u.lastCounter,
          u.capabilities ? JSON.stringify(u.capabilities) : null,
          u.agentVersion ?? null,
          u.protocolVersion ?? null,
        ],
      );
      // the row is locked, so this cannot happen; refuse rather than accept if it ever did
      if (!upd.rows[0]) throw new Error("local agent counter advance lost its row lock");
      return { kind: "accepted", device: mapDevice(upd.rows[0]), projectTitle };
    });
  }
}

export class PostgresOwnerAgentStore implements OwnerAgentStore {
  constructor(
    private readonly pool: Pool,
    private readonly preamble: string,
  ) {}

  private tx<T>(fn: (c: PoolClient) => Promise<T>) {
    return inTx(this.pool, this.preamble, fn);
  }

  async createPairing(projectId: string, secretHash: string) {
    return this.tx(async (c) => {
      await c.query(
        `update local_agent_pairings set cancelled_at = now()
          where project_id = $1 and consumed_at is null and cancelled_at is null`,
        [projectId],
      );
      const r = await c.query(
        `insert into local_agent_pairings (project_id, created_by, secret_hash)
         values ($1, auth.uid(), $2)
         returning id, project_id, created_by, created_at, expires_at, consumed_at, cancelled_at`,
        [projectId, secretHash],
      );
      return mapPairing(r.rows[0]);
    });
  }

  async getPairing(projectId: string, pairingId: string) {
    return this.tx(async (c) => {
      const r = await c.query(
        `select id, project_id, created_by, created_at, expires_at, consumed_at, cancelled_at
           from local_agent_pairings where id = $1 and project_id = $2`,
        [pairingId, projectId],
      );
      if (!r.rows[0]) return null;
      const d = await c.query(
        "select id, label from local_agents where pairing_id = $1 and project_id = $2",
        [pairingId, projectId],
      );
      const dev = d.rows[0] ? { id: String(d.rows[0].id), label: String(d.rows[0].label) } : null;
      return { ...mapPairing(r.rows[0]), device: dev };
    });
  }

  async cancelPairing(projectId: string, pairingId: string) {
    return this.tx(async (c) => {
      const r = await c.query(
        `update local_agent_pairings set cancelled_at = now()
          where id = $1 and project_id = $2 and consumed_at is null and cancelled_at is null`,
        [pairingId, projectId],
      );
      return (r.rowCount ?? 0) > 0;
    });
  }

  async listDevices(projectId: string) {
    return this.tx(async (c) => {
      const r = await c.query(
        `select ${DEVICE_COLUMNS} from local_agents d where d.project_id = $1 order by d.created_at desc, d.id`,
        [projectId],
      );
      return r.rows.map(mapDevice);
    });
  }

  async renameDevice(projectId: string, deviceId: string, label: string) {
    return this.tx(async (c) => {
      const r = await c.query(
        `update local_agents as d set label = $3
          where d.id = $1 and d.project_id = $2 and d.status = 'active'
          returning ${DEVICE_COLUMNS}`,
        [deviceId, projectId, label],
      );
      return r.rows[0] ? mapDevice(r.rows[0]) : null;
    });
  }

  async revokeDevice(projectId: string, deviceId: string) {
    return this.tx(async (c) => {
      const r = await c.query(
        `update local_agents as d set status = 'revoked'
          where d.id = $1 and d.project_id = $2 and d.status = 'active'
          returning ${DEVICE_COLUMNS}`,
        [deviceId, projectId],
      );
      if (r.rows[0]) return mapDevice(r.rows[0]);
      const existing = await c.query(
        `select ${DEVICE_COLUMNS} from local_agents d where d.id = $1 and d.project_id = $2`,
        [deviceId, projectId],
      );
      return existing.rows[0] ? mapDevice(existing.rows[0]) : null;
    });
  }
}
