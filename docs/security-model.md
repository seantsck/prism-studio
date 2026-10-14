# Security model

Scope: supabase mode. Memory mode is a single-user demo with no accounts and must not be exposed publicly.

## Trust boundaries

```
Browser ──(cookies: Supabase session)──► Next.js server ──(privileged pg pool)──► Postgres (RLS) / Storage
   untrusted                              trusted code                             authority for ownership
```

| Actor / input                                                       | Trust                                                                                                  |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Browser input (forms, files, ids, `?next=`, filenames, `file.type`) | Untrusted. Validated server-side.                                                                      |
| Session cookie                                                      | Not trusted raw; the JWT is verified with `auth.getClaims()` before `sub` is used.                     |
| Next.js server                                                      | Trusted code holding a privileged DB connection. Identity is imposed on each transaction (below).      |
| Postgres RLS + Storage RLS                                          | The enforcement authority for who can read or write which rows and objects.                            |
| Scripts (`scripts/`)                                                | Operator tools using the privileged connection and an explicit owner id; never reachable from the app. |

## What RLS enforces

- Ownership is `projects.user_id`. Every project table has RLS enabled with a `for all to authenticated`
  policy using `is_project_owner(project_id)` (a `security definer` function comparing `projects.user_id` with
  `auth.uid()`); join tables authorise through their parent shot or scene. `projects` uses `user_id = auth.uid()`.
- `storage.objects` for bucket `prism-assets`: four policies keyed on `is_project_owner` of the first path
  segment ([storage](storage.md)). The bucket is private; no `anon`/`public` policy touches it.
- The app reaches RLS by running every transaction as role `authenticated` with the verified claims
  (`rlsPreamble`, [persistence](persistence.md)). `anon` has no policies.
- Verified by `db:validate` (structure), `db:behavior` (invariants) and `db:rls` (stranger reads and writes
  denied on every table, repository level and raw SQL).

## What the application additionally checks

| Check                                 | Where                                                                                                                                        |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `assertOwns(projectId)` before writes | `PostgresRepositoryBase` (defence in depth; also yields a clean error)                                                                       |
| Session required                      | `getRepo()` → `requireUser()`; `/api/*` returns 401; proxy redirects pages to `/login`                                                       |
| Id/slug shape on routes               | `/api/assets/[id]` requires a UUID; package route requires slug regex + UUID                                                                 |
| Not-found vs forbidden                | Rows not visible to the caller are a plain 404; existence is not revealed                                                                    |
| Open-redirect guard                   | `?next=` accepted only as same-site absolute path (`signIn`, `/login`, proxy)                                                                |
| Upload policy                         | Magic-byte sniffing, extension block-list, per-kind size limits, MIME-family spoof check                                                     |
| Object-key construction               | `buildObjectPath` (UUID components, sanitised filename), `assertPathInProject`; local disk rejects escapes                                   |
| Project-ref guard                     | `getPool()` and `supabasePublicConfig()` refuse any URL without the dedicated ref                                                            |
| Error hygiene                         | `UserFacingError` shown verbatim; unexpected errors logged with a reference id, generic message to user; sign-in messages fixed              |
| Secrets                               | No service-role key used; `SUPABASE_DB_URL` is server-only; scripts redact secrets; a test asserts no source file reads a service/secret key |
| Dev user isolation                    | App never reads `PRISM_STUDIO_DEV_USER_ID` (test-enforced)                                                                                   |

## HTTP hardening (`next.config.ts`)

All routes send `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), geolocation=(), microphone=(self)`.
Asset responses add `nosniff`, a safe `Content-Disposition` (inline only for image/audio/video/pdf), and
`cache-control: private` (`no-store` for redirects and package exports).

## Limits

| Limit               | Value                                                     |
| ------------------- | --------------------------------------------------------- |
| Upload size         | image 25 MB, audio 50 MB, video 50 MB, document 10 MB     |
| Server action body  | 55 MB (`experimental.serverActions.bodySizeLimit`)        |
| Bucket              | 50 MB per object, MIME allow-list                         |
| Signed URL lifetime | 300 s                                                     |
| DB pool             | max 10 connections; project load uses up to 5 in parallel |

## Generation and outputs

| Threat                                                | Control                                                                                                                                                                                        |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider credential leaks to browser / snapshot / log | Credentials only in the server/worker environment; `ModelAvailability` carries missing-config **names**; snapshots hold the normalized request only; log fields are allow-listed               |
| Output URL points inside our network (SSRF)           | Adapter-returned URLs only; https; host allow-list per adapter; IP classification at **connect time** (DNS-rebinding safe); bounded redirects re-validated per hop; byte cap; timeout          |
| Hostile / mislabelled output                          | Magic-byte sniffing through the shared upload policy, size caps, extension block-list, declared-kind must match; inspected metadata wins over provider claims; partial ingests are rolled back |
| Another user's job or output                          | RLS on jobs/events/outputs/costs through the project; composite same-project foreign keys; worker acts only on already-queued jobs                                                             |
| Double submit / runaway spend                         | Idempotency key per (shot, attempt, package, model), one active job per shot/attempt, per-project active cap, per-user submit rate                                                             |
| Replayed / forged webhooks                            | No endpoint exists until a provider needs one; contract requires signature verification before parsing and idempotency on the event id                                                         |
| Worker storage credential                             | See below                                                                                                                                                                                      |

**Worker storage credential.** A worker has no browser session, so writing to the private bucket needs a server
credential. The production worker uses `PRISM_STUDIO_WORKER_SERVICE_KEY`, which exists **only** in the worker's
environment (never the Next.js app, never the browser, never the database, never a snapshot). For local
development the worker can instead sign in as the project owner with the test credentials so Storage RLS itself
authorises the upload; that path is refused in production builds. Until the production key is provisioned the
worker refuses to start against Supabase rather than falling back to anything weaker.

## Residual risks and gaps

These are known and unmitigated unless noted.

1. **Privileged connection, per-transaction drop.** The pool connects with a privileged role; safety depends
   on `rlsPreamble` running at the start of every user transaction. A bug that skips or mis-builds the preamble
   would bypass RLS. Mitigations: one `tx()` choke point, UUID validation of `sub`, `assertOwns`, `db:rls`
   coverage of the exact preamble. There is no separate low-privilege database role for the app.
2. **Database TLS is not verified.** The pool uses `ssl: { rejectUnauthorized: false }` (as do the scripts):
   traffic is encrypted but the server certificate is not validated.
3. **Limited rate limiting.** Generation submission is throttled (per user per minute, active jobs per project); uploads, exports and other server actions are still unthrottled beyond Supabase Auth's limits.
4. **Signed URLs are bearer links** valid for 5 minutes; anyone holding one can read that object until it expires.
5. **Local-disk storage is dev-only.** It lives in the app's working directory, is not access-scoped beyond
   the repository check, and must not be used in a deployed environment.
6. **No malware scanning.** Content is type-checked by magic bytes, not scanned; files are never executed or
   rendered as HTML by the app, and active types (html, svg, xml, scripts) are blocked.
7. **No Content-Security-Policy yet.** Only the headers listed above are set.
8. **Single-owner model.** There is no sharing, roles, teams or audit log; a compromised account exposes
   everything that user owns.
9. **Account lifecycle is outside the app.** No sign-up, reset, MFA enforcement or session listing UI.
10. **Best-effort object cleanup.** A failed storage delete or a crash between `put` and the row insert can
    leave an unreferenced object in the bucket.
11. **Browser-supplied duration hint** is stored but never trusted; server metadata wins ([asset-lifecycle](asset-lifecycle.md)).
12. **Storage policy tested at SQL level.** See Known gaps in the [roadmap](roadmap.md).
13. **Migration history before checksums** (0001–0005) is baselined, not proven ([migration-policy](migration-policy.md)).
14. **Worker holds a storage-write key** (production) with project-wide Storage access; scope it to the worker host and rotate it.
15. **Output downloads rely on provider hosts' TLS and the allow-list**; a compromised provider CDN host on the allow-list can serve hostile bytes (validated by type/size, never executed).
16. **Provider-side idempotency** is only as good as the provider: a crash between "provider accepted" and "Prism recorded it" can, for providers without idempotency keys, produce a second paid generation.
17. **Media processing runs untrusted bytes through ffmpeg** in the app server. Mitigated by magic-byte
    allow-listing + forced demuxer (no HLS/concat/SDP), `-protocol_whitelist file`, no shell, size/pixel/duration
    limits, hard timeouts, private temp directories and a credential-free child environment
    ([media-processing](media-processing.md)). A codec/decoder vulnerability in ffmpeg itself is out of scope:
    keep ffmpeg patched and consider a separate low-privilege processing host for hostile-input deployments.
18. **QA rows are owner-scoped like everything else** (RLS on `asset_derivations`, `attempt_deliveries`,
    `continuity_*`); the generation worker role has no privileges on them (`db:media-qa`, `db:worker-role`).
19. **A second least-privilege role exists** (`prism_continuity_worker`, migrations 0022–0024): no access to
    creative content, overrides, approvals or generation tables; reads only assets named by an active frozen job;
    writes execution state, normalized findings and the final cost. Proven with its real login
    (`db:continuity-analysis`: 78 checks). It uses the same project-wide worker Storage secret as the generation
    worker for READ access to the private bucket (residual risk; scope it to the worker host).
20. **External analysis sends private media to a third party** (Gemini or OpenAI) when explicitly enabled and acknowledged:
    bounded copies of references/output frames and the production criteria text. The manifest records what was
    sent; nothing is made public; provider-side files (direct video) are deleted best-effort and expire after 48 h.
    Prompt-injection controls: static system instruction, production text only as clearly bounded DATA, text inside
    media declared untrusted, strict schema validation, no provider-supplied severity/approval.
21. **A paid analysis can be ambiguous** (timeout after the request left): Gemini documents no idempotency key
    and OpenAI's Responses `create` documents no de-duplication guarantee, so Prism records `outcome_unknown` and
    never re-sends automatically; the user can start a new analysis.
22. **Analysis credentials**: `GEMINI_API_KEY` and `OPENAI_API_KEY` are server/worker only, redacted from logs
    (by value and, for `sk-…`, by shape), absent from jobs, manifests, snapshots and the browser bundle (tests); a
    key alone never enables a provider or spend. OpenAI images travel inline as bounded base64 (no public URL, no
    Files API object) and responses are requested with `store: false`. A second provider adds no database role,
    column or privilege: `prism_continuity_worker` claims jobs of any provider.
23. **`PRISM_STUDIO_ANALYSIS_TRANSPORT=fake`** swaps in deterministic in-memory transports for the acceptance
    E2E. It is honoured only in memory-persistence mode (the local demo) and cannot spend or reach a network.

## Phase 2E: candidate sets and human review

24. **Human decisions are user-domain only.** `generation_candidate_sets`, `_members`, `_events` and
    `generation_reviews` (migrations 0026–0027) have owner-only RLS and **no grant** to `prism_generation_worker` or
    `prism_continuity_worker`; a provider, worker or analyzer can never write a review, a rejection reason, a winner
    or a promotion (`npm run db:candidates` asserts permission-denied as each role).
25. **Reviews and set events are append-only**; a set's identity and frozen package are immutable; a preferred or
    promoted attempt must be a member of the set and promotion needs a succeeded attempt (triggers, tested with raw
    SQL). The only permitted row update is the FK action that clears `candidate_set_id` when a set is deleted.
26. **Candidate-set spend is server-gated.** `PRISM_STUDIO_MAX_CANDIDATE_SET_USD` (unset ⇒ paid sets blocked) and
    `PRISM_STUDIO_MAX_CANDIDATES_PER_SET` come from the server environment; the client's displayed total is only a
    confirmation that the server recomputes and must match. The per-generation gate still applies to every candidate.
    No automatic or scheduled paid benchmarking exists.
27. **No cross-user learning.** Recommendations use the signed-in user's project history only.
28. **Benchmark classification is explicit and owner-set.** `projects.purpose` (production | benchmark | test; 0029) is never derived from a slug or
    title; the migration reclassifies nothing. Benchmark projects keep full review/winner/cost behaviour (so tooling
    can be tested) but their records never feed production aggregates or routing, and the UI labels them. Workers
    have no write path to the flag (no grant on the projects table beyond what they already lacked).
29. **A human review needs a clip.** The application, both repositories and a DB trigger (0028) refuse a review for an
    attempt that is not `succeeded`, so a failed generation can never accumulate fabricated quality signal.
