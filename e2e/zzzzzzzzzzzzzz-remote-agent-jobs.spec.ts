import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { expect, test, type Page } from "@playwright/test";
import { agentProcess } from "./local-agent-cli";

/**
 * Phase 2F M2D.3C2 (memory mode): a REMOTE Local Agent runs a reconstruction job for its project.
 *
 * The workstation is the real agent CLI in a separate process with NO server credential (pairing, signed lease,
 * signed source downloads, the M2D.3A engine with fake COLMAP/Brush run as real child processes, signed progress,
 * one signed SPZ upload). The browser only creates and watches the job: it is closed while the workstation works.
 * No paid provider exists on this server; World Labs is unconfigured.
 */
test.use({
  launchOptions: {
    args: [
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--ignore-gpu-blocklist",
    ],
  },
});
test.describe.configure({ mode: "serial" });

const ORIGIN = "http://localhost:3102";
const EP = "/projects/ojousama/episodes/ep-1";
/** A valid 1×1 RGB PNG of one colour: three DIFFERENT photographs (the engine refuses duplicates). */
function png(r: number, g: number, b: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.from([0, r, g, b]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const PNGS = [png(200, 40, 40), png(40, 200, 40), png(40, 40, 200)];
const STAMP = Date.now();
const NAMES = [`remote-a-${STAMP}.png`, `remote-b-${STAMP}.png`, `remote-c-${STAMP}.png`];
let home: string;
let start: Awaited<ReturnType<typeof agentProcess>>;
let setUrl = "";

test.beforeAll(async () => {
  home = mkdtempSync(path.join(os.tmpdir(), "prism-e2e-remote-agent-"));
  start = await agentProcess(home);
});
test.afterAll(() => rmSync(home, { recursive: true, force: true }));

async function openSet(page: Page) {
  if (setUrl) {
    await page.goto(setUrl);
  } else {
    await page.goto(`${EP}/shots`);
    await page.getByRole("link", { name: "3A", exact: true }).click();
    await page.waitForURL(/\/shots\/[0-9a-f-]{36}/);
    await page.goto(`${page.url().split("?")[0]}?section=set`);
    await page.getByTestId("open-in-3d-set").click();
    await page.waitForURL(/\/locations\/[0-9a-f-]{36}\/3d\?shot=/);
    setUrl = page.url();
  }
  await expect(page.getByTestId("reconstruction-jobs")).toHaveAttribute("data-loaded", "true", {
    timeout: 60_000,
  });
}

/** The workstation is online once Prism accepted its first heartbeat (a page opened before that has no default). */
const heartbeating = (agent: { output(): string }) =>
  expect.poll(() => agent.output().includes("heartbeat accepted"), { timeout: 60_000 }).toBe(true);

const jobIds = (page: Page) =>
  page.getByTestId("recon-job").evaluateAll((els) => els.map((e) => e.getAttribute("data-job-id")));
const job = (page: Page, id: string) => page.locator(`[data-testid="recon-job"][data-job-id="${id}"]`);

/** A new request (a different photo order is a different job; the same order would be the same attempt). */
async function generateRemote(page: Page, names = NAMES) {
  await expect(page.getByTestId("recon-provider")).toHaveValue("local_agent_capture", { timeout: 30_000 });
  while (await page.getByTestId("recon-source-remove").count())
    await page.getByTestId("recon-source-remove").first().click();
  for (const n of names) await page.getByTestId("recon-add-source").filter({ hasText: n }).click();
  await expect(page.getByTestId("recon-generate")).toBeEnabled({ timeout: 30_000 });
  const before = await jobIds(page);
  await page.getByTestId("recon-generate").click();
  await expect.poll(async () => (await jobIds(page)).length > before.length, { timeout: 30_000 }).toBe(true);
  return (await jobIds(page)).find((id) => !before.includes(id))!;
}

test("photographs exist; a workstation is paired from Local agents", async ({ page }) => {
  test.setTimeout(120_000);
  for (const [i, name] of NAMES.entries()) {
    await page.goto("/projects/ojousama/assets");
    await page.locator("input[type=file]").setInputFiles({ name, mimeType: "image/png", buffer: PNGS[i]! });
    await page.locator("select[name=purpose]").first().selectOption("location_ref");
    await page.getByRole("button", { name: "Upload asset" }).click();
    await expect(page.getByText(name).first()).toBeVisible({ timeout: 30_000 });
  }
  await page.goto("/projects/ojousama/agents");
  await page.getByTestId("pair-local-agent").click();
  const code = (await page.getByTestId("pairing-code").textContent())!.trim();
  const pair = start(["pair", "--server", ORIGIN, "--code", code, "--label", "E2E workstation"]);
  expect(await pair.exit, pair.output()).toBe(0);
  await expect(page.getByTestId("pairing-outcome")).toHaveAttribute("data-state", "paired");
});

test("Remote Local Agent → job runs on the workstation with the browser closed → validated SPZ is imported", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const foreign: string[] = [];
  page.on("request", (r) => {
    const u = r.url();
    if (!u.startsWith("data:") && !u.startsWith("blob:") && new URL(u).origin !== ORIGIN) foreign.push(u);
  });
  // the workstation runs (heartbeat + lease polling); it exits after one job reached an outcome
  const agent = start(["run", "--fake-tools", "--max-jobs", "1", "--poll-ms", "500"], true);
  await heartbeating(agent);
  await openSet(page);
  // free first: the same-host Local Capture is not available here, so the ready paired workstation is the default
  const status = page.getByTestId("recon-provider-status");
  await expect(status).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
  await expect(status).toContainText("Free · paired workstation");
  const runtime = page.getByTestId("recon-remote-runtime");
  await expect(runtime).toHaveAttribute("data-state", "ready");
  await expect(page.getByTestId("recon-remote-summary")).toHaveText("Ready · 1 workstation online");
  await expect(page.getByTestId("recon-remote-agents-link")).toHaveAttribute(
    "href",
    "/projects/ojousama/agents",
  );
  const id = await generateRemote(page);

  // the browser leaves: nothing in the page drives the job any more
  await page.goto("about:blank");
  expect(await agent.exit, agent.output()).toBe(0);
  expect(agent.output()).toContain("Jobs: succeeded");
  expect(agent.output()).not.toMatch(/BEGIN PRIVATE KEY|\.local-storage|objectPath/);

  // back in Prism: the job succeeded, its result is a validated private SPZ with unknown scale
  await openSet(page);
  await expect(job(page, id)).toHaveAttribute("data-status", "succeeded", { timeout: 30_000 });
  await job(page, id).click();
  await expect(page.getByTestId("recon-job-agent")).toContainText("Remote Local Agent · E2E workstation");
  await expect(page.getByTestId("recon-result")).toContainText("SPZ");
  await expect(page.getByTestId("recon-result")).toContainText("scale unknown");
  await expect(page.getByTestId("recon-use")).toBeVisible();
  // the panel never shows a lease, a key or a path
  await expect(page.getByTestId("recon-job-detail")).not.toContainText(
    /agent:|lease|MCowBQYDK2VwAyEA|[A-Z]:\\/,
  );
  expect(foreign).toEqual([]);
});

test("cancel from the browser: the workstation stops at its next keepalive; nothing is uploaded; Retry stays remote", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const agent = start(["run", "--fake-tools", "--max-jobs", "1", "--poll-ms", "500"], true, {
    FAKE_BRUSH_MODE: "slow",
  });
  await heartbeating(agent);
  await openSet(page);
  await expect(page.getByTestId("recon-provider-status")).toHaveAttribute("data-state", "ready", {
    timeout: 30_000,
  });
  const id = await generateRemote(page, [...NAMES].reverse());
  await expect(job(page, id)).toHaveAttribute("data-stage", "splat_training", { timeout: 120_000 });
  await job(page, id).click();
  await expect(page.getByTestId("recon-job-agent")).toContainText("stage splat training");
  await page.getByTestId("recon-cancel").click();
  await expect(job(page, id)).toHaveAttribute("data-status", "cancelled", { timeout: 30_000 });
  expect(await agent.exit, agent.output()).toBe(0);
  expect(agent.output()).toContain("Jobs: cancelled");
  await expect(page.getByTestId("recon-result")).toHaveCount(0);

  // Retry is a NEW attempt of the SAME provider (never a substitute); with no workstation running it waits
  await page.getByTestId("recon-retry").click();
  await expect.poll(async () => (await jobIds(page)).length, { timeout: 30_000 }).toBeGreaterThan(0);
  const retried = page.locator('[data-testid="recon-job"][data-attempt="2"]').first();
  await expect(retried).toHaveAttribute("data-status", "queued");
  await expect(retried).toContainText("Remote Local Agent");
  // tidy: the queued retry is cancelled, and the workstation is revoked
  await retried.click();
  await page.getByTestId("recon-cancel").click();
  await expect(retried).toHaveAttribute("data-status", "cancelled", { timeout: 30_000 });
  await page.goto("/projects/ojousama/agents");
  const device = page.getByTestId("local-agent").filter({ hasText: "E2E workstation" });
  await device.getByTestId("revoke-agent").click();
  await device.getByTestId("confirm-revoke").click();
  await expect(device).toHaveAttribute("data-state", "revoked");
});
