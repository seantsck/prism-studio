# Deployment status and hosting architecture

## Status

**Phase-2 Alpha functionally accepted; remote deployment architecture deferred.**

The absence of a remote deployment is an infrastructure/hosting decision, not an unresolved Phase-2 application
correctness gate. Prism Studio has never been served from a remote host, and `studio.prismsuite.io` is not configured.

| Acceptance               | Result                                                               |
| ------------------------ | -------------------------------------------------------------------- |
| Phase-2 Alpha functional | **PASS**                                                             |
| Remote deployment        | **DEFERRED**                                                         |
| Source (`main`)          | `fbd1beb49b1551d424b3b91a94bf83f370f320b6` (Phase 2I merged, PR #24) |
| Migration head           | `0043`                                                               |

### Functional acceptance evidence

Recorded in [timeline-performance-assembly §8](timeline-performance-assembly.md#8-phase-2i-acceptance-2i1f):

- full unit suite 1705/1705; full memory E2E 158/158;
- hosted Supabase Episode Edit browser E2E 8/8, with hosted cleanup exact;
- `db:episode-edits` 94/94, `db:generation` 71/71, `db:behavior` 49/49, `db:validate` STRUCTURE OK, migration
  checksums OK;
- typecheck, lint, format and production build pass;
- real Supabase Auth, Postgres with RLS and private Storage exercised; real PNG / WebM / WAV delivery, persisted
  editing, a real revision conflict and rough-cut playback exercised;
- provider calls 0, paid calls 0.

The hosted E2E ran the **production Next.js build locally** against the real hosted Supabase backend. That proves the
application; it does not prove a hosting platform.

### Known Phase-2 limitations

No J/L cuts, no transitions or effects, no multitrack music / ambience, no mixer, no captions, no NLE export, no final
render, no alternate cuts or intercut reuse, no undo, no professional frame-accurate playback guarantee. See
[timeline-performance-assembly §8](timeline-performance-assembly.md#8-phase-2i-acceptance-2i1f) and the
[roadmap](roadmap.md).

## Vercel Preview experiment (closed, 2026-10-26)

No deployment architecture had been defined ([reconstruction-acceptance](reconstruction-acceptance.md#deployment-target)).
An attempt was made to establish a protected Vercel **Preview** of `fbd1beb` as the Alpha remote acceptance. It was
stopped by its own target safety gate and closed without a retry.

- Project `prism-studio` (`prj_OZHYE5dSHdieZ6TaN5H16JGY6jA8`), team Prism's projects (`prism-s-projects3`); CLI
  upload, no Git integration.
- `dpl_6tJgBAzqYVL6tCQrrAHXNpE9mBfx`: `vercel deploy --target preview`; the API recorded **`target: production`**;
  build `ERROR`; never aliased or served; deleted.
- `dpl_APgfiyvgUNUreqoSmqfNreGJajA9`: `vercel deploy` with no `--target` and no `--prod`; the API again recorded
  **`target: production`**; cancelled while building; never aliased or served; deleted.

Neither record is a release. No production application became reachable, no Supabase Auth setting changed, no hosted
data was created, no migration was applied and no provider was called.

**Close-out state of the dormant project (verified 2026-10-27):** framework `nextjs`; 0 deployments; no production
deployment pointer; not live; no custom domain (only the auto-assigned `*.vercel.app` name, which returns 404); no Git
integration; Deployment Protection (Vercel Authentication, all except custom domains) still enabled; 0 environment
variables in Preview, Production and Development (the Preview Supabase URL, publishable key, `SUPABASE_DB_URL` and
persistence mode were removed); the acceptance automation-bypass secret revoked (0 bypasses). The project is kept,
empty, for the architecture decision below; it is not a chosen platform.

## Infrastructure decision item: Prism Studio Hosting Architecture

**Open. Not chosen, not implemented.** Remote deployment waits on this decision.

It must cover at least:

- web / control-plane hosting;
- direct large-media uploads (browser → Supabase private Storage, not through the web tier);
- Supabase and private Storage access;
- upload and relay bodies around 55 MB and beyond
  ([reconstruction-acceptance](reconstruction-acceptance.md#deployment-target));
- long-running generation work and the generation workers;
- reconstruction / GPU workers;
- WebSocket or other long-lived connections where required;
- preview / staging environment strategy;
- production environment strategy;
- secrets and database least privilege, including **whether server web requests should hold the current privileged
  `SUPABASE_DB_URL`** at all ([security-model](security-model.md));
- deployment rollback;
- monitoring and logging (including the lease-path redaction gate);
- `studio.prismsuite.io` ([auth](auth.md)).

Candidates to compare:

- Vercel web / control plane + direct Storage uploads + separate workers;
- container / PaaS web application + workers;
- VPS / container infrastructure;
- a hybrid of the above.

A Vercel-based candidate must first explain and resolve why CLI Preview uploads to this project were recorded as
Production targets.
