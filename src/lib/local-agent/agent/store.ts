import { generateKeyPairSync, createPrivateKey, randomBytes, type KeyObject } from "node:crypto";
import { open, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { exportPublicKey, parsePublicKey } from "../crypto";
import { HEX64_RE, PROTOCOL_VERSION, UUID_RE } from "../protocol";

/**
 * The workstation's local state for ONE paired device (a profile directory):
 *
 *   device-key.pem   the Ed25519 PRIVATE key (PKCS#8 PEM). Generated here; never sent anywhere.
 *   agent.json       the device's public facts: id, project, pinned server origin, key fingerprint, the last request
 *                    counter used. No database URL, Supabase key, Storage or provider credential, and never the
 *                    pairing code (it is single-use and forgotten as soon as pairing completes).
 *
 * Files are written atomically (temporary file, fsync, rename) with owner-only permissions (0600; directories 0700).
 * On Windows those POSIX modes are NOT an access-control list: the files are protected only by the per-user
 * %LOCALAPPDATA% directory's inherited ACL. DPAPI / OS key-store protection is future packaging work.
 */

export const CONFIG_SCHEMA = "prism.local-agent-config.v1" as const;
export const KEY_FILE = "device-key.pem";
export const PENDING_KEY_FILE = "device-key.pending.pem";
export const CONFIG_FILE = "agent.json";

export class AgentStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentStateError";
  }
}

export const agentConfigSchema = z
  .object({
    schema: z.literal(CONFIG_SCHEMA),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    deviceId: z.string().regex(UUID_RE),
    projectId: z.string().regex(UUID_RE),
    serverOrigin: z.string().max(200),
    label: z.string().max(64),
    publicKeyFingerprint: z.string().regex(HEX64_RE),
    privateKeyFile: z.literal(KEY_FILE),
    /** the last counter USED (persisted before the request is sent; the next request uses lastCounter + 1) */
    lastCounter: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    pairedAt: z.string().max(40),
    /** set when the server answered device_revoked: this profile never signs again */
    revokedAt: z.string().max(40).nullable(),
  })
  .strict();
export type AgentConfig = z.infer<typeof agentConfigSchema>;

const POSIX = process.platform !== "win32";

/** Atomic, durable write: temp file → fsync → rename (a crash leaves the old or the new file, never half of one). */
export async function writeFileAtomic(file: string, data: string, mode = 0o600): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  const fh = await open(tmp, "wx", mode);
  try {
    await fh.writeFile(data, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}

async function assertPrivate(file: string) {
  if (!POSIX) return; // Windows: see the module note (no POSIX mode semantics)
  const s = await stat(file);
  if ((s.mode & 0o077) !== 0)
    throw new AgentStateError(
      `${path.basename(file)} is readable by other users; restrict it to the owner (chmod 600) before running.`,
    );
}

/** Key storage abstraction: a packaged agent can later back this with DPAPI / Keychain / Secret Service. */
export interface AgentKeyStore {
  /** generates a NEW key pair as a pending key (refused if one exists); returns the public facts */
  createPending(): Promise<{ publicKey: string; fingerprint: string; privateKey: KeyObject }>;
  /** the pending key becomes the device key (after the server accepted it) */
  commitPending(): Promise<void>;
  discardPending(): Promise<void>;
  load(): Promise<KeyObject>;
  remove(): Promise<void>;
}

export class FileKeyStore implements AgentKeyStore {
  constructor(private readonly dir: string) {}

  async createPending() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    // wx: never overwrite an existing key
    await writeFile(path.join(this.dir, PENDING_KEY_FILE), pem, { flag: "wx", mode: 0o600 });
    const b64 = exportPublicKey(publicKey);
    return { publicKey: b64, fingerprint: parsePublicKey(b64).fingerprint, privateKey };
  }

  async commitPending() {
    const target = path.join(this.dir, KEY_FILE);
    if (await stat(target).catch(() => null)) throw new AgentStateError("A device key already exists.");
    await rename(path.join(this.dir, PENDING_KEY_FILE), target);
  }

  async discardPending() {
    await rm(path.join(this.dir, PENDING_KEY_FILE), { force: true });
  }

  async load(): Promise<KeyObject> {
    const file = path.join(this.dir, KEY_FILE);
    const pem = await readFile(file, "utf8").catch(() => null);
    if (pem === null) throw new AgentStateError("This profile has no device key. Pair the agent first.");
    await assertPrivate(file);
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== "ed25519") throw new AgentStateError("The device key is not Ed25519.");
    return key;
  }

  async remove() {
    await rm(path.join(this.dir, KEY_FILE), { force: true });
    await rm(path.join(this.dir, PENDING_KEY_FILE), { force: true });
  }
}

export async function readConfig(dir: string): Promise<AgentConfig | null> {
  const file = path.join(dir, CONFIG_FILE);
  const text = await readFile(file, "utf8").catch(() => null);
  if (text === null) return null;
  await assertPrivate(file);
  let parsed;
  try {
    parsed = agentConfigSchema.safeParse(JSON.parse(text));
  } catch {
    parsed = null;
  }
  if (!parsed?.success)
    throw new AgentStateError(`${CONFIG_FILE} is unreadable. Forget this profile and pair the agent again.`);
  return parsed.data;
}

export async function writeConfig(dir: string, config: AgentConfig): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFileAtomic(
    path.join(dir, CONFIG_FILE),
    `${JSON.stringify(agentConfigSchema.parse(config), null, 2)}\n`,
  );
}

/**
 * Reserves the next request counter: lastCounter + 1 is written durably BEFORE the request is signed and sent, so a
 * crash or a lost response can never make this device reuse a counter (it only ever skips ahead).
 */
export async function reserveCounter(dir: string): Promise<{ counter: number; config: AgentConfig }> {
  const config = await readConfig(dir);
  if (!config) throw new AgentStateError("This profile is not paired.");
  const counter = config.lastCounter + 1;
  if (!Number.isSafeInteger(counter))
    throw new AgentStateError("The request counter is exhausted; pair again.");
  const next = { ...config, lastCounter: counter };
  await writeConfig(dir, next);
  return { counter, config: next };
}
