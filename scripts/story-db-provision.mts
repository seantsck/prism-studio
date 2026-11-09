// Provisions the LOGIN credential of the Story worker's least-privilege database role (Phase 5B-S2).
//
//   PRISM_STUDIO_STORY_DB_PASSWORD=<new secret> npm run story:db:provision
//   PRISM_STUDIO_STORY_DB_PASSWORD=<new secret> npm run story:db:provision -- --rotate
//
// Migration 0054 creates `prism_story_worker` NOLOGIN with no password. This script is the ONLY place a secret is
// attached to it, and the secret comes from the environment: never in a migration, never committed, never printed.
// Idempotent: an existing login is NOT replaced unless --rotate is passed. Then it audits the role's privileges.
// Independent of the generation and continuity worker roles. The resulting URL belongs on the Story worker host only
// (PRISM_STUDIO_STORY_WORKER_DB_URL), never in the web app and never in a NEXT_PUBLIC_* variable.
import pg from "pg";
import { disposableLocalTarget, redact, resolveTarget, safeTarget, startScript } from "./lib/safety.mjs";
import {
  auditStoryWorkerRole,
  ProvisionRefused,
  provisionStoryWorkerLogin,
  STORY_WORKER_CONNECTION_LIMIT,
  STORY_WORKER_ROLE,
} from "./lib/story-worker-role";

const rotate = process.argv.includes("--rotate");
const url = startScript({
  productionSafe: true,
  mode: `provision ${STORY_WORKER_ROLE} login${rotate ? " (rotate)" : ""}`,
});
const password = process.env.PRISM_STUDIO_STORY_DB_PASSWORD ?? "";

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  const outcome = await provisionStoryWorkerLogin(client, password, { rotate });
  console.log(
    outcome === "unchanged"
      ? `${STORY_WORKER_ROLE} already has LOGIN enabled. No change made (pass --rotate to replace its password).`
      : `${STORY_WORKER_ROLE}: LOGIN ${outcome === "rotated" ? "password rotated" : "enabled"} (connection limit ${STORY_WORKER_CONNECTION_LIMIT}).`,
  );
  const audit = await auditStoryWorkerRole(client);
  if (audit.failures.length) {
    console.error(`Privilege audit FAILED: ${audit.failures.join("; ")}`);
    process.exitCode = 1;
  } else console.log("Privilege audit: minimal (story_proposals + writing_proposals in flight only).");
  if (disposableLocalTarget(url))
    console.log(
      `Disposable target ${safeTarget(url)}: PRISM_STUDIO_STORY_WORKER_DB_URL=postgresql://${STORY_WORKER_ROLE}:<password>@127.0.0.1:<port>/<db>`,
    );
  else {
    console.log(
      `Pooler login name: ${STORY_WORKER_ROLE}.${resolveTarget().ref}  (admin URL targets ${safeTarget(url)})`,
    );
    console.log(
      "Set on the Story worker host ONLY: PRISM_STUDIO_STORY_WORKER_DB_URL=postgresql://<login>:<password>@<session-pooler-host>:5432/postgres",
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
