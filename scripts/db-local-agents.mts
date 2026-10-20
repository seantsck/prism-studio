// Supabase E2E for Phase 2F M2D.3C1: REMOTE LOCAL AGENT IDENTITY against the REAL dedicated Prism Studio database
// (project lyqdxiyjperhniwhzsvg only).
//   npm run db:local-agents
//
// The agent is the REAL CLI (`scripts/local-agent.mts`) running as a SEPARATE PROCESS with a MINIMAL environment:
// no SUPABASE_DB_URL, no Supabase key, no worker/Storage secret, no provider key (it would not get them on a user's
// workstation). It talks to the production protocol handlers over real HTTP (an in-process server on 127.0.0.1 wired to
// the Postgres stores, as the Next.js routes are). Only the external tools are fake (M2D.3A fake COLMAP/Brush, version
// probe only). No reconstruction, no Asset bytes, no Storage, no provider call of any kind.
//
// Checks: 0038 grants/RLS (anon none, owner columns only, secret digest unreadable, workers none), owner pairing via
// RLS, stranger refused, real CLI pair → heartbeat → status, plaintext never stored, expired / consumed / wrong-owner
// / cancelled codes, CONCURRENT redemption (exactly one), CONCURRENT same counter (exactly one), replay, clock skew,
// revocation (terminal, history kept, CLI stops), cross-project isolation, key reuse, cleanup.
// Fictional data in temporary projects of the dev owner, removed afterwards.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { rlsPreamble } from "../src/data/postgres-repository";
import {
  generatePairingSecret,
  pairingSecretHash,
  canonicalPairingSecret,
} from "../src/lib/local-agent/crypto";
import { fakeMachine, machineEnv } from "../src/lib/reconstruction/local/__tests__/fake-machine";
import { handleHeartbeat, handlePair, handleStatus } from "../src/server/local-agent/http";
import { PostgresAgentAuthStore, PostgresOwnerAgentStore } from "../src/server/local-agent/postgres-store";
import {
  AgentProtocolError,
  createPairingOffer,
  heartbeat,
  redeemPairing,
  type AgentServiceDeps,
} from "../src/server/local-agent/service";
import { TestAgent } from "../src/server/local-agent/__tests__/helpers";
import { assertDevUserExists, readDevUserEnv } from "./lib/dev-user.mjs";
import { startScript } from "./lib/safety.mjs";

const dev = readDevUserEnv();
startScript({
  mode: "local agent identity E2E (fictional projects, pairings and devices created, then removed)",
  devOwner: dev.id,
});
const pool = new pg.Pool({ connectionString: dev.url, ssl: { rejectUnauthorized: false }, max: 12 });
await assertDevUserExists(pool, dev);

const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = "") => results.push([name, ok, detail]);

const projectA = randomUUID();
const projectB = randomUUID();
const stranger = randomUUID();
const owner = new PostgresOwnerAgentStore(pool, rlsPreamble({ sub: dev.id }));
const strangerStore = new PostgresOwnerAgentStore(pool, rlsPreamble({ sub: stranger }));
const auth = new PostgresAgentAuthStore(pool);
const tmp = await mkdtemp(path.join(os.tmpdir(), "prism-db-local-agents-"));
const home = path.join(tmp, "agent-home");
let server: Server | null = null;
let origin = "";
let deps: AgentServiceDeps;

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    if (e instanceof AgentProtocolError) return e.code;
    return `error:${e instanceof Error ? e.message.slice(0, 120) : "?"}`;
  }
}

/** Runs a statement as `role` with optional claims; returns "ok" or the Postgres error code/message. */
async function as(role: "anon" | "authenticated", sub: string | null, sql: string, params: unknown[] = []) {
  const c = await pool.connect();
  try {
    await c.query(rlsPreamble(sub ? { sub } : null, role));
    const r = await c.query(sql, params);
    await c.query("rollback");
    return { ok: true as const, rows: r.rows, rowCount: r.rowCount ?? 0 };
  } catch (e) {
    await c.query("rollback").catch(() => undefined);
    return { ok: false as const, error: (e as { code?: string }).code ?? "error" };
  } finally {
    c.release();
  }
}

/** The real agent CLI as a separate process with a MINIMAL environment (no server credential of any kind). */
function cli(args: string[], extraEnv: Record<string, string> = {}) {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    SystemRoot: process.env.SystemRoot ?? "",
    TEMP: process.env.TEMP ?? os.tmpdir(),
    TMP: process.env.TMP ?? os.tmpdir(),
    NODE_ENV: "test",
    PRISM_LOCAL_AGENT_HOME: home,
    ...extraEnv,
  };
  return new Promise<{ code: number | null; out: string; env: Record<string, string> }>((resolve) => {
    const child = spawn(
      process.execPath,
      [path.resolve("node_modules/tsx/dist/cli.mjs"), "scripts/local-agent.mts", ...args],
      {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env,
      },
    );
    let out = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (out += String(d)));
    child.on("exit", (code) => resolve({ code, out, env }));
  });
}

async function startServer() {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const request = new Request(`${origin}${req.url}`, {
      method: req.method,
      headers,
      body: chunks.length ? Buffer.concat(chunks) : undefined,
    });
    const h = req.url!.startsWith("/api/local-agent/v1/pair")
      ? handlePair
      : req.url!.startsWith("/api/local-agent/v1/heartbeat")
        ? handleHeartbeat
        : handleStatus;
    const r = await h(request, deps);
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
  deps = { store: auth, canonicalOrigin: origin, now: Date.now };
}

const deviceRow = async (id: string) =>
  (await pool.query("select * from local_agents where id = $1", [id])).rows[0] as
    Record<string, unknown> | undefined;

try {
  for (const [id, slug] of [
    [projectA, `agents-a-${projectA.slice(0, 8)}`],
    [projectB, `agents-b-${projectB.slice(0, 8)}`],
  ])
    await pool.query("insert into projects (id, user_id, slug, title, purpose) values ($1,$2,$3,$4,'test')", [
      id,
      dev.id,
      slug,
      `Fictional agent project ${slug}`,
    ]);
  await startServer();

  // ── 0038 authority: grants and RLS ──
  const rls = await pool.query(
    "select relname, relrowsecurity from pg_class where relname in ('local_agents','local_agent_pairings') order by relname",
  );
  check(
    "RLS enabled on both tables",
    rls.rows.length === 2 && rls.rows.every((r) => r.relrowsecurity === true),
  );
  const priv = async (role: string, table: string, p: string) =>
    (await pool.query("select has_table_privilege($1, $2, $3) as ok", [role, table, p])).rows[0]
      .ok as boolean;
  const colPriv = async (role: string, table: string, col: string, p: string) =>
    (await pool.query("select has_column_privilege($1, $2, $3, $4) as ok", [role, table, col, p])).rows[0]
      .ok as boolean;
  let anonAny = false;
  let workerAny = false;
  for (const t of ["local_agents", "local_agent_pairings"])
    for (const p of ["select", "insert", "update", "delete"]) {
      anonAny ||= await priv("anon", t, p);
      anonAny ||= await priv("service_role", t, p);
      for (const w of ["prism_generation_worker", "prism_continuity_worker"]) {
        const exists = (await pool.query("select 1 from pg_roles where rolname = $1", [w])).rowCount;
        if (exists) workerAny ||= await priv(w, t, p);
      }
    }
  check("anon and service_role have NO privilege on agent tables", !anonAny);
  check("generation/continuity workers have NO privilege on agent tables", !workerAny);
  check(
    "owner session cannot read the pairing secret digest",
    !(await colPriv("authenticated", "local_agent_pairings", "secret_hash", "select")),
  );
  check(
    "owner session cannot insert or delete devices, nor write key/counter/capabilities",
    !(await priv("authenticated", "local_agents", "insert")) &&
      !(await priv("authenticated", "local_agents", "delete")) &&
      !(await colPriv("authenticated", "local_agents", "last_counter", "update")) &&
      !(await colPriv("authenticated", "local_agents", "public_key", "update")) &&
      !(await colPriv("authenticated", "local_agents", "capabilities_json", "update")) &&
      (await colPriv("authenticated", "local_agents", "label", "update")),
  );
  check(
    "anonymous cannot read agent tables",
    !(await as("anon", null, "select 1 from local_agents")).ok &&
      !(await as("anon", null, "select 1 from local_agent_pairings")).ok,
  );

  // ── owner pairing via RLS; stranger refused ──
  const offer = await createPairingOffer(owner, projectA);
  const ttl = Date.parse(offer.expiresAt) - Date.parse(offer.createdAt);
  check("owner creates a one-time pairing code (10 min)", ttl === 600_000, `${ttl} ms`);
  check(
    "a stranger cannot create a pairing code for the project",
    (await codeOf(createPairingOffer(strangerStore, projectA))).startsWith("error:"),
  );
  check(
    "a stranger cannot see the project's pairing",
    (await strangerStore.getPairing(projectA, offer.pairingId)) === null,
  );
  const snap = JSON.stringify(
    (
      await pool.query("select row_to_json(p) j from local_agent_pairings p where project_id = $1", [
        projectA,
      ])
    ).rows,
  );
  const canonical = canonicalPairingSecret(offer.code)!;
  check(
    "the database holds only the digest, never the code",
    !snap.includes(offer.code) && !snap.includes(canonical) && snap.includes(pairingSecretHash(canonical)),
  );

  // ── the REAL agent CLI pairs, heartbeats and reads status, with NO server credential in its environment ──
  const machine = await fakeMachine(path.join(tmp, "machine"));
  const toolEnv = {
    ...machineEnv(machine),
    SystemRoot: process.env.SystemRoot ?? "",
    PRISM_LOCAL_TEST_SYSTEM_ROOT: machine.sysRoot,
  };
  const paired = await cli(["pair", "--server", origin, "--code", offer.code, "--label", "Fictional rig"]);
  const envNames = Object.keys(paired.env).join(",");
  check(
    "the agent process had no Supabase/DB/worker/provider credential in its environment",
    !/SUPABASE|DB_URL|SECRET|SERVICE|WLT|OPENAI|GEMINI|RUNWAY|FAL|MESHY/i.test(envNames),
    envNames,
  );
  check("real CLI: pair succeeds", paired.code === 0, paired.out.slice(-300));
  check(
    "real CLI: never prints the pairing code",
    !paired.out.includes(offer.code) && !paired.out.includes(canonical),
  );
  const devices = await owner.listDevices(projectA);
  const device = devices[0];
  check(
    "one device bound to project A",
    devices.length === 1 && device?.projectId === projectA && device.createdBy === dev.id,
  );
  const profile = path.join(home, "profiles", "default");
  const files = (await readdir(profile)).sort();
  const configText = await readFile(path.join(profile, "agent.json"), "utf8");
  check(
    "workstation holds only agent.json + its private key; no code, no credential",
    files.join(",") === "agent.json,device-key.pem" &&
      !configText.includes(canonical) &&
      !/supabase|postgres|secret|service_role/i.test(configText),
    files.join(","),
  );
  const rowJson = JSON.stringify(await deviceRow(device.id));
  const keyPem = await readFile(path.join(profile, "device-key.pem"), "utf8");
  check(
    "the server stores the PUBLIC key only (private key never left the workstation)",
    !rowJson.includes("PRIVATE") && !rowJson.includes(keyPem.split("\n")[1]),
  );
  check(
    "pairing consumed (single use)",
    (
      await pool.query("select consumed_at is not null c from local_agent_pairings where id = $1", [
        offer.pairingId,
      ])
    ).rows[0].c === true,
  );

  const run1 = await cli(["run", "--once", "--fake-tools"], toolEnv);
  check("real CLI: signed heartbeat accepted", run1.code === 0, run1.out.slice(-300));
  const r1 = await deviceRow(device.id);
  const caps = r1?.capabilities_json as { toolchain?: { state?: string } } | undefined;
  check(
    "heartbeat stored: counter 1, last seen, toolchain capabilities (fake tools: ready)",
    Number(r1?.last_counter) === 1 && r1?.last_seen_at != null && caps?.toolchain?.state === "ready",
    `${r1?.last_counter} ${caps?.toolchain?.state}`,
  );
  check(
    "capabilities carry no path, hostname or user name",
    !/[A-Za-z]:\\|\/Users\/|\/home\//.test(JSON.stringify(caps)) &&
      !JSON.stringify(caps).includes(os.hostname()) &&
      !JSON.stringify(caps).includes(os.userInfo().username),
  );
  const st = await cli(["status"]);
  check(
    "real CLI: signed status names its own project",
    st.code === 0 && st.out.includes(projectA) && Number((await deviceRow(device.id))?.last_counter) === 2,
    st.out.slice(-200),
  );

  // ── pairing refusals ──
  check(
    "a consumed code is refused",
    (await codeOf(redeemPairing(deps, new TestAgent(Date.now, origin).pairBody(offer.code)))) ===
      "pairing_consumed",
  );
  const expiredCode = generatePairingSecret();
  await pool.query(
    `insert into local_agent_pairings (project_id, created_by, secret_hash, created_at, expires_at)
     values ($1, $2, $3, now() - interval '20 minutes', now() - interval '10 minutes')`,
    [projectA, dev.id, pairingSecretHash(canonicalPairingSecret(expiredCode)!)],
  );
  check(
    "an expired code is refused",
    (await codeOf(redeemPairing(deps, new TestAgent(Date.now, origin).pairBody(expiredCode)))) ===
      "pairing_expired",
  );
  check(
    "an unknown code is refused generically",
    (await codeOf(redeemPairing(deps, new TestAgent(Date.now, origin).pairBody(generatePairingSecret())))) ===
      "invalid_pairing",
  );
  const foreignCode = generatePairingSecret();
  await pool.query(
    `insert into local_agent_pairings (project_id, created_by, secret_hash, expires_at)
     values ($1, $2, $3, now() + interval '10 minutes')`,
    [projectA, stranger, pairingSecretHash(canonicalPairingSecret(foreignCode)!)],
  );
  check(
    "a code whose creator does not own the project is refused (ownership re-checked at redemption)",
    (await codeOf(redeemPairing(deps, new TestAgent(Date.now, origin).pairBody(foreignCode)))) ===
      "project_forbidden",
  );
  const older = await createPairingOffer(owner, projectA);
  await createPairingOffer(owner, projectA);
  check(
    "a newer code cancels the older unused one",
    (await codeOf(redeemPairing(deps, new TestAgent(Date.now, origin).pairBody(older.code)))) ===
      "invalid_pairing",
  );

  // ── concurrency on Postgres row locks ──
  const race = await createPairingOffer(owner, projectB);
  const raced = await Promise.all(
    Array.from({ length: 8 }, () =>
      codeOf(redeemPairing(deps, new TestAgent(Date.now, origin).pairBody(race.code))),
    ),
  );
  const bDevices = await owner.listDevices(projectB);
  check(
    "concurrent redemption of one code: exactly one device",
    raced.filter((r) => r === "ok").length === 1 &&
      raced.filter((r) => r === "pairing_consumed").length === 7 &&
      bDevices.length === 1,
    raced.join(","),
  );
  const ccOffer = await createPairingOffer(owner, projectB);
  const ccAgent = new TestAgent(Date.now, origin);
  ccAgent.deviceId = (await redeemPairing(deps, ccAgent.pairBody(ccOffer.code))).device.id;
  const sameCounter = await Promise.all(
    Array.from({ length: 8 }, () => codeOf(heartbeat(deps, ccAgent.heartbeat({ counter: 1 })))),
  );
  check(
    "concurrent requests with one counter: exactly one accepted",
    sameCounter.filter((r) => r === "ok").length === 1 &&
      sameCounter.filter((r) => r === "counter_replayed").length === 7,
    sameCounter.join(","),
  );
  const replay = ccAgent.heartbeat({ counter: 2 });
  await heartbeat(deps, replay);
  check("a replayed request is refused", (await codeOf(heartbeat(deps, replay))) === "counter_replayed");
  check(
    "a skewed clock is refused without consuming the counter",
    (await codeOf(
      heartbeat(deps, ccAgent.heartbeat({ counter: 3, timestamp: Date.now() - 10 * 60_000 })),
    )) === "clock_skew" && (await codeOf(heartbeat(deps, ccAgent.heartbeat({ counter: 3 })))) === "ok",
  );
  check(
    "device B's key cannot act as device A (cross-project)",
    (await codeOf(heartbeat(deps, ccAgent.heartbeat({ counter: 50, agentId: device.id })))) ===
      "invalid_signature",
  );
  const reuse = await createPairingOffer(owner, projectA);
  check(
    "a registered key cannot pair again (and the code survives)",
    (await codeOf(redeemPairing(deps, ccAgent.pairBody(reuse.code)))) === "malformed_request" &&
      (await owner.getPairing(projectA, reuse.pairingId))?.consumedAt === null,
  );

  // ── owner-session tampering is refused by grants/RLS/triggers ──
  const tamper = await Promise.all([
    as("authenticated", dev.id, "update local_agents set last_counter = 0 where id = $1", [device.id]),
    as("authenticated", dev.id, "update local_agents set public_key = public_key where id = $1", [device.id]),
    as("authenticated", dev.id, "delete from local_agents where id = $1", [device.id]),
    as("authenticated", dev.id, "select secret_hash from local_agent_pairings where project_id = $1", [
      projectA,
    ]),
    as(
      "authenticated",
      dev.id,
      "insert into local_agent_pairings (project_id, created_by, secret_hash) values ($1, $2, $3)",
      [projectA, stranger, "a".repeat(64)],
    ),
  ]);
  check(
    "owner session cannot rewrite counters/keys, delete history, read digests or forge a creator",
    tamper.every((t) => !t.ok),
    tamper.map((t) => (t.ok ? "ok" : t.error)).join(","),
  );
  const strangerView = await as(
    "authenticated",
    stranger,
    "select id from local_agents where project_id = $1",
    [projectA],
  );
  check("a stranger sees no devices of the project", strangerView.ok && strangerView.rowCount === 0);
  check(
    "a stranger cannot revoke",
    (await strangerStore.revokeDevice(projectA, device.id)) === null &&
      (await deviceRow(device.id))?.status === "active",
  );
  check(
    "project B's context cannot revoke project A's device",
    (await owner.revokeDevice(projectB, device.id)) === null,
  );

  // ── revocation ──
  const revoked = await owner.revokeDevice(projectA, device.id);
  check("owner revokes", revoked?.status === "revoked" && revoked.revokedAt !== null);
  const afterRevoke = await cli(["run", "--once", "--fake-tools"], toolEnv);
  check(
    "real CLI: a revoked agent is refused and stops",
    afterRevoke.code === 3 && afterRevoke.out.includes("revoked"),
    afterRevoke.out.slice(-200),
  );
  const reactivate = await as(
    "authenticated",
    dev.id,
    "update local_agents set status = 'active' where id = $1",
    [device.id],
  );
  let privReactivate = "ok";
  try {
    await pool.query("update local_agents set status = 'active' where id = $1", [device.id]);
  } catch {
    privReactivate = "refused";
  }
  const hist = await deviceRow(device.id);
  check(
    "a revoked device is never reactivated (owner or server) and its history row remains",
    !reactivate.ok &&
      privReactivate === "refused" &&
      hist?.status === "revoked" &&
      Number(hist?.last_counter) === 2,
  );
  const rePair = await createPairingOffer(owner, projectA);
  const second = await cli(["pair", "--server", origin, "--code", rePair.code, "--profile", "second"]);
  const all = await owner.listDevices(projectA);
  check(
    "re-pairing creates a NEW device identity",
    second.code === 0 && all.length === 2 && all.some((d) => d.id !== device.id && d.status === "active"),
  );
} catch (e) {
  check("unexpected error", false, e instanceof Error ? e.message.slice(0, 300) : String(e));
} finally {
  if (server) await new Promise((r) => server!.close(r));
  await pool
    .query("delete from projects where id = any($1::uuid[])", [[projectA, projectB]])
    .catch(() => undefined);
  const left = await pool.query(
    `select (select count(*) from local_agents where project_id = any($1::uuid[]))::int
          + (select count(*) from local_agent_pairings where project_id = any($1::uuid[]))::int as n`,
    [[projectA, projectB]],
  );
  check("cleanup: no fictional pairing or device remains", left.rows[0].n === 0);
  await rm(tmp, { recursive: true, force: true });
  await pool.end();
}

let failed = 0;
for (const [name, ok, detail] of results) {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  (${detail})` : ""}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
