import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { agentCli } from "./local-agent-cli";

/**
 * Phase 2F M2D.3C1 (memory mode): pairing a REMOTE Local Agent from the project's Local agents page. The agent is the
 * real CLI in a separate process (no credentials), pairing over HTTP with the one-time code the page shows once,
 * then heartbeating with its (fake-tool) capability report. No job, no Asset, no tool run, no provider.
 */
const PAGE = "/projects/ojousama/agents";
const ORIGIN = "http://localhost:3102";
let home: string;

test.beforeAll(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "prism-e2e-agent-"));
});
test.afterAll(() => rmSync(home, { recursive: true, force: true }));

test("pair → code shown once → device online with toolchain → offline → revoke stops the agent", async ({
  page,
}) => {
  test.setTimeout(150_000);
  const cli = await agentCli(home);
  await page.goto(PAGE);
  await expect(page.getByTestId("local-agents-panel")).toBeVisible();
  await expect(page.getByText("No local agents are paired with this project.")).toBeVisible();

  // 1. the owner creates a one-time code: shown once with its expiry and the exact command
  await page.getByTestId("pair-local-agent").click();
  const code = (await page.getByTestId("pairing-code").textContent())!.trim();
  expect(code).toMatch(/^([0-9A-Z]{4}-){6}[0-9A-Z]{4}$/);
  await expect(page.getByTestId("pairing-countdown")).toHaveText(/^(10:00|9:5\d)$/);
  await expect(page.getByTestId("pairing-command")).toHaveText(
    `npm run local:agent -- pair --server ${ORIGIN} --code ${code}`,
  );

  // 2. the workstation pairs with it (outbound HTTP to the pinned origin; key generated locally)
  const paired = await cli(["pair", "--server", ORIGIN, "--code", code, "--label", "Fictional rig"]);
  expect(paired.code, paired.out).toBe(0);
  expect(paired.out).not.toContain(code);

  // 3. the code disappears the moment it is used; the device appears, offline until its first heartbeat
  await expect(page.getByTestId("pairing-outcome")).toHaveAttribute("data-state", "paired");
  await expect(page.getByTestId("pairing-code")).toHaveCount(0);
  const device = page.getByTestId("local-agent");
  await expect(device).toHaveCount(1);
  await expect(device.getByTestId("local-agent-label")).toHaveText("Fictional rig");
  await expect(device).toHaveAttribute("data-state", "offline");
  await expect(device.getByTestId("local-agent-toolchain")).toHaveText("No report yet");
  await expect(device.getByTestId("local-agent-last-seen")).toHaveText("never");

  // the same code can never pair a second workstation
  const again = await cli(["pair", "--server", ORIGIN, "--code", code, "--profile", "second"]);
  expect(again.code).not.toBe(0);
  expect(again.out).toContain("pairing_consumed");

  // 4. a signed heartbeat: online, toolchain summary, last seen
  const beat = await cli(["run", "--once", "--fake-tools"], true);
  expect(beat.code, beat.out).toBe(0);
  await expect(device).toHaveAttribute("data-state", "online", { timeout: 15_000 });
  await expect(device.getByTestId("local-agent-toolchain")).toHaveText("Toolchain ready");
  await expect(device.getByTestId("local-agent-last-seen")).toHaveText(/s ago$/);
  await expect(page.getByTestId("remote-execution-note")).toContainText(
    "A ready workstation runs this project's Remote Local Agent reconstruction jobs",
  );

  // no secret is ever in the page: not the (used) code, not a private key
  await page.reload();
  const html = await page.content();
  expect(html).not.toContain(code);
  expect(html).not.toContain(code.replace(/-/g, ""));
  expect(html).not.toContain("PRIVATE KEY");

  // 5. no heartbeat for more than 30 s: offline (the pairing stays)
  await expect(device).toHaveAttribute("data-state", "offline", { timeout: 45_000 });

  // 6. revoke: terminal, the agent is refused and stops
  await device.getByTestId("revoke-agent").click();
  await device.getByTestId("confirm-revoke").click();
  await expect(device).toHaveAttribute("data-state", "revoked");
  const refused = await cli(["run", "--once", "--fake-tools"], true);
  expect(refused.code).toBe(3);
  expect(refused.out).toContain("revoked");
  await page.reload();
  await expect(page.getByTestId("local-agent")).toHaveAttribute("data-state", "revoked");
});

test("an unused pairing code expires on the page after 10 minutes", async ({ page }) => {
  await page.clock.install();
  await page.goto(PAGE);
  await page.getByTestId("pair-local-agent").click();
  await expect(page.getByTestId("pairing-code")).toBeVisible();
  await page.clock.fastForward("10:01");
  await expect(page.getByTestId("pairing-code")).toHaveCount(0);
  await expect(page.getByTestId("pairing-outcome")).toHaveAttribute("data-state", "expired");
});
