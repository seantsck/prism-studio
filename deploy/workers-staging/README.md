# prism-studio-workers-staging (Vercel project)

Staging daemons only (Phase 5A.2), against the DEV/staging Supabase project. **No web app**: the build is a no-op and
the output is one static placeholder page, so no request handler ever exists where the worker credentials live.

- Daemon `generation`: `Dockerfile.generation-worker`, 1 GiB, `iad1`, liveness `GET /healthz` on 8080, 120 s grace.
- Declared instances are **0**. Scale up only for acceptance tests, then back down:
  `vercel daemons scale generation iad1=1` ... `vercel daemons scale generation iad1=0` (CLI ≥ 64.3).
- Deploy from a CLEAN clone of a reviewed commit with this file copied to the clone's root as `vercel.json`
  (the web project `prism-studio` never sees a `daemons` block).
- Production environment variables (names only): `PRISM_STUDIO_WORKER_DB_URL`, `PRISM_STUDIO_WORKER_SUPABASE_SECRET_KEY`,
  `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_PRISM_STUDIO_ENVIRONMENT=staging`, `PRISM_STUDIO_GENERATION_PROVIDERS=mock`,
  `PRISM_STUDIO_ENABLE_MOCK_PROVIDER=1`, `PRISM_STUDIO_ALLOW_PAID_GENERATION=false`, `PRISM_STUDIO_WORKER_HEALTH_PORT=8080`.
  No provider keys on staging.
