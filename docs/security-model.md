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

## Residual risks and gaps

These are known and unmitigated unless noted.

1. **Privileged connection, per-transaction drop.** The pool connects with a privileged role; safety depends
   on `rlsPreamble` running at the start of every user transaction. A bug that skips or mis-builds the preamble
   would bypass RLS. Mitigations: one `tx()` choke point, UUID validation of `sub`, `assertOwns`, `db:rls`
   coverage of the exact preamble. There is no separate low-privilege database role for the app.
2. **Database TLS is not verified.** The pool uses `ssl: { rejectUnauthorized: false }` (as do the scripts):
   traffic is encrypted but the server certificate is not validated.
3. **No rate limiting** beyond Supabase Auth's own limits. Uploads, exports and server actions are unthrottled.
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
