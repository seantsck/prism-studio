import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { generatePairingSecret } from "@/lib/local-agent/crypto";
import { BODY_LIMITS, PAIRING_TTL_MS, PROTOCOL } from "@/lib/local-agent/protocol";
import { handleHeartbeat, handlePair, handleStatus } from "../http";
import {
  AgentProtocolError,
  createPairingOffer,
  heartbeat,
  pairingOfferState,
  redeemPairing,
  renameAgent,
  revokeAgent,
  status,
  type AgentServiceDeps,
} from "../service";
import { MemoryAgentStore } from "../store";
import { capabilities, ORIGIN, TestAgent } from "./helpers";

const OWNER = randomUUID();
const STRANGER = randomUUID();
const PROJECT_A = randomUUID();
const PROJECT_B = randomUUID();

let clock: number;
let owners: Map<string, string>;
let actingUser: string;
let store: MemoryAgentStore;
let deps: AgentServiceDeps;
const now = () => clock;

beforeEach(() => {
  clock = Date.parse("2026-10-20T12:00:00.000Z");
  owners = new Map([
    [PROJECT_A, OWNER],
    [PROJECT_B, OWNER],
  ]);
  actingUser = OWNER;
  store = new MemoryAgentStore({
    ownerOf: (id) => owners.get(id) ?? null,
    projectTitle: (id) => (id === PROJECT_A ? "Project A" : "Project B"),
    userId: () => actingUser,
    now,
  });
  deps = { store, canonicalOrigin: ORIGIN, now };
});

async function code(error: Promise<unknown>): Promise<string> {
  try {
    await error;
    return "no error";
  } catch (e) {
    if (e instanceof AgentProtocolError) return e.code;
    throw e;
  }
}

async function paired(project = PROJECT_A): Promise<TestAgent> {
  const offer = await createPairingOffer(store, project);
  const agent = new TestAgent(now);
  const r = await redeemPairing(deps, agent.pairBody(offer.code));
  agent.deviceId = r.device.id;
  return agent;
}

// ───────────────────────── pairing ─────────────────────────

describe("pairing", () => {
  it("a valid code creates ONE device bound to the project and returns no credential", async () => {
    const offer = await createPairingOffer(store, PROJECT_A);
    expect(offer.code).toMatch(/^([0-9A-Z]{4}-){6}[0-9A-Z]{4}$/);
    expect(Date.parse(offer.expiresAt) - Date.parse(offer.createdAt)).toBe(PAIRING_TTL_MS);
    const agent = new TestAgent(now);
    const r = await redeemPairing(deps, agent.pairBody(offer.code));
    expect(r).toMatchObject({
      ok: true,
      protocol: PROTOCOL,
      serverOrigin: ORIGIN,
      device: { projectId: PROJECT_A },
    });
    expect(Object.keys(r).sort()).toEqual(
      ["device", "heartbeatIntervalMs", "ok", "protocol", "serverOrigin", "serverTime"].sort(),
    );
    const [d] = await store.listDevices(PROJECT_A);
    expect(d).toMatchObject({
      id: r.device.id,
      projectId: PROJECT_A,
      createdBy: OWNER,
      pairingId: offer.pairingId,
      publicKey: agent.publicKey,
      fingerprint: agent.fingerprint,
      status: "active",
      lastCounter: 0,
    });
    expect(await store.listDevices(PROJECT_B)).toEqual([]);
    expect(await pairingOfferState(store, PROJECT_A, offer.pairingId, clock)).toMatchObject({
      state: "paired",
      device: { id: r.device.id },
    });
  });

  it("the plaintext pairing code is never stored", async () => {
    const offer = await createPairingOffer(store, PROJECT_A);
    const raw = offer.code.replace(/-/g, "");
    const snapshot = JSON.stringify([...store.pairings.values(), ...store.devices.values()]);
    expect(snapshot).not.toContain(offer.code);
    expect(snapshot).not.toContain(raw);
    await redeemPairing(deps, new TestAgent(now).pairBody(offer.code));
    const after = JSON.stringify([...store.pairings.values(), ...store.devices.values()]);
    expect(after).not.toContain(raw);
  });

  it("single use: a consumed code is refused, even for another key", async () => {
    const offer = await createPairingOffer(store, PROJECT_A);
    await redeemPairing(deps, new TestAgent(now).pairBody(offer.code));
    expect(await code(redeemPairing(deps, new TestAgent(now).pairBody(offer.code)))).toBe("pairing_consumed");
    expect(await store.listDevices(PROJECT_A)).toHaveLength(1);
  });

  it("an expired code is refused", async () => {
    const offer = await createPairingOffer(store, PROJECT_A);
    clock += PAIRING_TTL_MS;
    expect(await code(redeemPairing(deps, new TestAgent(now).pairBody(offer.code)))).toBe("pairing_expired");
    expect(await pairingOfferState(store, PROJECT_A, offer.pairingId, clock)).toMatchObject({
      state: "expired",
    });
  });

  it("an unknown or malformed code gets the same generic answer", async () => {
    await createPairingOffer(store, PROJECT_A);
    expect(await code(redeemPairing(deps, new TestAgent(now).pairBody(generatePairingSecret())))).toBe(
      "invalid_pairing",
    );
    expect(await code(redeemPairing(deps, new TestAgent(now).pairBody("123456")))).toBe("invalid_pairing");
  });

  it("a newer code cancels the project's earlier unused code", async () => {
    const first = await createPairingOffer(store, PROJECT_A);
    await createPairingOffer(store, PROJECT_A);
    expect(await code(redeemPairing(deps, new TestAgent(now).pairBody(first.code)))).toBe("invalid_pairing");
    expect(await pairingOfferState(store, PROJECT_A, first.pairingId, clock)).toMatchObject({
      state: "cancelled",
    });
  });

  it("a newer code never revokes paired devices nor rewrites consumed offers; other projects' codes survive", async () => {
    const used1 = await createPairingOffer(store, PROJECT_A);
    const a1 = new TestAgent(now);
    a1.deviceId = (await redeemPairing(deps, a1.pairBody(used1.code))).device.id;
    const used2 = await createPairingOffer(store, PROJECT_A);
    const a2 = new TestAgent(now);
    a2.deviceId = (await redeemPairing(deps, a2.pairBody(used2.code))).device.id;
    const otherProject = await createPairingOffer(store, PROJECT_B);
    const pending = await createPairingOffer(store, PROJECT_A);
    await createPairingOffer(store, PROJECT_A);
    // consumed history stays "paired" (never re-labelled cancelled), the unused one is cancelled
    for (const used of [used1, used2])
      expect(await pairingOfferState(store, PROJECT_A, used.pairingId, clock)).toMatchObject({
        state: "paired",
      });
    expect(await pairingOfferState(store, PROJECT_A, pending.pairingId, clock)).toMatchObject({
      state: "cancelled",
    });
    expect(await pairingOfferState(store, PROJECT_B, otherProject.pairingId, clock)).toMatchObject({
      state: "pending",
    });
    // both devices stay active and keep authenticating
    expect((await store.listDevices(PROJECT_A)).map((d) => d.status)).toEqual(["active", "active"]);
    expect((await heartbeat(deps, a1.heartbeat())).acceptedCounter).toBe(1);
    expect((await heartbeat(deps, a2.heartbeat())).acceptedCounter).toBe(1);
  });

  it("a valid proof cannot be replayed into another pairing (it is bound to the offer's secret digest)", async () => {
    const first = await createPairingOffer(store, PROJECT_A);
    const second = await createPairingOffer(store, PROJECT_B);
    const a = new TestAgent(now);
    // a proof made for the first offer, presented with the second offer's code
    const replayed = { ...a.pairBody(first.code), pairingCode: second.code };
    expect(await code(redeemPairing(deps, replayed))).toBe("invalid_signature");
    // ...or with another public key substituted (the proof binds the key's fingerprint)
    const b = new TestAgent(now);
    expect(await code(redeemPairing(deps, { ...a.pairBody(second.code), publicKey: b.publicKey }))).toBe(
      "invalid_signature",
    );
    expect(await pairingOfferState(store, PROJECT_B, second.pairingId, clock)).toMatchObject({
      state: "pending",
    });
    expect(await store.listDevices(PROJECT_B)).toEqual([]);
  });

  it("the device's project comes from the offer, never from the request", async () => {
    const offer = await createPairingOffer(store, PROJECT_A);
    const a = new TestAgent(now);
    expect(await code(redeemPairing(deps, a.pairBody(offer.code, { projectId: PROJECT_B })))).toBe(
      "malformed_request",
    );
    const r = await redeemPairing(deps, a.pairBody(offer.code));
    expect(r.device.projectId).toBe(PROJECT_A);
    a.deviceId = r.device.id;
    // a heartbeat cannot nominate a project either
    const nominated = a.request("POST", "/api/local-agent/v1/heartbeat", {
      protocol: PROTOCOL,
      capabilities: capabilities(),
      projectId: PROJECT_B,
    });
    expect(await code(heartbeat(deps, nominated))).toBe("malformed_request");
  });

  it("ownership is re-checked at redemption (project changed hands or is gone)", async () => {
    const offer = await createPairingOffer(store, PROJECT_A);
    owners.set(PROJECT_A, STRANGER);
    expect(await code(redeemPairing(deps, new TestAgent(now).pairBody(offer.code)))).toBe(
      "project_forbidden",
    );
    owners.delete(PROJECT_A);
    expect(await code(redeemPairing(deps, new TestAgent(now).pairBody(offer.code)))).toBe(
      "project_forbidden",
    );
  });

  it("only the project owner can create a pairing code", async () => {
    actingUser = STRANGER;
    await expect(createPairingOffer(store, PROJECT_A)).rejects.toThrow();
    expect(store.pairings.size).toBe(0);
  });

  it("concurrent redemptions of one code: exactly one device", async () => {
    const offer = await createPairingOffer(store, PROJECT_A);
    const results = await Promise.all(
      Array.from({ length: 12 }, () => code(redeemPairing(deps, new TestAgent(now).pairBody(offer.code)))),
    );
    expect(results.filter((r) => r === "no error")).toHaveLength(1);
    expect(results.filter((r) => r === "pairing_consumed")).toHaveLength(11);
    expect(await store.listDevices(PROJECT_A)).toHaveLength(1);
  });

  it("refuses a malformed public key, wrong protocol, wrong origin, skewed clock or missing key possession", async () => {
    const offer = await createPairingOffer(store, PROJECT_A);
    const a = new TestAgent(now);
    expect(await code(redeemPairing(deps, a.pairBody(offer.code, { publicKey: "MCowBQYDK2VwAyEA" })))).toBe(
      "malformed_request",
    );
    expect(
      await code(redeemPairing(deps, a.pairBody(offer.code, { protocol: "prism.local-agent.v2" }))),
    ).toBe("protocol_unsupported");
    expect(
      await code(redeemPairing(deps, a.pairBody(offer.code, { serverOrigin: "https://evil.example.test" }))),
    ).toBe("origin_mismatch");
    expect(await code(redeemPairing(deps, a.pairBody(offer.code, { timestamp: clock - 6 * 60_000 })))).toBe(
      "clock_skew",
    );
    // proof signed by a DIFFERENT key than the one being registered
    const other = new TestAgent(now);
    expect(await code(redeemPairing(deps, a.pairBody(offer.code, {}, other.privateKey)))).toBe(
      "invalid_signature",
    );
    expect(await code(redeemPairing(deps, { ...a.pairBody(offer.code), extra: 1 }))).toBe(
      "malformed_request",
    );
    expect(await code(redeemPairing(deps, null))).toBe("malformed_request");
    // none of these consumed the code
    expect(await pairingOfferState(store, PROJECT_A, offer.pairingId, clock)).toMatchObject({
      state: "pending",
    });
    await redeemPairing(deps, a.pairBody(offer.code));
  });

  it("a device key is never registered twice (re-pairing needs a new key); the code survives", async () => {
    const agent = await paired(PROJECT_A);
    const offer = await createPairingOffer(store, PROJECT_B);
    expect(await code(redeemPairing(deps, agent.pairBody(offer.code)))).toBe("malformed_request");
    expect(await pairingOfferState(store, PROJECT_B, offer.pairingId, clock)).toMatchObject({
      state: "pending",
    });
  });
});

// ───────────────────────── heartbeat / signed requests ─────────────────────────

describe("signed heartbeat", () => {
  it("authenticates, advances the counter, updates last seen and stores safe capabilities", async () => {
    const agent = await paired();
    const r = await heartbeat(deps, agent.heartbeat());
    expect(r).toMatchObject({ ok: true, acceptedCounter: 1, jobs: [], device: { status: "active" } });
    const [d] = await store.listDevices(PROJECT_A);
    expect(d.lastCounter).toBe(1);
    expect(d.lastSeenAt).toBe(new Date(clock).toISOString());
    expect(d.capabilities?.toolchain.state).toBe("ready");
    clock += 10_000;
    await heartbeat(deps, agent.heartbeat({}, capabilities({ state: "gpu_unavailable" })));
    const [d2] = await store.listDevices(PROJECT_A);
    expect(d2).toMatchObject({ lastCounter: 2, lastSeenAt: new Date(clock).toISOString() });
    expect(d2.capabilities?.toolchain.state).toBe("gpu_unavailable");
  });

  it("a replayed or older counter is refused and changes nothing", async () => {
    const agent = await paired();
    const req = agent.heartbeat();
    await heartbeat(deps, req);
    expect(await code(heartbeat(deps, req))).toBe("counter_replayed");
    expect(await code(heartbeat(deps, agent.heartbeat({ counter: 1 })))).toBe("counter_replayed");
    // a counter that skips ahead (a lost response) is fine
    expect((await heartbeat(deps, agent.heartbeat({ counter: 7 }))).acceptedCounter).toBe(7);
    expect(await code(heartbeat(deps, agent.heartbeat({ counter: 5 })))).toBe("counter_replayed");
    expect((await store.listDevices(PROJECT_A))[0].lastCounter).toBe(7);
  });

  it("concurrent requests with the same counter: exactly one is accepted", async () => {
    const agent = await paired();
    const reqs = Array.from({ length: 10 }, () => agent.heartbeat({ counter: 1 }));
    const results = await Promise.all(reqs.map((r) => code(heartbeat(deps, r))));
    expect(results.filter((r) => r === "no error")).toHaveLength(1);
    expect(results.filter((r) => r === "counter_replayed")).toHaveLength(9);
  });

  it("racing higher counters: requests are serialised on the device; an older counter never lands after a newer one", async () => {
    const agent = await paired();
    // sequential arrival order 5, 3, 9, 1, 7: each accepted counter exceeds every earlier one
    const order = [5, 3, 9, 1, 7].map((counter) => agent.heartbeat({ counter }));
    const results: string[] = [];
    for (const r of order) results.push(await code(heartbeat(deps, r)));
    expect(results).toEqual([
      "no error",
      "counter_replayed",
      "no error",
      "counter_replayed",
      "counter_replayed",
    ]);
    expect((await store.listDevices(PROJECT_A))[0].lastCounter).toBe(9);
    // concurrent arrival: whichever order the lock grants, the accepted sequence is strictly increasing and the
    // highest counter always wins
    const agent2 = await paired(PROJECT_B);
    const accepted: number[] = [];
    await Promise.all(
      [14, 11, 20, 12, 13, 19].map(async (counter) => {
        try {
          accepted.push((await heartbeat(deps, agent2.heartbeat({ counter }))).acceptedCounter);
        } catch (e) {
          expect((e as AgentProtocolError).code).toBe("counter_replayed");
        }
      }),
    );
    expect(accepted).toContain(20);
    expect([...accepted].sort((x, y) => x - y)).toEqual(accepted);
    expect((await store.listDevices(PROJECT_B))[0].lastCounter).toBe(20);
  });

  it("refuses a skewed clock without consuming the counter", async () => {
    const agent = await paired();
    expect(
      await code(heartbeat(deps, agent.heartbeat({ counter: 1, timestamp: clock + 5 * 60_000 + 1 }))),
    ).toBe("clock_skew");
    expect(await code(heartbeat(deps, agent.heartbeat({ counter: 1, timestamp: clock - 6 * 60_000 })))).toBe(
      "clock_skew",
    );
    expect((await heartbeat(deps, agent.heartbeat({ counter: 1 }))).acceptedCounter).toBe(1);
  });

  it("a tampered body, path, method or another device's id fails the signature", async () => {
    const agent = await paired();
    const other = await paired(PROJECT_B);
    const good = agent.heartbeat({ counter: 1 });
    const tampered = {
      ...good,
      body: Buffer.from(
        JSON.stringify({ protocol: PROTOCOL, capabilities: capabilities({ state: "brush_missing" }) }),
      ),
    };
    expect(await code(heartbeat(deps, tampered))).toBe("invalid_signature");
    expect(
      await code(heartbeat(deps, { ...good, url: new URL("/api/local-agent/v1/heartbeat?x=1", ORIGIN) })),
    ).toBe("invalid_signature");
    expect(await code(heartbeat(deps, { ...good, method: "PUT" }))).toBe("invalid_signature");
    // agent A's key, claiming device B (another project): refused
    expect(await code(heartbeat(deps, agent.heartbeat({ counter: 1, agentId: other.deviceId })))).toBe(
      "invalid_signature",
    );
    expect(await code(heartbeat(deps, agent.heartbeat({ counter: 1, agentId: randomUUID() })))).toBe(
      "device_unknown",
    );
    expect((await store.listDevices(PROJECT_B))[0].lastCounter).toBe(0);
    expect((await heartbeat(deps, good)).acceptedCounter).toBe(1);
  });

  it("refuses malformed capabilities, protocol versions and headers before touching the device", async () => {
    const agent = await paired();
    const bad = agent.request("POST", "/api/local-agent/v1/heartbeat", {
      protocol: PROTOCOL,
      capabilities: { ...capabilities(), hostname: "DESKTOP-1" },
    });
    expect(await code(heartbeat(deps, bad))).toBe("malformed_request");
    const v2 = agent.request("POST", "/api/local-agent/v1/heartbeat", {
      protocol: "prism.local-agent.v2",
      capabilities: capabilities(),
    });
    expect(await code(heartbeat(deps, v2))).toBe("protocol_unsupported");
    const good = agent.heartbeat({ counter: 1 });
    const hdr = (over: Record<string, string | null>) => ({
      ...good,
      header: (n: string) => (n in over ? over[n] : good.header(n)),
    });
    expect(await code(heartbeat(deps, hdr({ "x-prism-agent-protocol": "2" })))).toBe("protocol_unsupported");
    expect(await code(heartbeat(deps, hdr({ "x-prism-agent-protocol": null })))).toBe("malformed_request");
    expect(await code(heartbeat(deps, hdr({ "x-prism-agent-counter": "01" })))).toBe("malformed_request");
    expect(await code(heartbeat(deps, hdr({ "x-prism-agent-counter": "0" })))).toBe("malformed_request");
    expect(await code(heartbeat(deps, hdr({ "x-prism-agent-signature": "!!" })))).toBe("malformed_request");
    expect(await code(heartbeat(deps, hdr({ "x-prism-agent-id": "nope" })))).toBe("malformed_request");
    // a header sent twice reaches the handler comma-joined (Fetch Headers) and fails every header grammar
    const twice = new Headers();
    twice.append("x-prism-agent-counter", "1");
    twice.append("x-prism-agent-counter", "2");
    expect(twice.get("x-prism-agent-counter")).toBe("1, 2");
    const sig = good.header("x-prism-agent-signature")!;
    const id = good.header("x-prism-agent-id")!;
    for (const [h, v] of [
      ["x-prism-agent-counter", "1, 2"],
      ["x-prism-agent-counter", "1,1"],
      ["x-prism-agent-timestamp", `${clock}, ${clock}`],
      ["x-prism-agent-signature", `${sig}, ${sig}`],
      ["x-prism-agent-id", `${id}, ${id}`],
      ["x-prism-agent-protocol", "1, 1"],
    ])
      expect([h, await code(heartbeat(deps, hdr({ [h]: v })))]).toEqual([
        h,
        h === "x-prism-agent-protocol" ? "protocol_unsupported" : "malformed_request",
      ]);
    // a counter beyond 2^53-1 is refused, never rounded
    expect(await code(heartbeat(deps, hdr({ "x-prism-agent-counter": "9007199254740993" })))).toBe(
      "malformed_request",
    );
    expect(await code(heartbeat(deps, hdr({ "x-prism-agent-counter": "1".repeat(17) })))).toBe(
      "malformed_request",
    );
    expect((await store.listDevices(PROJECT_A))[0].lastCounter).toBe(0);
  });

  it("status answers with the device's OWN project only, and carries no body", async () => {
    const agent = await paired(PROJECT_A);
    await paired(PROJECT_B);
    const s = await status(deps, agent.request("GET", "/api/local-agent/v1/status", null));
    expect(s).toMatchObject({
      device: { id: agent.deviceId, projectId: PROJECT_A, status: "active" },
      project: { id: PROJECT_A, title: "Project A" },
      remoteExecution: "not_available",
    });
    expect(
      await code(
        status(
          deps,
          agent.request("GET", "/api/local-agent/v1/status", null, { rawBody: Buffer.from("{}") }),
        ),
      ),
    ).toBe("malformed_request");
  });

  it("a device whose project changed hands is refused", async () => {
    const agent = await paired();
    owners.set(PROJECT_A, STRANGER);
    expect(await code(heartbeat(deps, agent.heartbeat()))).toBe("project_forbidden");
  });
});

// ───────────────────────── revocation and owner operations ─────────────────────────

describe("revocation", () => {
  it("the owner revokes; every later signed request is refused; it is never reactivated; history stays", async () => {
    const agent = await paired();
    await heartbeat(deps, agent.heartbeat());
    const revoked = await revokeAgent(store, PROJECT_A, agent.deviceId);
    expect(revoked).toMatchObject({ status: "revoked" });
    expect(revoked.revokedAt).not.toBeNull();
    expect(await code(heartbeat(deps, agent.heartbeat()))).toBe("device_revoked");
    expect(await code(status(deps, agent.request("GET", "/api/local-agent/v1/status", null)))).toBe(
      "device_revoked",
    );
    expect(await code(heartbeat(deps, agent.heartbeat({ counter: 99 })))).toBe("device_revoked");
    const [d] = await store.listDevices(PROJECT_A);
    expect(d).toMatchObject({ status: "revoked", lastCounter: 1 });
    // revoking again changes nothing; renaming revoked history is refused
    expect((await revokeAgent(store, PROJECT_A, agent.deviceId)).revokedAt).toBe(revoked.revokedAt);
    await expect(renameAgent(store, PROJECT_A, agent.deviceId, "New name")).rejects.toThrow();
  });

  it("a non-owner cannot revoke, rename or list; another project's id does not reach the device", async () => {
    const agent = await paired(PROJECT_A);
    actingUser = STRANGER;
    await expect(revokeAgent(store, PROJECT_A, agent.deviceId)).rejects.toThrow();
    await expect(renameAgent(store, PROJECT_A, agent.deviceId, "x")).rejects.toThrow();
    expect(await store.listDevices(PROJECT_A)).toEqual([]);
    actingUser = OWNER;
    await expect(revokeAgent(store, PROJECT_B, agent.deviceId)).rejects.toThrow();
    expect((await store.listDevices(PROJECT_A))[0].status).toBe("active");
  });

  it("re-pairing creates a NEW device identity; the revoked one stays revoked", async () => {
    const first = await paired();
    await revokeAgent(store, PROJECT_A, first.deviceId);
    const second = await paired();
    expect(second.deviceId).not.toBe(first.deviceId);
    const list = await store.listDevices(PROJECT_A);
    expect(list.map((d) => d.status).sort()).toEqual(["active", "revoked"]);
  });

  it("rename validates the label", async () => {
    const agent = await paired();
    expect((await renameAgent(store, PROJECT_A, agent.deviceId, "  Studio PC  ")).label).toBe("Studio PC");
    await expect(renameAgent(store, PROJECT_A, agent.deviceId, "")).rejects.toThrow();
    await expect(renameAgent(store, PROJECT_A, agent.deviceId, "a\u0007b")).rejects.toThrow();
    await expect(renameAgent(store, PROJECT_A, agent.deviceId, "x".repeat(65))).rejects.toThrow();
  });
});

// ───────────────────────── HTTP framing ─────────────────────────

describe("HTTP framing", () => {
  const post = (path: string, body: string, headers: Record<string, string> = {}) =>
    new Request(new URL(path, ORIGIN), {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });
  const json = async (r: Response) => (await r.json()) as { ok: boolean; error?: { code: string } };

  it("refuses oversized payloads before parsing them", async () => {
    const big = JSON.stringify({ pad: "x".repeat(BODY_LIMITS.pair + 1) });
    const r = await handlePair(post("/api/local-agent/v1/pair", big), deps);
    expect(r.status).toBe(413);
    expect((await json(r)).error?.code).toBe("payload_too_large");
    // a streamed body without a declared length is cut at the limit too
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("x".repeat(BODY_LIMITS.heartbeat + 10)));
        c.close();
      },
    });
    const r2 = await handleHeartbeat(
      new Request(new URL("/api/local-agent/v1/heartbeat", ORIGIN), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: stream,
        duplex: "half",
      } as RequestInit),
      deps,
    );
    expect((await json(r2)).error?.code).toBe("payload_too_large");
  });

  it("requires JSON and answers in the protocol envelope with no-store", async () => {
    const r = await handlePair(
      post("/api/local-agent/v1/pair", "{}", { "content-type": "text/plain" }),
      deps,
    );
    expect(r.status).toBe(400);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const body = await json(r);
    expect(body).toMatchObject({ protocol: PROTOCOL, ok: false, error: { code: "malformed_request" } });
    const bad = await handlePair(post("/api/local-agent/v1/pair", "{not json"), deps);
    expect((await json(bad)).error?.code).toBe("malformed_request");
  });

  it("pairs and heartbeats end to end through Request/Response", async () => {
    const offer = await createPairingOffer(store, PROJECT_A);
    const agent = new TestAgent(now);
    const r = await handlePair(
      post("/api/local-agent/v1/pair", JSON.stringify(agent.pairBody(offer.code))),
      deps,
    );
    expect(r.status).toBe(200);
    agent.deviceId = ((await r.json()) as { device: { id: string } }).device.id;
    const hb = agent.heartbeat();
    const headers: Record<string, string> = { "content-type": "application/json" };
    for (const n of [
      "x-prism-agent-protocol",
      "x-prism-agent-id",
      "x-prism-agent-counter",
      "x-prism-agent-timestamp",
      "x-prism-agent-signature",
    ])
      headers[n] = hb.header(n)!;
    const res = await handleHeartbeat(
      new Request(hb.url, { method: "POST", headers, body: Buffer.from(hb.body) }),
      deps,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, acceptedCounter: 1 });
    const replay = await handleHeartbeat(
      new Request(hb.url, { method: "POST", headers, body: Buffer.from(hb.body) }),
      deps,
    );
    expect(replay.status).toBe(409);
    expect((await json(replay)).error?.code).toBe("counter_replayed");
    const st = agent.request("GET", "/api/local-agent/v1/status", null);
    const sh: Record<string, string> = {};
    for (const n of [
      "x-prism-agent-protocol",
      "x-prism-agent-id",
      "x-prism-agent-counter",
      "x-prism-agent-timestamp",
      "x-prism-agent-signature",
    ])
      sh[n] = st.header(n)!;
    const sr = await handleStatus(new Request(st.url, { method: "GET", headers: sh }), deps);
    expect(sr.status).toBe(200);
  });
});
