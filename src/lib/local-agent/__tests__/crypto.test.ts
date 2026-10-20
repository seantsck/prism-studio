import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  bodySha256,
  canonicalPairingSecret,
  canonicalRequestMessage,
  canonicalTarget,
  decodeSignature,
  exportPublicKey,
  generatePairingSecret,
  normalizeServerOrigin,
  PAIRING_ALPHABET,
  PAIRING_ENTROPY_BITS,
  pairingSecretHash,
  pairProofMessage,
  parsePublicKey,
  publicKeyFingerprint,
  signMessage,
  verifyMessage,
  type SignedRequestFields,
} from "../crypto";
import { agentOnline, capabilitiesSchema, CAPABILITIES_SCHEMA } from "../protocol";

// ── golden vector: RFC 8032 §7.1 TEST 1 key (a published test key, never a real device key) ──
const RFC_SEED = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const RFC_PUBLIC_HEX = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
const RFC_EMPTY_SIGNATURE =
  "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b";
const priv = createPrivateKey({
  key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(RFC_SEED, "hex")]),
  format: "der",
  type: "pkcs8",
});
const pub = createPublicKey(priv);
const PUBLIC_KEY_B64 = "MCowBQYDK2VwAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=";
const FINGERPRINT = "06e3fd8fda29bb60ab59557de61edb0aecdb231134be30e75b455f8e1b792fa9";
const EMPTY_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const FIELDS: SignedRequestFields = {
  agentId: "0b5c2f1e-8d3a-4c6b-9e7f-1a2b3c4d5e6f",
  counter: 42,
  timestamp: 1760000000000,
  method: "POST",
  target: "/api/local-agent/v1/heartbeat",
  bodySha256: EMPTY_SHA,
};
const GOLDEN_MESSAGE =
  "prism-local-agent-request/1\n0b5c2f1e-8d3a-4c6b-9e7f-1a2b3c4d5e6f\n42\n1760000000000\nPOST\n" +
  "/api/local-agent/v1/heartbeat\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const GOLDEN_SIGNATURE =
  "Bt75Omih0oiLPHz7cK-scA5ka8HfQY1-nrqZ1IDLHB9Gkd-v2tn67R9CVSYBki9cYE89OKkKS3uPxZQNK2-6BA";

describe("Ed25519 (Node built-in) matches RFC 8032", () => {
  it("derives the RFC public key and signature", () => {
    expect(Buffer.from(exportPublicKey(pub), "base64").subarray(12).toString("hex")).toBe(RFC_PUBLIC_HEX);
    expect(sign(null, Buffer.alloc(0), priv).toString("hex")).toBe(RFC_EMPTY_SIGNATURE);
  });
});

describe("device public key encoding", () => {
  it("is SPKI DER base64 with a sha256(DER) fingerprint", () => {
    expect(exportPublicKey(pub)).toBe(PUBLIC_KEY_B64);
    expect(publicKeyFingerprint(PUBLIC_KEY_B64)).toBe(FINGERPRINT);
    expect(parsePublicKey(PUBLIC_KEY_B64).der).toHaveLength(44);
  });

  it("refuses malformed, non-canonical and non-Ed25519 keys", () => {
    expect(() => parsePublicKey("")).toThrow();
    expect(() => parsePublicKey("not base64!")).toThrow();
    expect(() => parsePublicKey(PUBLIC_KEY_B64.slice(0, -2) + "==")).toThrow();
    // non-canonical last character (unused bits set) decodes to the same bytes but is refused
    const nonCanonical = PUBLIC_KEY_B64.replace(/o=$/, "p=");
    expect(nonCanonical).not.toBe(PUBLIC_KEY_B64);
    expect(() => parsePublicKey(nonCanonical)).toThrow();
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey;
    expect(() => parsePublicKey(ec.export({ format: "der", type: "spki" }).toString("base64"))).toThrow();
    const x25519 = generateKeyPairSync("x25519").publicKey.export({ format: "der", type: "spki" });
    expect(() => parsePublicKey(x25519.toString("base64"))).toThrow();
    const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey;
    expect(() => parsePublicKey(rsa.export({ format: "der", type: "spki" }).toString("base64"))).toThrow();
    // malformed DER: the right prefix with a wrong length byte
    const der = Buffer.from(PUBLIC_KEY_B64, "base64");
    const badLen = Buffer.from(der);
    badLen[1] = 0x2b;
    expect(() => parsePublicKey(badLen.toString("base64"))).toThrow();
    // extra trailing bytes after a valid SPKI
    expect(() => parsePublicKey(Buffer.concat([der, Buffer.from([0])]).toString("base64"))).toThrow();
    // private-key material (PKCS8 DER) is never accepted as a public key
    const pkcs8 = priv.export({ format: "der", type: "pkcs8" }).toString("base64");
    expect(() => parsePublicKey(pkcs8)).toThrow();
    // standard base64 only: the base64url spelling is refused
    const urlSafe = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" });
    const b64url = urlSafe.toString("base64url");
    if (b64url !== urlSafe.toString("base64").replace(/=+$/, ""))
      expect(() => parsePublicKey(`${b64url}=`)).toThrow();
    expect(() => parsePublicKey(PUBLIC_KEY_B64.slice(0, -1))).toThrow(); // padding is required
  });
});

describe("canonical signed request (golden vector)", () => {
  it("produces exactly the documented bytes", () => {
    expect(canonicalRequestMessage(FIELDS).toString("utf8")).toBe(GOLDEN_MESSAGE);
    expect(bodySha256(new Uint8Array(0))).toBe(EMPTY_SHA);
  });

  it("the known signature verifies (Ed25519 is deterministic)", () => {
    expect(signMessage(priv, canonicalRequestMessage(FIELDS))).toBe(GOLDEN_SIGNATURE);
    expect(verifyMessage(pub, Buffer.from(GOLDEN_MESSAGE), GOLDEN_SIGNATURE)).toBe(true);
  });

  it.each<[string, Partial<SignedRequestFields>]>([
    ["method", { method: "GET" }],
    ["path", { target: "/api/local-agent/v1/status" }],
    ["query", { target: "/api/local-agent/v1/heartbeat?a=1" }],
    ["body", { bodySha256: bodySha256("{}") }],
    ["timestamp", { timestamp: 1760000000001 }],
    ["counter", { counter: 43 }],
    ["agent id", { agentId: "0b5c2f1e-8d3a-4c6b-9e7f-1a2b3c4d5e70" }],
  ])("changing the %s invalidates the signature", (_name, change) => {
    expect(verifyMessage(pub, canonicalRequestMessage({ ...FIELDS, ...change }), GOLDEN_SIGNATURE)).toBe(
      false,
    );
  });

  it("a wrong public key, a malformed or truncated signature never verify (and never throw)", () => {
    const other = generateKeyPairSync("ed25519").publicKey;
    const msg = canonicalRequestMessage(FIELDS);
    expect(verifyMessage(other, msg, GOLDEN_SIGNATURE)).toBe(false);
    expect(verifyMessage(pub, msg, GOLDEN_SIGNATURE.slice(0, -1))).toBe(false);
    expect(verifyMessage(pub, msg, `${GOLDEN_SIGNATURE.slice(0, -1)}!`)).toBe(false);
    expect(verifyMessage(pub, msg, Buffer.from(GOLDEN_SIGNATURE, "base64url").toString("base64"))).toBe(
      false,
    );
    expect(verifyMessage(pub, msg, "")).toBe(false);
    expect(decodeSignature("A".repeat(86))).not.toBeNull();
    expect(decodeSignature("A".repeat(85) + "B")).toBeNull(); // non-canonical trailing bits
  });

  it("refuses ambiguous or out-of-grammar fields instead of signing them", () => {
    const bad: Array<Partial<SignedRequestFields>> = [
      { agentId: "0B5C2F1E-8D3A-4C6B-9E7F-1A2B3C4D5E6F" },
      { agentId: "x\n42" },
      { counter: 0 },
      { counter: -1 },
      { counter: 1.5 },
      { counter: Number.MAX_SAFE_INTEGER + 1 },
      { timestamp: -1 },
      { method: "post" },
      { method: "PO\nST" },
      { target: "api/no-leading-slash" },
      { target: "/a\nb" },
      { target: "/a b" },
      { bodySha256: EMPTY_SHA.toUpperCase() },
      { bodySha256: "abc" },
    ];
    for (const b of bad) expect(() => canonicalRequestMessage({ ...FIELDS, ...b })).toThrow();
  });
});

describe("canonical target", () => {
  const t = (u: string) => canonicalTarget(new URL(u, "https://studio.example.test"));
  it("keeps a canonical path and sorts/re-encodes the query", () => {
    expect(t("/api/local-agent/v1/status")).toBe("/api/local-agent/v1/status");
    expect(t("/x?b=2&a=1&c=0")).toBe("/x?a=1&b=2&c=0");
    expect(t("/x?q=a b&r=%7e")).toBe("/x?q=a%20b&r=~");
    expect(t("/x?q=a+b")).toBe("/x?q=a%20b");
    expect(t("/x?k=%E2%9C%93&k2='")).toBe("/x?k=%E2%9C%93&k2=%27");
    expect(t("/x?")).toBe("/x");
    // "+" and "%20" are the same value to the handler (form decoding), so they sign the same bytes
    expect(t("/x?q=a+b")).toBe(t("/x?q=a%20b"));
    // keys are case-sensitive: different keys, different targets
    expect(t("/x?A=1")).not.toBe(t("/x?a=1"));
  });
  it("refuses a query naming a key twice (its meaning would depend on which value a handler reads)", () => {
    expect(() => t("/x?a=1&a=0")).toThrow();
    expect(() => t("/x?a=1&b=2&a=1")).toThrow();
    expect(() => t("/x?a+b=1&a%20b=2")).toThrow(); // the same decoded key
  });
  it("refuses a non-canonical path rather than guessing", () => {
    expect(() => t("/x/")).toThrow();
    expect(() => t("/x//y")).toThrow();
    expect(() => t("/x/%7e")).toThrow(); // lowercase percent-encoding
    expect(() => t("/x/a%20b")).not.toThrow();
    // an encoded unreserved character has exactly one spelling: the character itself
    expect(() => t("/x/%41")).toThrow();
    expect(() => t("/x/%7E")).toThrow();
    expect(() => t("/x/%2D")).toThrow();
    // %2F stays a byte inside ONE segment: never the same target as a "/" path
    expect(t("/a%2Fb")).toBe("/a%2Fb");
    expect(t("/a%2Fb")).not.toBe(t("/a/b"));
    expect(() => t("/a%2fb")).toThrow();
  });
});

describe("pairing secret", () => {
  it("has at least 128 bits of entropy from the CSPRNG, grouped for display", () => {
    expect(PAIRING_ENTROPY_BITS).toBeGreaterThanOrEqual(128);
    const s = generatePairingSecret();
    expect(s).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){6}[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(PAIRING_ALPHABET).not.toMatch(/[ILOU]/);
    const many = new Set(Array.from({ length: 200 }, () => generatePairingSecret()));
    expect(many.size).toBe(200);
  });

  it("encodes deterministic random bytes exactly", () => {
    const zero = generatePairingSecret((n) => new Uint8Array(n));
    expect(zero).toBe("0000-0000-0000-0000-0000-0000-0000");
    const ones = generatePairingSecret((n) => new Uint8Array(n).fill(255));
    expect(ones).toBe("ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ");
  });

  it("canonicalises typing variations and refuses anything else", () => {
    const s = "ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345";
    expect(canonicalPairingSecret(s)).toBe("ABCDEFGHJKMNPQRSTVWXYZ012345");
    expect(canonicalPairingSecret(s.toLowerCase().replace(/-/g, " "))).toBe("ABCDEFGHJKMNPQRSTVWXYZ012345");
    expect(canonicalPairingSecret("ABCD-EFGH-JKMN-PQRS-TVWX-YZOI-2345")).toBe("ABCDEFGHJKMNPQRSTVWXYZ012345");
    expect(canonicalPairingSecret("123456")).toBeNull();
    expect(canonicalPairingSecret("ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-234U")).toBeNull();
    expect(canonicalPairingSecret("ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-23456")).toBeNull();
  });

  it("is stored only as a domain-separated sha256 digest", () => {
    expect(pairingSecretHash("0123456789ABCDEFGHJKMNPQRSTV")).toBe(
      "b990bf891b366d1f1a368fd8e81d24e53f8146713c8b85a56da919e81fbb6cc3",
    );
  });
});

describe("pairing proof of possession (golden vector)", () => {
  it("signs the documented bytes", () => {
    const m = pairProofMessage({
      serverOrigin: "https://studio.example.test",
      secretHash: "b990bf891b366d1f1a368fd8e81d24e53f8146713c8b85a56da919e81fbb6cc3",
      fingerprint: FINGERPRINT,
      timestamp: 1760000000000,
    });
    expect(m.toString()).toBe(
      "prism-local-agent-pair/1\nhttps://studio.example.test\n" +
        "b990bf891b366d1f1a368fd8e81d24e53f8146713c8b85a56da919e81fbb6cc3\n" +
        `${FINGERPRINT}\n1760000000000`,
    );
    expect(signMessage(priv, m)).toBe(
      "_W7uVrJ60OBJ9phc7M53DydNoEFies50XocQye86s0hzxQr1GvMpEdmyYUTeTQwidQ57rhJPwvcQ5e8haEwhCQ",
    );
    // a request signature can never be replayed as a pairing proof (different, fixed prefixes)
    expect(verifyMessage(pub, m, GOLDEN_SIGNATURE)).toBe(false);
  });
});

describe("server origin pinning", () => {
  it("accepts https and loopback http only, as a bare origin", () => {
    expect(normalizeServerOrigin("https://studio.example.test")).toBe("https://studio.example.test");
    expect(normalizeServerOrigin("https://studio.example.test/")).toBe("https://studio.example.test");
    expect(normalizeServerOrigin("https://STUDIO.example.test:8443")).toBe(
      "https://studio.example.test:8443",
    );
    expect(normalizeServerOrigin("http://localhost:3100")).toBe("http://localhost:3100");
    expect(normalizeServerOrigin("http://127.0.0.1:3100")).toBe("http://127.0.0.1:3100");
    // default ports and scheme case are the same origin
    expect(normalizeServerOrigin("https://studio.example.test:443")).toBe("https://studio.example.test");
    expect(normalizeServerOrigin("HTTPS://Studio.Example.Test")).toBe("https://studio.example.test");
    expect(normalizeServerOrigin("http://[::1]:3100/")).toBe("http://[::1]:3100");
  });
  it.each([
    "http://studio.example.test",
    "file:///etc/passwd",
    "ftp://studio.example.test",
    "javascript:alert(1)",
    "data:text/plain,x",
    "https://user:pw@studio.example.test",
    "https://studio.example.test/path",
    "https://studio.example.test/?q=1",
    "https://studio.example.test/#x",
    "http://localhost.evil.test",
    "not a url",
  ])("refuses %s", (u) => {
    expect(() => normalizeServerOrigin(u)).toThrow();
  });
});

describe("capability schema", () => {
  const ok = {
    schema: CAPABILITIES_SCHEMA,
    agentVersion: "prism-local-agent-0.1.0",
    protocolVersion: 1,
    platform: "win32",
    arch: "x64",
    toolchain: {
      state: "colmap_missing",
      colmap: { provenance: "missing", version: null, fingerprint: null },
      brush: { version: null, compatible: false },
      gpu: { vulkanLoader: true },
      checkedAt: "2026-10-20T00:00:00.000Z",
    },
    engine: { inputKinds: ["images"], inputMimes: ["image/jpeg"], qualityProfiles: ["draft"] },
    busy: false,
  };
  it("accepts safe facts and refuses paths, hostnames or extra fields", () => {
    expect(capabilitiesSchema.safeParse(ok).success).toBe(true);
    expect(capabilitiesSchema.safeParse({ ...ok, hostname: "DESKTOP-1" }).success).toBe(false);
    expect(
      capabilitiesSchema.safeParse({
        ...ok,
        toolchain: { ...ok.toolchain, colmap: { ...ok.toolchain.colmap, path: "C:\\Users\\x\\colmap.exe" } },
      }).success,
    ).toBe(false);
    expect(
      capabilitiesSchema.safeParse({
        ...ok,
        toolchain: { ...ok.toolchain, brush: { version: "C:\\x\\brush", compatible: true } },
      }).success,
    ).toBe(false);
    expect(capabilitiesSchema.safeParse({ ...ok, busy: true }).success).toBe(false);
  });
});

describe("online / offline", () => {
  const now = Date.parse("2026-10-20T12:00:00.000Z");
  const at = (ms: number) => new Date(now + ms).toISOString();
  it("is online only for an active device with a heartbeat in the last 30 s", () => {
    expect(agentOnline("active", at(-10_000), now)).toBe(true);
    expect(agentOnline("active", at(-30_000), now)).toBe(true);
    expect(agentOnline("active", at(-30_001), now)).toBe(false);
    expect(agentOnline("active", null, now)).toBe(false);
    expect(agentOnline("revoked", at(-1_000), now)).toBe(false);
  });
  it("a far-future or malformed last-seen time is offline, never online forever, and never throws", () => {
    expect(agentOnline("active", at(60_000), now)).toBe(true); // within the clock-skew window
    expect(agentOnline("active", at(5 * 60_000 + 1), now)).toBe(false);
    expect(agentOnline("active", "2999-01-01T00:00:00.000Z", now)).toBe(false);
    expect(agentOnline("active", "not a date", now)).toBe(false);
    expect(agentOnline("active", "", now)).toBe(false);
  });
});
