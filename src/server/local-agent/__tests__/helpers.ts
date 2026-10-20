import { generateKeyPairSync, type KeyObject } from "node:crypto";
import {
  bodySha256,
  canonicalPairingSecret,
  canonicalRequestMessage,
  canonicalTarget,
  exportPublicKey,
  pairingSecretHash,
  pairProofMessage,
  publicKeyFingerprint,
  signMessage,
} from "@/lib/local-agent/crypto";
import {
  AGENT_VERSION,
  CAPABILITIES_SCHEMA,
  HEADERS,
  PROTOCOL,
  type AgentCapabilities,
} from "@/lib/local-agent/protocol";
import type { IncomingRequest } from "../service";

export const ORIGIN = "https://studio.example.test";

export function capabilities(over: Partial<AgentCapabilities["toolchain"]> = {}): AgentCapabilities {
  return {
    schema: CAPABILITIES_SCHEMA,
    agentVersion: AGENT_VERSION,
    protocolVersion: 1,
    platform: "win32",
    arch: "x64",
    toolchain: {
      state: "ready",
      colmap: {
        provenance: "verified",
        version: "4.2.1",
        fingerprint: { sourceCommit: "abcdef1", binarySha256: "a".repeat(64) },
      },
      brush: { version: "0.3.0", compatible: true },
      gpu: { vulkanLoader: true },
      checkedAt: "2026-10-20T00:00:00.000Z",
      ...over,
    },
    engine: { inputKinds: ["images"], inputMimes: ["image/jpeg", "image/png"], qualityProfiles: ["draft"] },
    busy: false,
  };
}

/** A fictional workstation: its own Ed25519 key pair and helpers that build protocol messages like the real agent. */
export class TestAgent {
  readonly privateKey: KeyObject;
  readonly publicKey: string;
  readonly fingerprint: string;
  deviceId = "";
  counter = 0;

  constructor(
    readonly now: () => number,
    readonly origin = ORIGIN,
  ) {
    const kp = generateKeyPairSync("ed25519");
    this.privateKey = kp.privateKey;
    this.publicKey = exportPublicKey(kp.publicKey);
    this.fingerprint = publicKeyFingerprint(this.publicKey);
  }

  pairBody(code: string, over: Record<string, unknown> = {}, signer: KeyObject = this.privateKey) {
    const secret = canonicalPairingSecret(code) ?? code;
    const timestamp = (over.timestamp as number | undefined) ?? this.now();
    const serverOrigin = (over.serverOrigin as string | undefined) ?? this.origin;
    let proof = "A".repeat(86);
    try {
      proof = signMessage(
        signer,
        pairProofMessage({
          serverOrigin,
          secretHash: pairingSecretHash(secret),
          fingerprint: this.fingerprint,
          timestamp,
        }),
      );
    } catch {
      /* an intentionally malformed message keeps the placeholder proof */
    }
    return {
      protocol: PROTOCOL,
      pairingCode: code,
      publicKey: this.publicKey,
      serverOrigin,
      timestamp,
      proof,
      device: { label: "Test workstation", platform: "win32", arch: "x64", agentVersion: AGENT_VERSION },
      ...over,
    };
  }

  /** A signed request exactly as the agent client builds it. */
  request(
    method: "GET" | "POST",
    path: string,
    body: unknown | null,
    o: {
      counter?: number;
      timestamp?: number;
      agentId?: string;
      signer?: KeyObject;
      rawBody?: Uint8Array;
    } = {},
  ): IncomingRequest {
    const url = new URL(path, this.origin);
    const bytes = o.rawBody ?? (body === null ? new Uint8Array(0) : Buffer.from(JSON.stringify(body)));
    const counter = o.counter ?? ++this.counter;
    const timestamp = o.timestamp ?? this.now();
    const agentId = o.agentId ?? this.deviceId;
    const signature = signMessage(
      o.signer ?? this.privateKey,
      canonicalRequestMessage({
        agentId,
        counter,
        timestamp,
        method,
        target: canonicalTarget(url),
        bodySha256: bodySha256(body === null && !o.rawBody ? new Uint8Array(0) : bytes),
      }),
    );
    const headers: Record<string, string> = {
      [HEADERS.protocol]: "1",
      [HEADERS.agentId]: agentId,
      [HEADERS.counter]: String(counter),
      [HEADERS.timestamp]: String(timestamp),
      [HEADERS.signature]: signature,
    };
    return { method, url, header: (n) => headers[n.toLowerCase()] ?? null, body: bytes };
  }

  heartbeat(o: Parameters<TestAgent["request"]>[3] = {}, caps = capabilities()) {
    return this.request(
      "POST",
      "/api/local-agent/v1/heartbeat",
      { protocol: PROTOCOL, capabilities: caps },
      o,
    );
  }
}
