import { createHash, createPublicKey, randomBytes, sign, verify, type KeyObject } from "node:crypto";
import { COUNTER_RE, HEX64_RE, PUBLIC_KEY_RE, SIGNATURE_RE, TIMESTAMP_RE, UUID_RE } from "./protocol";

/**
 * Local Agent protocol v1 cryptography: Node's built-in Ed25519 (no third-party crypto, nothing invented). Every
 * signed message is a fixed, versioned, newline-separated list of fields, each validated against a grammar that cannot
 * contain the separator, so one byte string can only ever mean one request (docs/local-agent-protocol.md §4).
 */

export class ProtocolFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolFormatError";
  }
}

const sha256Hex = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

// ───────────────────────── pairing secret ─────────────────────────

/** Crockford Base32: no I, L, O or U (so no 1/I/L or 0/O confusion when read aloud or retyped). */
export const PAIRING_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** 28 symbols × 5 bits = 140 bits of CSPRNG output (above the 128-bit floor). */
export const PAIRING_SYMBOLS = 28;
export const PAIRING_ENTROPY_BITS = PAIRING_SYMBOLS * 5;

/** A new pairing secret, grouped for display: XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX. */
export function generatePairingSecret(random: (n: number) => Uint8Array = randomBytes): string {
  const bytes = random(Math.ceil((PAIRING_SYMBOLS * 5) / 8)); // 18 bytes = 144 bits; the first 140 are used
  let bits = 0;
  let acc = 0;
  let out = "";
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5 && out.length < PAIRING_SYMBOLS) {
      bits -= 5;
      out += PAIRING_ALPHABET[(acc >> bits) & 31];
    }
    acc &= (1 << bits) - 1;
  }
  return out.match(/.{4}/g)!.join("-");
}

/**
 * The canonical form of a typed/pasted secret: case-insensitive, hyphens and spaces ignored, and Crockford's
 * look-alikes mapped (O→0, I/L→1). Anything else (wrong length, U, punctuation) is not a pairing secret → null.
 */
export function canonicalPairingSecret(input: string): string | null {
  const s = input.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (s.length !== PAIRING_SYMBOLS) return null;
  for (const ch of s) if (!PAIRING_ALPHABET.includes(ch)) return null;
  return s;
}

/** What the server stores and looks up: sha256 over a domain-separated canonical secret (hex). */
export function pairingSecretHash(canonicalSecret: string): string {
  return sha256Hex(`prism-local-agent-pairing-secret/1\n${canonicalSecret}`);
}

// ───────────────────────── device keys ─────────────────────────

const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** The device public key as stored and sent: Ed25519 SubjectPublicKeyInfo DER, standard base64 (60 chars). */
export function exportPublicKey(key: KeyObject): string {
  return key.export({ format: "der", type: "spki" }).toString("base64");
}

/** Strictly parses a public key: exact grammar, canonical base64, the Ed25519 SPKI prefix, a valid key. */
export function parsePublicKey(b64: string): { key: KeyObject; der: Buffer; fingerprint: string } {
  if (!PUBLIC_KEY_RE.test(b64)) throw new ProtocolFormatError("public key is not Ed25519 SPKI base64");
  const der = Buffer.from(b64, "base64");
  if (der.length !== 44 || der.toString("base64") !== b64 || !der.subarray(0, 12).equals(SPKI_PREFIX))
    throw new ProtocolFormatError("public key is not canonical Ed25519 SPKI DER");
  let key: KeyObject;
  try {
    key = createPublicKey({ key: der, format: "der", type: "spki" });
  } catch {
    throw new ProtocolFormatError("public key is not a valid key");
  }
  if (key.asymmetricKeyType !== "ed25519") throw new ProtocolFormatError("public key is not Ed25519");
  return { key, der, fingerprint: sha256Hex(der) };
}

/** sha256 (hex) of the SPKI DER bytes: the device key's fingerprint. */
export function publicKeyFingerprint(b64: string): string {
  return parsePublicKey(b64).fingerprint;
}

/** Strict base64url (no padding) decode of an Ed25519 signature; null when not exactly canonical 64 bytes. */
export function decodeSignature(s: string): Buffer | null {
  if (!SIGNATURE_RE.test(s)) return null;
  const b = Buffer.from(s, "base64url");
  return b.length === 64 && b.toString("base64url") === s ? b : null;
}

export const encodeSignature = (sig: Uint8Array) => Buffer.from(sig).toString("base64url");

export function signMessage(privateKey: KeyObject, message: Buffer): string {
  return encodeSignature(sign(null, message, privateKey));
}

/** Never throws: any malformed input is simply "not valid". */
export function verifyMessage(publicKey: KeyObject, message: Buffer, signature: string): boolean {
  const sig = decodeSignature(signature);
  if (!sig) return false;
  try {
    return verify(null, message, publicKey, sig);
  } catch {
    return false;
  }
}

// ───────────────────────── canonical request target ─────────────────────────

/** RFC 3986 percent-encoding of everything except unreserved characters, uppercase hex, UTF-8. */
export function encodeRfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

const SEGMENT_RE = /^(?:[A-Za-z0-9\-._~]|%[0-9A-F]{2})+$/;
/** A percent-encoded unreserved character (%41 for "A", %7E for "~"...): it has a shorter canonical spelling. */
const ENCODED_UNRESERVED_RE = /%(?:4[1-9A-F]|5[0-9A]|6[1-9A-F]|7[0-9A]|3[0-9]|2D|2E|5F|7E)/;

/**
 * The canonical request target signed by both sides: the path exactly as sent (it must already be canonical: absolute,
 * no empty, "." or ".." segments, no trailing slash, only unreserved characters or uppercase %XX of a reserved byte),
 * then, if there are query parameters, "?" and the parameters decoded, re-encoded per RFC 3986 and sorted by key, joined
 * by "&". A path that is not canonical, or a query naming a key twice (whose meaning would depend on which value a
 * handler reads), is refused rather than normalised (the signer must say exactly what it means).
 */
export function canonicalTarget(url: URL): string {
  const p = url.pathname;
  if (!p.startsWith("/") || p.length > 512) throw new ProtocolFormatError("path is not canonical");
  if (p !== "/") {
    for (const seg of p.slice(1).split("/"))
      if (!SEGMENT_RE.test(seg) || ENCODED_UNRESERVED_RE.test(seg) || seg === "." || seg === "..")
        throw new ProtocolFormatError("path is not canonical");
  }
  const pairs = [...new URLSearchParams(url.search)].map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)]);
  if (new Set(pairs.map(([k]) => k)).size !== pairs.length)
    throw new ProtocolFormatError("query names a parameter more than once");
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const q = pairs.map(([k, v]) => `${k}=${v}`).join("&");
  return q ? `${p}?${q}` : p;
}

// ───────────────────────── canonical messages ─────────────────────────

export const REQUEST_SIGNATURE_PREFIX = "prism-local-agent-request/1";
export const PAIR_PROOF_PREFIX = "prism-local-agent-pair/1";

export interface SignedRequestFields {
  agentId: string;
  counter: number;
  timestamp: number;
  method: string;
  /** canonicalTarget(url) */
  target: string;
  /** sha256 hex of the EXACT body bytes transmitted (the empty string's digest for no body) */
  bodySha256: string;
}

const TARGET_RE = /^\/[A-Za-z0-9\-._~%/]*(\?[A-Za-z0-9\-._~%=&]*)?$/;

/**
 * The exact bytes an agent signs and the server verifies (UTF-8; every character is ASCII):
 *
 *   prism-local-agent-request/1 LF <agent id> LF <counter> LF <unix ms> LF <METHOD> LF <target> LF <body sha256 hex>
 *
 * No trailing newline. Every field is checked against a grammar that excludes LF before the message is built, so the
 * encoding is injective (two different requests can never produce the same bytes).
 */
export function canonicalRequestMessage(f: SignedRequestFields): Buffer {
  if (!UUID_RE.test(f.agentId)) throw new ProtocolFormatError("agent id must be a lowercase UUID");
  if (!Number.isSafeInteger(f.counter) || !COUNTER_RE.test(String(f.counter)))
    throw new ProtocolFormatError("counter must be an integer from 1 to 2^53-1");
  if (!Number.isSafeInteger(f.timestamp) || !TIMESTAMP_RE.test(String(f.timestamp)))
    throw new ProtocolFormatError("timestamp must be a non-negative integer of Unix milliseconds");
  if (!/^[A-Z]{1,10}$/.test(f.method)) throw new ProtocolFormatError("method must be uppercase letters");
  if (!TARGET_RE.test(f.target) || f.target.length > 1024)
    throw new ProtocolFormatError("target must be canonical");
  if (!HEX64_RE.test(f.bodySha256)) throw new ProtocolFormatError("body hash must be lowercase sha256 hex");
  return Buffer.from(
    [
      REQUEST_SIGNATURE_PREFIX,
      f.agentId,
      String(f.counter),
      String(f.timestamp),
      f.method,
      f.target,
      f.bodySha256,
    ].join("\n"),
    "utf8",
  );
}

/**
 * The pairing proof of possession: the agent proves it holds the private key of the public key it registers, bound to
 * the origin it is pairing with and to this one pairing offer (by its secret digest, never the secret itself):
 *
 *   prism-local-agent-pair/1 LF <server origin> LF <pairing secret hash hex> LF <public key fingerprint hex> LF <unix ms>
 */
export function pairProofMessage(f: {
  serverOrigin: string;
  secretHash: string;
  fingerprint: string;
  timestamp: number;
}): Buffer {
  if (!/^https?:\/\/[A-Za-z0-9.\-[\]:]{1,190}$/.test(f.serverOrigin))
    throw new ProtocolFormatError("server origin must be a bare origin");
  if (!HEX64_RE.test(f.secretHash) || !HEX64_RE.test(f.fingerprint))
    throw new ProtocolFormatError("hashes must be lowercase sha256 hex");
  if (!Number.isSafeInteger(f.timestamp) || !TIMESTAMP_RE.test(String(f.timestamp)))
    throw new ProtocolFormatError("timestamp must be a non-negative integer of Unix milliseconds");
  return Buffer.from(
    [PAIR_PROOF_PREFIX, f.serverOrigin, f.secretHash, f.fingerprint, String(f.timestamp)].join("\n"),
    "utf8",
  );
}

export const bodySha256 = (body: Uint8Array | string) => sha256Hex(body);

// ───────────────────────── origins ─────────────────────────

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * A Prism server origin an agent may pair with and is then pinned to: https, or http ONLY for a loopback host
 * (local development: traffic never leaves the machine). No credentials, path, query or fragment. Anything else
 * (file:, ftp:, javascript:, data:, a remote http host...) is refused.
 */
export function normalizeServerOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ProtocolFormatError("The Prism server address is not a valid URL.");
  }
  const loopback = LOOPBACK.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    throw new ProtocolFormatError(
      "The Prism server address must use https:// (http:// is allowed only for localhost).",
    );
  if (url.username || url.password)
    throw new ProtocolFormatError("The Prism server address must not contain credentials.");
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash)
    throw new ProtocolFormatError(
      "Give only the Prism server's origin (scheme, host and port), with no path, query or fragment.",
    );
  return url.origin;
}
