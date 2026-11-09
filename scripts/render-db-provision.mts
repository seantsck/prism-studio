// Provisions the LOGIN credential of the render worker's least-privilege database role (Phase 5B closeout).
//
//   PRISM_STUDIO_RENDER_DB_PASSWORD=<new secret> npm run render:db:provision
//   PRISM_STUDIO_RENDER_DB_PASSWORD=<new secret> npm run render:db:provision -- --rotate
//
// Migration 0059 creates `prism_render_worker` NOLOGIN with no password. This script is the ONLY place a secret is
// attached to it, and the secret comes from the environment: never in a migration, never committed, never printed.
// Idempotent: an existing login is NOT replaced unless --rotate is passed. Then it audits the role's privileges.
// Independent of the generation, continuity and Story worker roles. The resulting URL belongs on the render worker host only
// (PRISM_STUDIO_RENDER_WORKER_DB_URL), never in the web app and never in a NEXT_PUBLIC_* variable.
import pg from "pg";
import { disposableLocalTarget, redact, resolveTarget, safeTarget, startScript } from "./lib/safety.mjs";
import {
  auditRenderWorkerRole,
  ProvisionRefused,
  provisionRenderWorkerLogin,
  RENDER_WORKER_CONNECTION_LIMIT,
  RENDER_WORKER_ROLE,
} from "./lib/render-worker-role";

const rotate = process.argv.includes("--rotate");
const url = startScript({
  productionSafe: true,
  mode: `provision ${RENDER_WORKER_ROLE} login${rotate ? " (rotate)" : ""}`,
});
const password = process.env.PRISM_STUDIO_RENDER_DB_PASSWORD ?? "";

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  const outcome = await provisionRenderWorkerLogin(client, password, { rotate });
  console.log(
    outcome === "unchanged"
      ? `${RENDER_WORKER_ROLE} already has LOGIN enabled. No change made (pass --rotate to replace its password).`
      : `${RENDER_WORKER_ROLE}: LOGIN ${outcome === "rotated" ? "password rotated" : "enabled"} (connection limit ${RENDER_WORKER_CONNECTION_LIMIT}).`,
  );
  const audit = await auditRenderWorkerRole(client);
  if (audit.failures.length) {
    console.error(`Privilege audit FAILED: ${audit.failures.join("; ")}`);
    process.exitCode = 1;
  } else
    console.log(
      "Privilege audit: minimal (renders, the segment cache and the final render Asset of active renders only).",
    );
  if (disposableLocalTarget(url))
    console.log(
      `Disposable target ${safeTarget(url)}: PRISM_STUDIO_RENDER_WORKER_DB_URL=postgresql://${RENDER_WORKER_ROLE}:<password>@127.0.0.1:<port>/<db>`,
    );
  else {
    console.log(
      `Pooler login name: ${RENDER_WORKER_ROLE}.${resolveTarget().ref}  (admin URL targets ${safeTarget(url)})`,
    );
    console.log(
      "Set on the render worker host ONLY: PRISM_STUDIO_RENDER_WORKER_DB_URL=postgresql://<login>:<password>@<session-pooler-host>:5432/postgres",
    );
  }
} catch (err) {
  console.error(
    err instanceof ProvisionRefused ? err.message : redact(err instanceof Error ? err.message : String(err)),
  );
  process.exitCode = err instanceof ProvisionRefused ? 2 : 1;
} finally {
  await client.end();
}
