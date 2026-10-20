# Prism Local Agent protocol v1 (M2D.3C1 + M2D.3C2)

A **remote Local Agent** is a small program on a user's own workstation that will run local reconstructions for a
hosted Prism Studio (`hosted Prism → the user's workstation → local compute`). This document is the complete v1 wire
contract: another implementation can reproduce it from here. The executable form is `src/lib/local-agent/protocol.ts`
and `src/lib/local-agent/crypto.ts`; the golden vectors in §14 are asserted by
`src/lib/local-agent/__tests__/crypto.test.ts`.

**M2D.3C1** is the identity and control plane: pairing, device identity, signed requests with replay protection,
heartbeat, capability reporting, revocation and the owner's management UI (§1–§16). **M2D.3C2** adds remote
reconstruction jobs on new signed routes of the same protocol (§17–§23): a project-scoped job lease, the exact frozen
source photographs over a Prism route, the M2D.3A engine on the workstation, signed progress/keepalive and
cancellation, one validated SPZ result upload, and server-side M2D.2 ingestion. The workstation still receives no
Storage grant, no signed Storage URL and no credential of any kind; the M2D.3C1 messages are unchanged, so a C1 agent
keeps working (it simply never leases).

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
   3986 unreserved characters (`A-Z a-z 0-9 - . _ ~`) or `%XX` with **uppercase** hex of a byte that is NOT unreserved
   (`%2F` is a literal byte inside one segment, never a `/`; `%41` is refused because `A` is its only spelling). A
   non-canonical path is **refused** (`malformed_request`), never normalised.
2. **Query**: parse the query as `application/x-www-form-urlencoded` (so `+` and `%20` are both a space, exactly as the
   handler will read them), percent-decode each key and value, re-encode each as UTF-8 with every byte outside the
   unreserved set as `%XX` (uppercase), sort the pairs by encoded key (byte order), and join as `k=v` with `&`. A key
   that appears **more than once** is refused (`malformed_request`): its meaning would depend on which value a
   handler reads. Keys are case-sensitive.
3. The target is the path, followed by `?` and the query **only** if there is at least one pair.

Example: `/x?b=2&a=1&q=a+b` → `/x?a=1&b=2&q=a%20b`; `/x?a=1&a=0` → refused.

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

Every header has a fixed grammar with a bounded length (§3): id 36 chars, counter at most 16 digits with no leading
zero and at most 2^53−1 (larger is refused, never rounded), timestamp at most 16 digits, signature exactly 86 chars. A
header sent twice reaches the handler comma-joined (Fetch `Headers`) and therefore fails its grammar: duplicates are
refused, never resolved to one of the values.

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

The signature is checked before the revoked, ownership, clock and counter checks so that nothing about a device's
state is revealed to a caller who cannot sign for it. Every check runs under the same row lock before the single
`update`, so the order is transactionally equivalent to "lock → exists → revoked → project → clock → signature →
counter → advance → commit". No authenticated side effect (heartbeat fields, last seen) is written except in that
same `update` after every check passed.

**Racing higher counters** are serialised by the row lock in the order the database grants it. Each accepted
counter is strictly greater than every counter accepted before it; a request whose counter is not greater than the
committed `last_counter` when it acquires the lock is refused `counter_replayed`. An older request can therefore never
be accepted after a newer one commits. (The agent sends one request at a time, §6.4, so it never races itself.)

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

M2D.3C2 job routes (all signed, §6; `{job}` is the job UUID, `{lease}` the 32-hex lease id, both part of the signed
path):

| Endpoint                                                        | Body limit                        | Purpose                                   |
| --------------------------------------------------------------- | --------------------------------- | ----------------------------------------- |
| `POST /api/local-agent/v1/jobs/lease`                           | 1024 B                            | own live lease, or claim one (§17)        |
| `GET /api/local-agent/v1/jobs/{job}/leases/{lease}/sources/{n}` | 0 B (response: the frozen size)   | one source photograph (§18)               |
| `POST /api/local-agent/v1/jobs/{job}/leases/{lease}/progress`   | 16 KiB                            | keepalive, progress, final metadata (§19) |
| `POST /api/local-agent/v1/jobs/{job}/leases/{lease}/fail`       | 4096 B                            | failure report (§21)                      |
| `PUT /api/local-agent/v1/jobs/{job}/leases/{lease}/result`      | exactly the declared size ≤ 50 MB | the one SPZ result (§20)                  |

Limits are enforced while reading: a declared `Content-Length` over the limit, or a streamed body that exceeds it,
gets `payload_too_large` (413) before parsing. When `PRISM_LOCAL_AGENTS_ENABLED` is not `1`, every endpoint answers
`not_enabled` before anything else. There is no Storage endpoint and no route that hands out a Storage URL.

Heartbeat body: `{ "protocol": "prism.local-agent.v1", "capabilities": { … §9 … } }`. Answer: `{ protocol, ok: true,
serverTime, device: { id, status: "active" }, acceptedCounter, heartbeatIntervalMs, jobs: [] }`. `jobs` is always
empty, also in M2D.3C2: jobs are leased on their own route, so a C1 agent never meets a job it does not understand.

Status answer: `{ protocol, ok: true, serverTime, device: { id, projectId, label, status, pairedAt, lastSeenAt },
project: { id, title }, acceptedCounter, remoteExecution }`. `remoteExecution` is `"available"` only when the device
reported that it runs remote jobs (§9) AND this server can serve them; otherwise (always, for a C1 agent)
`"not_available"`.

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
| `lease_expired`        | 410  | the lease expired; the attempt was failed (never re-leased)        | stop the run, clean up  |
| `lease_mismatch`       | 404  | this device holds no such lease (also: another project's job)      | stop the run, clean up  |
| `job_cancelled`        | 409  | the owner cancelled the job                                        | abort, upload nothing   |
| `job_not_available`    | 409  | the job is no longer running (failed, finished)                    | stop the run, clean up  |
| `source_unavailable`   | 409  | that photograph is not available (changed sources fail the job)    | stop the run, clean up  |
| `result_rejected`      | 422  | the result does not match its declaration, job or toolchain        | stop, clean up          |
| `result_pending`       | 409  | Prism is still importing this lease's result                       | ask again shortly       |

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
software. The agent re-probes at most every 5 minutes.

M2D.3C2 adds two facts, both backwards compatible (a C1 agent's report stays valid): `busy` is truthful (`true` while
the agent holds a remote job; a C1 agent always sends `false`), and an agent that leases and runs remote jobs adds
`"execution": { "remoteJobs": true }` (exactly that; nothing else is accepted). Only such an agent is counted as a
ready workstation for Remote Local Agent (§17).

## 10. Heartbeat, online state, revocation

- The agent heartbeats every **10 s**. The server stores `last_seen_at`, `capabilities_json` (at most 4 KiB),
  `agent_version` and `protocol_version`. A device counts as **online** while its last accepted request is younger
  than **30 s**. Offline does not revoke anything. A `last_seen_at` that cannot be parsed, or that lies further in the
  future than the 5-minute skew window, is shown offline (never "online forever"). No file or database heartbeat crosses from the workstation; it is
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

| File              | Contents                                                                                                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `device-key.pem`  | the Ed25519 **private** key, PKCS#8 PEM; created exclusively (never overwritten)                                                                                                                                                                  |
| `agent.json`      | `schema`, `protocolVersion`, `deviceId`, `projectId`, `serverOrigin`, `label`, `publicKeyFingerprint`, `privateKeyFile`, `lastCounter`, `pairedAt`, `revokedAt`. The schema is strict: no other field can be stored                               |
| `agent.lock`      | while a command runs: one process per profile (a stale lock from a dead process is recovered; a live holder is never killed)                                                                                                                      |
| `active-job.json` | (M2D.3C2) the ONE active remote job: device, project, job, attempt, lease id and expiry, the frozen source sizes and checksums, the run id, the stage reached, and the validated result's metadata. Strict schema; no credential, content or path |

Run workspaces live beside the profiles, at `<agent home>/work/<profile>/<run id>` (never inside the repository).

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
  authentication the result is an explicit `{ device, project, owner }` authority, which the M2D.3C2 job routes use
  to act as the owner under RLS (§23).

## 13. CLI

```
npm run local:agent -- pair   --server <origin> --code <code> [--label <name>] [--profile <name>]
npm run local:agent -- run    [--once] [--max-jobs <n>] [--profile <name>]
npm run local:agent -- status [--profile <name>]
npm run local:agent -- forget --yes [--profile <name>]
```

- `pair` generates the key, redeems the code and pins the origin. It never prints the code.
- `run` heartbeats until Ctrl+C and, when idle with a ready toolchain, leases and runs this project's Remote Local
  Agent jobs one at a time (§17–§22). It stops on a fatal code (§8) with exit 3. `run --once` is a single heartbeat
  (no job); `--max-jobs <n>` exits after n jobs reached an outcome. Ctrl+C stops the tools, reports the attempt
  failed (Retry creates a new one) and cleans up.
- `status` shows the local facts, a signed status from Prism and the active job, if any.
- `forget` deletes the local key, config and active-job state. It does not revoke the device; revoke it in Prism.

Test seams, all refused unless `NODE_ENV=test`: `--fake-tools` (the M2D.3A fake COLMAP/Brush), `--poll-ms` (a faster
idle poll) and `PRISM_AGENT_TEST_CRASH_BEFORE_UPLOAD=1` (exit right before the upload, to prove the restart path).

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

## 15. Limitations

- **Local Capture is unchanged.** `local_capture` means the trusted same-host worker (M2D.3B) only; a remote agent
  never claims it. Remote execution is the separate provider `local_agent_capture` (§17).
- **0 signed Storage URLs and 0 Storage grants** are given to an agent. Photographs travel through the signed Prism
  route (§18); the result travels through the signed upload route (§20).
- **No real-tool acceptance yet.** Automated tests run the M2D.3A fakes. The first real COLMAP/Brush reconstruction on
  supported hardware is a separate acceptance gate.
- **No application-level rate limit.** The 140-bit pairing secret makes guessing impractical (2^140 candidates), so
  rate limiting is not what keeps pairing secure. The pair endpoint is nevertheless unauthenticated and does an
  Ed25519 verification and a database lookup per request, so a production deployment **must** put ingress or edge
  rate limiting in front of `/api/local-agent/v1/*` (per client IP) for abuse and DoS resistance before the feature
  is broadly exposed. Prism does not currently provide that coverage itself; an in-process limiter was deliberately
  not added (it would not hold across instances).
- There is no per-project cap on the number of devices.
- Windows private-key protection is limited to the per-user directory ACL (§11).
- The job routes are authenticated but expensive (a source response or a result import can be tens of MB): besides
  the deterministic guards (§17–§20: body limits, one live lease per device, one result per job, bounded progress
  writes, strict ordinals, the pre-body upload gate), production ingress rate limiting is still required.
- No per-device routing: any ready workstation of the project may take the oldest queued job.
- **A single source download longer than the lease can lose it.** The client serialises its signed requests (the
  server accepts only strictly increasing counters), so no keepalive is sent while one photograph is downloading. A
  photograph whose transfer takes longer than the remaining lease (120 s minus the safety margin) makes the agent
  stop and the attempt fail; Retry creates a new one. Per-image size is capped at 64 MB. Concurrent keepalives were
  deliberately not added for V1.
- **Result upload memory**: bounded but memory-heavy (§20): up to about twice the declared result size per accepted
  upload, at most ~100 MB.

## 16. Privacy

Prism collects only what the protocol needs: an opaque device id, the public key, a user-chosen label (default
`Workstation (<platform>)`, never the hostname), platform and architecture, the agent and protocol versions, the
capability facts in §9 and timestamps. It does not collect MAC addresses, serial numbers, machine GUIDs, hostnames,
user names, IP addresses beyond ordinary request logs, installed software or filesystem contents.

## 17. Remote reconstruction jobs: the provider and the lease (M2D.3C2)

**Provider.** `local_agent_capture` ("Remote Local Agent · Free · paired workstation") is a separate provider from
`local_capture` ("Local Capture", the trusted same-host worker). Capabilities: `capability: local_capture`,
`execution: local`, `runner: remote_agent`, `cost: free`, multi-image JPEG/PNG only (3–300), Gaussian splat results,
the `standard` profile only, no models, cancel/progress/resume supported. No video, no FFmpeg. The two runners can
never race for a job: the same-host worker discovers only `local_capture`, the lease route only `local_agent_capture`.
A web request never executes either (`runner !== provider_api` → the web side only reads the job).

**Availability is per project.** It is listed only where `PRISM_LOCAL_AGENTS_ENABLED=1`, and usable only when this
server can serve remote jobs (reconstruction jobs on; in Supabase mode the agent-relay Storage key, §23) and at least
one ACTIVE device of THE JOB'S PROJECT is online, reports a ready toolchain, speaks this protocol version, supports
images and the standard profile, and reported `execution.remoteJobs`. Busy devices still count (jobs queue behind
them). It is computed per request from the owner's own devices, never cached across projects. Default selection is
free-first: Local Capture if ready, else Remote Local Agent if ready, else nothing; World Labs is never selected
automatically and nothing falls back to it.

**Lease request** (`POST /jobs/lease`, body `{ "protocol" }`). After authentication, the server, for the device's own
project only:

1. reaps the project's in-flight remote jobs whose lease has expired (§22);
2. if THIS device already holds a live lease, returns that same lease (`resumed: true`) and renews it: a lost response
   never makes a device run two jobs, and a device never holds two;
3. otherwise, if the device can execute (above), takes the oldest queued `local_agent_capture` job of its project and
   claims it with compare-and-set: `queued → submitting → running` (two writes, because the job state machine has no
   `queued → running` edge). The FIRST write already freezes the whole remote authority (runner, device, opaque lease,
   expiry, recorded toolchain), so a crash between the two leaves a `submitting` job that no other device can take
   while its lease lives; the same device's next lease request resumes it, otherwise it is failed `provider_timeout`
   once the lease expires (by the next lease request or the owner's panel refresh) and never re-run. Exactly one device
   wins a race; a loser gets the next job or none. A job whose frozen sources cannot run remotely (count, kind, type, missing checksum or size, over 64 MB) is
   failed `invalid_sources` instead.

The job is `running` at once: the lease is the execution authority, and the owner can cancel immediately. Events
`submitted` and `provider_running` are recorded.

Answer: `{ protocol, ok: true, serverTime, lease, idle }` where `idle` is `no_job`, `toolchain_not_ready` or
`remote_jobs_unavailable` when `lease` is null, and:

```
lease = { jobId, attempt, leaseId, leaseExpiresAt, leaseTtlMs, resumed, quality: "standard",
          sources: [ { ordinal, assetId, mime, byteSize, sha256, path } ] }   // in the job's order
```

Nothing else: no bucket, object path, Storage or signed URL, Supabase URL, file name or credential. The agent
fetches only the source paths it can construct itself for that lease and refuses a lease naming any other.

**The lease lives in the job row** (no table, no migration): `provider_operation_id = "agent:<lease id>"` (assigned
once per attempt) and `provider_operation_json` holds `runner: "remote_agent"`, `agentId`, `agentVersion`, `leaseId`,
`leaseExpiresAt`, `lastProgressAt`, `quality`, the toolchain recorded at lease time (`tools`: COLMAP version, approved
commit and binary sha256; Brush version), `stage`, `description` and, later, the frozen `result` metadata. The job's
revision compare-and-set is the only concurrency authority. Lease ids are 128 random bits; they are not credentials
(every request is still device-signed) and are never shown in the UI.

**TTL 120 s.** Every accepted keepalive renews it to now + 120 s. The agent measures the remaining time from each
answer on its own clock (server clocks are never compared) and stops the engine if it cannot renew before the lease
would expire (minus a safety margin).

**No automatic reassignment.** An expired lease fails the attempt (`provider_timeout`); the same attempt is never
leased to another workstation (that could run two expensive reconstructions for one attempt). Retry creates a new
attempt of the same provider, queued for a workstation.

## 18. Source transfer

`GET /jobs/{job}/leases/{lease}/sources/{n}`: the server authenticates the device, checks it holds THIS lease of THIS
job of ITS project (otherwise `lease_mismatch`, the same answer as for a job that does not exist), that the job is
running and the lease unexpired, that `n` is an ordinal of the job (grammar `0|[1-9][0-9]{0,2}`, else refused before
any lookup), and that the frozen source's Asset is still this project's image with the frozen type and checksum. It
reads the bytes server-side from private storage, re-hashes them against the frozen checksum and serves them:

- `Content-Type`: the frozen image type, `Content-Length`, `X-Prism-Source-SHA256`, `Cache-Control: no-store`,
  `X-Content-Type-Options: nosniff`, no file name.

A source that changed or cannot be read fails the job (`invalid_sources`) and answers `source_unavailable`. The agent
streams each response into `<work>/.staging/<run>/000001.jpg …` (M2D.3A naming), refusing more bytes than frozen, and
verifies the length, the checksum and the image signature; any mismatch is reported (`source_invalid`) and nothing is
run. There are no direct Storage signed URLs in V1: the workstation's whole capability surface is Prism itself.

## 19. Progress, keepalive and cancellation

`POST …/progress` with `{ protocol, stage, progress (0..1), message (≤ 300, single line), result? }`, where `stage` is
`downloading`, an M2D.3A stage (`preparing`, `camera_reconstruction`, `splat_training`, `validating_ply`,
`converting_spz`, `validating_spz`) or `uploading`. It is the keepalive: sent at least every 10 s while the agent holds
a lease (and at once on a stage change). Answer: `{ leaseExpiresAt, leaseTtlMs }`.

The `message` is for the agent's own log: the server never stores or shows it. The owner sees the SERVER's fixed
label for the reported stage (e.g. "Splat training (Brush)"), so no workstation text (paths, user or host names,
command lines) can reach Prism's database or UI.

The server renews the lease and writes progress at a bounded cadence: a stage change is written (and is a `progress`
event) at once; a same-stage update at most every 2 s (faster ones are acknowledged without a write), and always
before the lease gets close to expiring. Brush iterations are not events.

**Cancel** is the owner's (`running → cancelled`, compare-and-set; no push channel is needed). The agent's next
keepalive gets `job_cancelled`: it aborts the engine (COLMAP/Brush process trees are killed by M2D.3A), uploads
nothing and removes the photographs and intermediates (bounded logs may remain). The workstation can never forge a
cancellation (§21).

## 20. Result upload and ingestion

1. **Declare.** A final progress with `stage: "uploading"` carries the result metadata: `format: "spz"`, `sha256`,
   `byteSize` (≤ 50 MB), `gaussianCount`, `shDegree`, `inputImages` (must equal the job's), `registeredImages`,
   `registrationRatio`, `sparsePoints`, `quality`, `colmap` (version, approved commit, binary sha256), `brush`
   (version), `spzEncoder`, `spzVersion`, `lossless: false`, `clamped` counts. Strict schema: no path, host, user,
   stdout or file name. It must name the toolchain recorded at lease time (else `result_rejected`). The server freezes
   it in the lease; a later different declaration is refused.
2. **Upload.** `PUT …/result` with `Content-Type: application/x-spz` and the exact bytes; the signature covers them
   (body sha256, §4.1). Before reading anything, the server checks there is a leased remote job naming the claimed
   device and this lease, with a declared result of exactly the declared `Content-Length` (no unrelated caller can make
   it buffer 50 MB). It then reads at most that length, authenticates the request, checks the lease (an upload is
   judged by when it was SIGNED, so a long upload started under a valid lease still counts), verifies the bytes'
   length and sha256 against the declaration and validates the SPZ again (Prism's `inspectSplat`, same Gaussian count).
   A mismatch fails the job `result_invalid`.
3. **Claim and ingest.** `running → ingesting` by compare-and-set (a cancel that won is final; an import that won makes
   a later cancel impossible), the stored deadline moved to a 10-minute SERVER-SIDE import grace, then the SHARED M2D.2
   `ingestReconstructionResult`: private Asset + immutable generated reconstruction (unknown scale: COLMAP/Brush units
   are never metres) + job success, all-or-nothing, with cleanup on failure. Provenance: the declared facts, `runner:
remote_agent`, the opaque device id, a fingerprint prefix and the agent version (never a label as identity).
4. **Exactly once.** A repeated upload of an imported result returns the existing outcome; while an import is running
   another upload gets `result_pending`; concurrent uploads import once (the compare-and-set and the one-reconstruction-
   per-job invariant). The agent never creates an Asset and never touches Storage.

**The import grace is not a lease.** Once the server wins `running → ingesting`, the workstation's authority is over:
its keepalives answer `job_not_available` and renew nothing, a lease request gets no job, and only the server's own
import continues. The 10-minute deadline exists only so that an import whose server process died is eventually failed
(`provider_timeout`) instead of staying `ingesting` forever; a healthy import finishes long before it.

Memory (a bounded but memory-heavy V1 relay): a declared `Content-Length` over 50 MB is refused before anything is
read; the pre-body gate requires it to equal the frozen declaration; the body is then read in chunks with a hard cap
at that length (reading stops at the first byte over, also when the header is absent or wrong) and joined once, so an
accepted upload transiently holds up to about twice its size (≤ ~100 MB) while the shared ingestion validates and
stores whole bytes. No temporary Storage staging object exists (no second orphan class). Streaming ingestion is
future work.

## 21. Failure reports

`POST …/fail` with `{ protocol, code, stage, message }`. `code` is an M2D.3A engine code or `source_invalid` /
`interrupted`; the SERVER maps it (the workstation never chooses a status or database error code):

| Agent code                                                                                                                                                              | Job error          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `invalid_inputs`, `source_invalid`                                                                                                                                      | `invalid_sources`  |
| `timeout`                                                                                                                                                               | `provider_timeout` |
| `result_too_large`                                                                                                                                                      | `result_too_large` |
| `ply_invalid`, `spz_invalid`, `spz_conversion_failed`                                                                                                                   | `result_invalid`   |
| `ply_missing`                                                                                                                                                           | `result_missing`   |
| `toolchain_missing`, `unsupported_version`, `gpu_unavailable`, `out_of_memory`, `colmap_failed`, `brush_failed`, `workspace_failed`, `insufficient_camera_registration` | `provider_failed`  |
| `cancelled`, `interrupted` (the agent stopped on its own)                                                                                                               | `provider_failed`  |

An agent-reported `cancelled` is never a cancellation: only the owner's cancel makes a job `cancelled`. The stored and
displayed message is the SERVER's fixed sentence for the agent code (prefixed "Remote Local Agent:"; stopped runs get
a fixed sentence); the agent's `message` is never stored or shown. The provider operation keeps only the agent code
and stage (both from closed lists).

## 22. Restarts, network loss, revocation and server restarts

- **Agent restart.** The agent persists the lease (`active-job.json`) before downloading and before each step. On
  start it resolves that job FIRST (it leases nothing else while it exists): a VALIDATED result that is still retained
  (manifest identity and source checksums, the SPZ's size, sha256, validation and Gaussian count all matching the
  persisted declaration) is uploaded only, with no second COLMAP/Brush run; anything else is reported `interrupted`
  (never re-run) and Retry creates a new attempt. If Prism says the job ended meanwhile, Prism's answer wins.
- **Lost responses.** Every retry is a new signed request with a new counter. Lease: returns the same lease. Progress:
  safe to repeat. Fail: compare-and-set. Result: exactly once (§20).
- **Network loss.** The agent keeps retrying keepalives with new counters until its last renewal would expire, then
  aborts the engine, uploads nothing and cleans up. The server fails the stale attempt the next time it looks.
- **Reaping.** A `local_agent_capture` job in `submitting`/`running` (or `ingesting` past the import grace) whose stored
  lease has truly expired is failed `provider_timeout` (compare-and-set) by the next lease request in its project and
  by the owner's panel refresh. No other provider's job is ever touched.
- **Revocation** of a device fails its active remote jobs at once (`provider_failed`, "revoked"); its next request gets
  `device_revoked` and it stops. Nothing is reassigned.
- **Server restart.** Lease ownership and expiry live in the job row, so nothing is lost: the same device may continue
  an unexpired lease, an expired one is failed. There is no memory-only lease authority.

## 23. Authority and Storage (server side)

The agent never touches the database or Storage. The job routes run on the Prism server:

- **Discovery** (the server's guarded connection, fixed parameterised statements): `id, project_id, created_by, status,
created_at` of `local_agent_capture` jobs of the AUTHENTICATED device's project, and, for the pre-body upload gate,
  one job's status and provider operation. Nothing else runs with that privilege.
- **Everything else** (read and transition the job, read its frozen source Assets, store the result) runs as the
  project owner under RLS (`rlsPreamble` with the device's owner), and every job is additionally checked to belong to
  the device's project (one owner may own several projects; RLS alone would not separate them).
- **Storage** in Supabase mode uses a dedicated server-only secret key, `PRISM_STUDIO_AGENT_RELAY_SUPABASE_SECRET_KEY`,
  read only by `src/server/local-agent/relay-storage.ts` (a source test proves no other module reads it). Fail closed:
  without it, Remote Local Agent is "not configured" and nothing falls back to the worker key or a session; pairing,
  heartbeat and status keep working (status reports `remoteExecution: "not_available"`), a lease request answers
  `remote_jobs_unavailable`, the source/progress/fail routes `job_not_available` and a result upload is refused before
  its body is read. It is used
  only for the frozen sources of a job leased to an authenticated device of that project and for that job's one
  result. In memory mode the local-disk store is used. See [security-model.md](security-model.md).
