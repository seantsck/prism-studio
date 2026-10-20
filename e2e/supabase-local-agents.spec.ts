import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import pg from "pg";
import { getPrismStudioDevCredentials } from "./dev-credentials";
import { agentCli } from "./local-agent-cli";

/**
 * Phase 2F M2D.3C1 on the real stack (Supabase Auth + RLS + the hosted Prism Studio database): the project owner pairs
 * a REMOTE Local Agent from the Local agents page, the real agent CLI (separate process, NO credentials) pairs and
 * heartbeats through the Next.js agent routes (no browser session: the session proxy must let them through), and the
 * owner revokes it. The fictional device and its pairing codes are deleted afterwards.
 */
const { email: EMAIL, password: PASSWORD } = getPrismStudioDevCredentials();
const ORIGIN = "http://localhost:3101";
const LABEL = `Fictional e2e rig ${randomUUID().slice(0, 8)}`;
const started = new Date();
let home: string;

test.beforeAll(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "prism-e2e-supabase-agent-"));
});

test.afterAll(async () => {
  rmSync(home, { recursive: true, force: true });
  const url = process.env.SUPABASE_DB_URL ?? "";
  const dev = process.env.PRISM_STUDIO_DEV_USER_ID?.trim();
  if (!url.includes("lyqdxiyjperhniwhzsvg") || !dev) return;
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    // only what THIS test created: its uniquely labelled device, and the dev owner's codes made since it started
    await c.query("delete from local_agents where label = $1", [LABEL]);
    await c.query(
      `delete from local_agent_pairings p where p.created_by = $1 and p.created_at >= $2
         and not exists (select 1 from local_agents d where d.pairing_id = p.id)`,
      [dev, started],
    );
  } finally {
    await c.end();
  }
});

test("owner pairs a remote agent through the hosted stack; heartbeat → online; revoke stops it", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const cli = await agentCli(home);
  await page.goto("/login");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("お嬢様、僕と結婚してください。").first()).toBeVisible({ timeout: 30_000 });

  await page.goto("/projects/ojousama/agents");
  await page.getByTestId("pair-local-agent").click();
  const code = (await page.getByTestId("pairing-code").textContent())!.trim();

  // the agent endpoints answer the workstation without any session (not redirected to /login, no 401)
  const paired = await cli(["pair", "--server", ORIGIN, "--code", code, "--label", LABEL]);
  expect(paired.code, paired.out).toBe(0);
  await expect(page.getByTestId("pairing-outcome")).toHaveAttribute("data-state", "paired");
  await expect(page.getByTestId("pairing-code")).toHaveCount(0);

  const device = page.locator('[data-testid="local-agent"]', { hasText: LABEL });
  await expect(device).toHaveAttribute("data-state", "offline");
  const beat = await cli(["run", "--once", "--fake-tools"], true);
  expect(beat.code, beat.out).toBe(0);
  await expect(device).toHaveAttribute("data-state", "online", { timeout: 30_000 });
  await expect(device.getByTestId("local-agent-toolchain")).toHaveText("Toolchain ready");
  const status = await cli(["status"]);
  expect(status.code, status.out).toBe(0);

  await page.reload();
  expect(await page.content()).not.toContain(code);

  await device.getByTestId("revoke-agent").click();
  await device.getByTestId("confirm-revoke").click();
  await expect(device).toHaveAttribute("data-state", "revoked");
  const refused = await cli(["run", "--once", "--fake-tools"], true);
  expect(refused.code).toBe(3);
  expect(refused.out).toContain("revoked");
});
