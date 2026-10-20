# Prism Local Agent protocol v1 (M2D.3C1)

A **remote Local Agent** is a small program on a user's own workstation that will run local reconstructions for a
hosted Prism Studio (`hosted Prism → the user's workstation → local compute`). This document is the complete v1 wire
contract: another implementation can reproduce it from here. The executable form is `src/lib/local-agent/protocol.ts`
and `src/lib/local-agent/crypto.ts`; the golden vectors in §14 are asserted by
`src/lib/local-agent/__tests__/crypto.test.ts`.

**Scope of M2D.3C1: identity and control plane only.** It covers pairing, device identity, signed requests with replay
protection, heartbeat, capability reporting, revocation and the owner's management UI. **It has no remote execution**:
no job lease, no source download, no reconstruction, no result upload, no Storage grant of any kind (§15).

## 1. Trust model

The workstation is **not** a trusted Prism server. It is an external client, like a browser.

| The workstation holds                        | The workstation never receives                                       |
| -------------------------------------------- | -------------------------------------------------------------------- |
| its own Ed25519 key pair (generated locally) | `SUPABASE_DB_URL` or any database credential                         |
| its device id                                | a Supabase anon/publishable, secret or service-role key              |
| the pinned Prism server origin               | `PRISM_STUDIO_WORKER_SUPABASE_SECRET_KEY` or any Storage credential  |
| its local toolchain                          | a provider key (World Labs, fal.ai, Meshy, Runway, OpenAI, Gemini …) |
| (M2D.3C2) a per-job local workspace          | a user JWT / session, or any other server secret                     |

The Prism **server** stays the authority for user identity, project access, private Assets, job state, reconstruction
persistence, Storage and revocation. The agent talks **only** to Prism's versioned HTTPS endpoints
(`/api/local-agent/v1/*`); it never connects to Supabase. Its CLI (`npm run local:agent`) does not load `.env.local`,
and a source-level test (`boundary.test.ts`) asserts that nothing the CLI can import reaches server, database,
Supabase or Storage-sink code, or names a server credential.

This is a different trust model from the M2D.3B **same-host worker** (`npm run local:reconstruction-worker`), which is
part of the Prism server and does hold server credentials. See
[local-reconstruction.md](local-reconstruction.md#two-different-trust-models-same-host-worker-m2d3b-vs-remote-local-agent-m2d3c).

## 2. Network model

- **Outbound HTTPS only.** No inbound listener, port forwarding, UPnP, tunnel, firewall rule, WebRTC or SSH. Works
  behind ordinary NAT.
- **Origin pinning.** The agent pairs with one origin (scheme, host, port) and sends every later request only there.
  `https:` is required. `http:` is accepted only for a loopback host (`localhost`, `127.0.0.1`, `[::1]`) for local
  development, where traffic never leaves the machine. Origins with credentials, a path, a query or a fragment are
  refused, as is any other scheme (`file:`, `ftp:`, `javascript:`, `data:` …).
- **No redirects.** The agent sends requests with `redirect: manual` and treats any 3xx as an error. An authenticated
  request is never re-sent to another URL.
- Responses larger than 64 KiB, non-JSON responses and responses that fail the schema in §8 are refused.

## 3. Encodings and identifiers

| Item            | Encoding                                                                                  |
| --------------- | ----------------------------------------------------------------------------------------- |
| device id       | server-assigned random UUID, lowercase (`gen_random_uuid()`); never derived from hardware |
| public key      | Ed25519 SubjectPublicKeyInfo DER (44 bytes), standard base64 with padding (60 chars)      |
| key fingerprint | lowercase hex SHA-256 of the 44 DER bytes                                                 |
| signature       | Ed25519 (RFC 8032, pure, no prehash), 64 bytes, base64url **without** padding (86 chars)  |
| counter         | decimal integer 1 … 2^53−1, no sign, no leading zeros                                     |
| timestamp       | decimal Unix milliseconds, 0 … 2^53−1, no leading zeros                                   |
| body hash       | lowercase hex SHA-256 of the exact body bytes transmitted (empty body: `e3b0c442…b855`)   |

Decoders are strict: a public key must match `^MCowBQYDK2VwAyEA[A-Za-z0-9+/]{43}=$`, decode to exactly 44 bytes,
re-encode to the identical string (no non-canonical trailing bits) and start with the Ed25519 SPKI prefix
`302a300506032b6570032100`. A signature must match `^[A-Za-z0-9_-]{86}$` and re-encode identically. Cryptography is
Node's built-in `crypto` (`sign(null, …)` / `verify(null, …)` with Ed25519 keys); there is no third-party crypto.

## 4. Canonical messages

Every signed message is a fixed list of fields joined with a single LF (`0x0A`), UTF-8 (all fields are ASCII), with no
trailing LF. The first field is a versioned **domain-separation prefix**, so a signature for one purpose can never be
replayed as another. Each field is validated against a grammar that **cannot contain LF** before the message is built;
the encoding is therefore injective (two different requests never produce the same bytes) without length prefixes.

### 4.1 Signed request

```
prism-local-agent-request/1
<device id>            lowercase UUID
<counter>              decimal, 1 … 2^53−1
<timestamp>            decimal Unix ms
<METHOD>               uppercase ASCII letters (v1 uses GET and POST)
<canonical target>     §4.2
<body sha256>          lowercase hex
```

### 4.2 Canonical target

1. **Path**: the request path exactly as sent. It must already be canonical: it begins with `/`; it has no empty
   segment (no `//`, no trailing `/` except the root), no `.` or `..` segment, and each segment consists only of RFC
   3986 unreserved characters (`A-Z a-z 0-9 - . _ ~`) or `%XX` with **uppercase** hex. A non-canonical path is
   **refused** (`malformed_request`), never normalised.
2. **Query**: parse the query as `application/x-www-form-urlencoded` (so `+` is a space), percent-decode each key and
   value, re-encode each as UTF-8 with every byte outside the unreserved set as `%XX` (uppercase), sort the pairs by
   encoded key then encoded value (byte order), and join as `k=v` with `&`.
3. The target is the path, followed by `?` and the query **only** if there is at least one pair.

Example: `/x?b=2&a=1&a=0&q=a+b` → `/x?a=0&a=1&b=2&q=a%20b`.

### 4.3 Pairing proof of possession

```
prism-local-agent-pair/1
<server origin>        the bare origin being paired with (§2)
<pairing secret hash>  §5.1, lowercase hex
<key fingerprint>      §3
<timestamp>            decimal Unix ms
```

## 5. Pairing

### 5.1 The pairing offer (browser, project owner)

The project owner opens **Project → Local agents → Pair Local Agent**. The server (as that user, under RLS) creates a
one-time offer:

- **Secret**: 140 bits from the OS CSPRNG (`crypto.randomBytes`), encoded as 28 symbols of Crockford Base32
  (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`: no I, L, O or U) and displayed in groups of four:
  `XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX`. This is far above the 128-bit floor for an unauthenticated redemption
  endpoint; it is not a short numeric code.
- **Canonical form** (used for hashing and sending): uppercase, spaces and hyphens removed, `O`→`0`, `I`/`L`→`1`; it
  must then be exactly 28 alphabet symbols, or it is not a pairing secret.
- **Stored**: only `secret_hash = sha256_hex("prism-local-agent-pairing-secret/1\n" + canonical secret)`. The plaintext
  is returned once to the owner's page and never stored. (A fast hash is sufficient for a 140-bit random secret.)
- **Lifetime**: 10 minutes (set by the database from its own clock). **Single use.** Creating a new offer cancels
  the project's earlier unused offers (one live code per project).
- The page shows the code once, with a countdown and the exact command; the code is removed from the page as soon as
  it is used, expires or is cancelled, and it is never shown again.

### 5.2 Redemption (workstation → `POST /api/local-agent/v1/pair`)

The agent generates a **new** Ed25519 key pair locally (one key per pairing), then sends (`Content-Type:
application/json`, at most 4096 bytes):

```json
{
  "protocol": "prism.local-agent.v1",
  "pairingCode": "<canonical secret>",
  "publicKey": "<SPKI base64>",
  "serverOrigin": "https://studio.example.test",
  "timestamp": 1760000000000,
  "proof": "<signature over §4.3>",
  "device": {
    "label": "Workstation",
    "platform": "win32",
    "arch": "x64",
    "agentVersion": "prism-local-agent-0.1.0"
  }
}
```

The server, in order: rejects an unknown `protocol` (`protocol_unsupported`) and any schema deviation or extra field
(`malformed_request`); canonicalises the code (`invalid_pairing` if impossible); parses the key strictly
(`malformed_request`); requires `serverOrigin` to equal its canonical origin (`NEXT_PUBLIC_SITE_URL`;
`origin_mismatch`); checks the timestamp window (§6.3; `clock_skew`); verifies the proof with the submitted key
(`invalid_signature`). Only then, in **one transaction**:

1. `select … from local_agent_pairings where secret_hash = $1 for update` (with the project's current owner);
2. no row → `invalid_pairing`; consumed → `pairing_consumed`; cancelled → `invalid_pairing`; `expires_at <= now()`
   → `pairing_expired`; the offer's creator no longer owns the project → `project_forbidden`;
3. the key's fingerprint is already registered → refused (`malformed_request`) and the offer is **not** consumed;
4. `update … set consumed_at = now()`, then insert the device bound to the offer's project and creator;
5. commit.

Two agents presenting the same code concurrently: the row lock serialises them, so exactly one succeeds and the others
get `pairing_consumed` (tested on Postgres with 8 concurrent redemptions). The unique `pairing_id` and fingerprint
constraints back this up.

Success response: `{ protocol, ok: true, serverTime, device: { id, projectId, label }, serverOrigin,
heartbeatIntervalMs }`. **Nothing else**: no token, no credential. The agent requires `serverOrigin` to equal the
origin it used, then stores its state (§11). The pairing code is never written anywhere.

Invalid codes all get the same generic `invalid_pairing` answer, which reveals nothing about any project. The
distinct `pairing_expired` and `pairing_consumed` answers are only reachable by someone who holds a valid 140-bit
secret.

## 6. Signed requests (every request after pairing)

### 6.1 Headers

| Header                    | Value               |
| ------------------------- | ------------------- |
| `X-Prism-Agent-Protocol`  | `1`                 |
| `X-Prism-Agent-Id`        | device id           |
| `X-Prism-Agent-Counter`   | counter             |
| `X-Prism-Agent-Timestamp` | timestamp           |
| `X-Prism-Agent-Signature` | signature over §4.1 |

POST bodies are `application/json`. There is no bearer token and no cookie authority. The session proxy lets
`/api/local-agent/v1/*` through untouched, and each request authenticates itself.

### 6.2 Verification and atomic anti-replay

The server validates the headers and body **before** touching the database. Missing or malformed headers give
`malformed_request` and a protocol other than `1` gives `protocol_unsupported`. For heartbeats, the body schema is also
checked first (`malformed_request`). The server then builds the canonical message from the request's own method, URL
and **received** body bytes, and in **one transaction**:

```
begin
select device (+ its project's current owner) where id = $1 for update        → none: device_unknown
verify the Ed25519 signature with the stored public key                        → invalid_signature
device revoked                                                                → device_revoked
project no longer owned by the device's creator                               → project_forbidden
|timestamp − server time| > 5 minutes                                          → clock_skew
counter <= last_counter                                                        → counter_replayed
update set last_counter = counter, last_seen_at = now() [, heartbeat fields]
commit
```

A refused request changes nothing. **Equality is refused**: a counter is accepted at most once, ever. Two concurrent
requests with the same counter are serialised by the row lock, so exactly one is accepted (tested on Postgres).

### 6.3 Timestamps

The timestamp window is ±5 minutes around the server clock. The counter is the replay control; the timestamp only
stops very stale signed messages. A `clock_skew` answer includes `serverTime` so the user can see the difference. It
does not consume the counter.

### 6.4 One request in flight; lost responses

Protocol v1 allows **one in-flight signed request per device**: the agent serialises its requests and holds a profile
lock (§11). Before signing, it **durably reserves** `lastCounter + 1` (atomic write and fsync), so a crash or restart
never reuses a counter. If a response is lost, the agent does **not** retry that signed request. The next request
simply carries the next counter. Gaps are fine because the server only requires strictly increasing counters.

### 6.5 Counter state recovery

If the agent's local state falls behind the server (a restored backup, a copied profile), its next request gets
`counter_replayed`. The agent **does not** adopt a counter suggested by the server (that would let an unauthenticated
answer steer it). It stops and asks the user to **pair again**, which creates a new device with a new key, and to
revoke the old device. Simple and secure beats clever recovery.

## 7. Endpoints

| Endpoint                             | Auth                 | Body limit | Purpose                                       |
| ------------------------------------ | -------------------- | ---------- | --------------------------------------------- |
| `POST /api/local-agent/v1/pair`      | pairing secret       | 4096 B     | redeem a code, register the public key (§5.2) |
| `POST /api/local-agent/v1/heartbeat` | signed (§6)          | 8192 B     | liveness and capability report (§9)           |
| `GET /api/local-agent/v1/status`     | signed (§6), no body | 0 B        | the device's own identity and project         |

Limits are enforced while reading: a declared `Content-Length` over the limit, or a streamed body that exceeds it,
gets `payload_too_large` (413) before parsing. When `PRISM_LOCAL_AGENTS_ENABLED` is not `1`, every endpoint answers
`not_enabled`. **There is no job, lease, source-download, result-upload or Storage endpoint in v1.**

Heartbeat body: `{ "protocol": "prism.local-agent.v1", "capabilities": { … §9 … } }`. Answer: `{ protocol, ok: true,
serverTime, device: { id, status: "active" }, acceptedCounter, heartbeatIntervalMs, jobs: [] }`. `jobs` is always
empty in v1.

Status answer: `{ protocol, ok: true, serverTime, device: { id, projectId, label, status, pairedAt, lastSeenAt },
project: { id, title }, acceptedCounter, remoteExecution: "not_available" }`.

## 8. Responses and error codes

All responses are JSON with `Cache-Control: no-store`. Success is `{ "protocol": "prism.local-agent.v1", "ok": true,
"serverTime": "<ISO>", … }`. Failure is `{ "protocol", "ok": false, "serverTime", "error": { "code", "message" } }`.
The code is the contract; the message is a fixed, safe sentence and never contains SQL, stack traces, key material or
another project's existence.

| Code                   | HTTP | Meaning                                                            | Agent action            |
| ---------------------- | ---- | ------------------------------------------------------------------ | ----------------------- |
| `invalid_pairing`      | 401  | unknown, malformed or cancelled code                               | get a new code          |
| `pairing_expired`      | 410  | the code's 10 minutes are over                                     | get a new code          |
| `pairing_consumed`     | 410  | the code was already used                                          | get a new code          |
| `invalid_signature`    | 401  | the signature or proof does not verify                             | stop                    |
| `counter_replayed`     | 409  | the counter is not above the last accepted one                     | stop; re-pair (§6.5)    |
| `clock_skew`           | 401  | timestamp outside ±5 minutes                                       | fix the clock; retry    |
| `device_revoked`       | 403  | the owner revoked this device                                      | stop permanently        |
| `device_unknown`       | 401  | no such device                                                     | stop; re-pair           |
| `protocol_unsupported` | 400  | protocol version not supported                                     | stop                    |
| `project_forbidden`    | 403  | the device's project is no longer its creator's                    | stop                    |
| `malformed_request`    | 400  | schema, header or encoding violation (or a key already registered) | stop                    |
| `origin_mismatch`      | 400  | paired with a non-canonical address                                | pair with the right URL |
| `payload_too_large`    | 413  | body over the endpoint limit                                       | stop                    |
| `not_enabled`          | 404  | local agents are switched off on this server                       | back off, retry         |

Network errors, 5xx, `clock_skew` and `not_enabled` are transient: the agent backs off exponentially, up to 5 minutes,
and every retry is a **new** signed request with a new counter.

## 9. Capabilities (heartbeat body)

The agent reports facts from the M2D.3A toolchain probe: states and versions only. The schema is strict, so an extra
field is refused.

```json
{
  "schema": "prism.local-agent-capabilities.v1",
  "agentVersion": "prism-local-agent-0.1.0",
  "protocolVersion": 1,
  "platform": "win32",
  "arch": "x64",
  "toolchain": {
    "state": "ready | colmap_missing | colmap_unverified | colmap_incompatible | brush_missing | brush_incompatible | gpu_unavailable",
    "colmap": {
      "provenance": "verified | unverified | incompatible | missing",
      "version": "4.2.1",
      "fingerprint": { "sourceCommit": "<hex>", "binarySha256": "<hex>" }
    },
    "brush": { "version": "0.3.0", "compatible": true },
    "gpu": { "vulkanLoader": true },
    "checkedAt": "<ISO>"
  },
  "engine": {
    "inputKinds": ["images"],
    "inputMimes": ["image/jpeg", "image/png"],
    "qualityProfiles": ["standard"]
  },
  "busy": false
}
```

The M2D.3A rules are unchanged: COLMAP is ready only as the verified Prism build, Brush only as 0.3.x, and a missing
Vulkan loader is not ready. The COLMAP fingerprint is sent only when verified. Version strings must match
`[0-9A-Za-z.+_-]{1,32}`. The report **never** includes an executable path, a probe reason (which can quote paths), a
home directory, a hostname, a user name, environment variables, MAC/serial/machine GUID, IP details or installed
software. `busy` is always `false` in v1. The agent re-probes at most every 5 minutes.

## 10. Heartbeat, online state, revocation

- The agent heartbeats every **10 s**. The server stores `last_seen_at`, `capabilities_json` (at most 4 KiB),
  `agent_version` and `protocol_version`. A device counts as **online** while its last accepted request is younger
  than **30 s**. Offline does not revoke anything. No file or database heartbeat crosses from the workstation; it is
  HTTPS only.
- **Revocation** (owner only, "Revoke Agent"): sets `status = 'revoked'` and `revoked_at`. It is terminal: the
  database refuses any later change to a revoked row, from the owner or the server, so it can never be reactivated.
  Every later signed request gets `device_revoked`; the agent marks its profile revoked and stops. Re-pairing creates
  a **new** device with a new key. There is **no hard delete**: revoked devices remain as history (a future job's
  provenance may name them). They disappear only when their project is deleted.

## 11. Workstation state

Profile directory: `<agent home>/profiles/<profile>/`. A device is bound to one project; pair another project with
another `--profile`. The agent home is:

- Windows: `%LOCALAPPDATA%\PrismStudio\agent`
- macOS: `~/Library/Application Support/PrismStudio/agent`
- Linux: `$XDG_CONFIG_HOME/prism-studio/agent`, otherwise `~/.config/prism-studio/agent`

`PRISM_LOCAL_AGENT_HOME` (an absolute path) overrides it. It is refused inside the Prism repository and never falls
back to a temporary directory.

| File             | Contents                                                                                                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `device-key.pem` | the Ed25519 **private** key, PKCS#8 PEM; created exclusively (never overwritten)                                                                                                                                    |
| `agent.json`     | `schema`, `protocolVersion`, `deviceId`, `projectId`, `serverOrigin`, `label`, `publicKeyFingerprint`, `privateKeyFile`, `lastCounter`, `pairedAt`, `revokedAt`. The schema is strict: no other field can be stored |
| `agent.lock`     | while a command runs: one process per profile (a stale lock from a dead process is recovered; a live holder is never killed)                                                                                        |

The config never contains a database URL, Supabase key, worker, Storage or provider key, or the pairing code. Files
are written atomically (temporary file, fsync, rename) with mode `0600` and directories `0700`. On POSIX the agent
refuses to use a key or config readable by group or others.

**Windows, stated honestly:** POSIX modes are not Windows ACLs. On Windows the files are protected only by the
inherited ACL of the per-user `%LOCALAPPDATA%` directory. That means other administrators and processes running as
the same user can read the key. Protecting it with DPAPI or an OS key store (Credential Manager, Keychain, Secret
Service) is **future packaging work**, behind the existing `AgentKeyStore` interface. `chmod 0600` is not equivalent
to DPAPI.

If the key is lost or the local counter state is unrecoverable, the recovery path is: `forget`, revoke the device in
Prism, then pair again.

## 12. Project scoping and database authority (migration 0038)

- `local_agent_pairings`: `id`, `project_id`, `created_by`, `secret_hash` (unique), `created_at`, `expires_at`
  (≤ 15 minutes; 10 minutes when created through the owner's session), `consumed_at`, `cancelled_at`. Consumed or
  cancelled happens exactly once, after which the row is immutable.
- `local_agents`: `id`, `project_id`, `created_by`, `pairing_id` (unique), `schema_version`, `protocol_version`,
  `label`, `platform`, `arch`, `agent_version`, `public_key`, `public_key_fingerprint` (unique), `status`,
  `revoked_at`, `revoked_by`, `last_counter` (never decreases), `last_seen_at`, `capabilities_json`, `created_at`,
  `updated_at`. A device can only be inserted by consuming its project's pairing offer, and it starts clean. Its
  identity columns are frozen.
- **One project per device.** Several devices per project are allowed (M2D.3C2 decides which one gets a job). There
  is no account-wide agent authority.
- **RLS** (`is_project_owner`): the owner may list the project's offers and devices, create and cancel offers, and
  rename and revoke devices. Column grants restrict the owner's session to exactly those columns: it cannot read
  `secret_hash`, cannot insert or delete devices, and cannot write a key, counter or capabilities. `anon`,
  `service_role` and the generation/continuity worker roles have **no** privilege on either table. There is no
  policy that lets a device authenticate itself, and the workstation never connects to the database.
- **Agent path**: the Prism server's route handlers use its own guarded connection for a few fixed, parameterised
  statements on these two tables and `projects` (the ownership re-check and project title), each in one transaction
  with the decisive row locked. No other table is touched, and no Supabase role is created for workstations. After
  authentication the result is an explicit `{ device, project, owner }` authority, which M2D.3C2 will use to act as
  the owner under RLS.

## 13. CLI

```
npm run local:agent -- pair   --server <origin> --code <code> [--label <name>] [--profile <name>]
npm run local:agent -- run    [--once] [--profile <name>]
npm run local:agent -- status [--profile <name>]
npm run local:agent -- forget --yes [--profile <name>]
```

- `pair` generates the key, redeems the code and pins the origin. It never prints the code.
- `run` heartbeats until Ctrl+C. It stops on a fatal code (§8) with exit 3.
- `status` shows the local facts and a signed status from Prism.
- `forget` deletes the local key and config. It does not revoke the device; revoke it in Prism.

`--fake-tools` is a test seam (`NODE_ENV=test` only).

The code appears in the command line, so it can end up in shell history. It is single-use and expires in 10 minutes,
so after pairing it is worthless.

## 14. Golden vectors

These use the RFC 8032 §7.1 TEST 1 key: seed `9d61b19d…7f60`, public key `d75a9801…511a`.

- Public key (SPKI base64): `MCowBQYDK2VwAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=`
- Fingerprint: `06e3fd8fda29bb60ab59557de61edb0aecdb231134be30e75b455f8e1b792fa9`
- Signed request message (device `0b5c2f1e-8d3a-4c6b-9e7f-1a2b3c4d5e6f`, counter 42, timestamp 1760000000000, `POST
/api/local-agent/v1/heartbeat`, empty body):

  ```
  prism-local-agent-request/1\n0b5c2f1e-8d3a-4c6b-9e7f-1a2b3c4d5e6f\n42\n1760000000000\nPOST\n/api/local-agent/v1/heartbeat\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
  ```

  Signature: `Bt75Omih0oiLPHz7cK-scA5ka8HfQY1-nrqZ1IDLHB9Gkd-v2tn67R9CVSYBki9cYE89OKkKS3uPxZQNK2-6BA`

- Pairing secret `0123456789ABCDEFGHJKMNPQRSTV` → hash
  `b990bf891b366d1f1a368fd8e81d24e53f8146713c8b85a56da919e81fbb6cc3`
- Pairing proof for origin `https://studio.example.test`, the hash and fingerprint above, timestamp
  1760000000000: `_W7uVrJ60OBJ9phc7M53DydNoEFies50XocQye86s0hzxQr1GvMpEdmyYUTeTQwidQ57rhJPwvcQ5e8haEwhCQ`

The tests also assert that changing the method, path, query, body, timestamp, counter or device id invalidates the
signature, and that a wrong key, a truncated or non-canonical signature, or a non-Ed25519 key never verifies.

## 15. M2D.3C1 limitations and the M2D.3C2 boundary

- **No remote execution.** A paired, online agent runs nothing. Local Capture keeps its M2D.3B behaviour: it is
  available only through the same-host worker, and a remote agent being online does not change that. The UI says
  "Remote execution arrives in the next milestone".
- **0 Asset bytes, 0 signed Storage URLs, 0 upload grants** are given to an agent.
- The pairing endpoint relies on 140-bit entropy rather than rate limiting. A per-IP rate limit is a reasonable
  addition at deployment.
- There is no per-project cap on the number of devices.
- Windows private-key protection is limited to the per-user directory ACL (§11).
- **M2D.3C2** will add: a scoped job lease to one chosen agent → ephemeral, per-job source transfer → the M2D.3A
  reconstruction on the workstation → signed progress and cancel → result upload → **server-side** M2D.2 ingestion.
  Each will be a new signed endpoint under this protocol, with its own authority checks. The server remains the
  authority for Storage and persistence.

## 16. Privacy

Prism collects only what the protocol needs: an opaque device id, the public key, a user-chosen label (default
`Workstation (<platform>)`, never the hostname), platform and architecture, the agent and protocol versions, the
capability facts in §9 and timestamps. It does not collect MAC addresses, serial numbers, machine GUIDs, hostnames,
user names, IP addresses beyond ordinary request logs, installed software or filesystem contents.
