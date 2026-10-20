import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { getPrismStudioDevCredentials } from "./dev-credentials";
import { agentProcess } from "./local-agent-cli";

/**
 * Phase 2F M2D.3C2 on the REAL stack: Supabase Auth + RLS, the hosted Prism Studio database and PRIVATE Storage. The
 * owner pairs a workstation and asks for a Remote Local Agent reconstruction; the browser leaves; the real agent CLI
 * (separate process, NO credentials) leases the job, downloads exactly its photographs through the signed Next.js
 * routes (no session), runs the M2D.3A engine with fake COLMAP/Brush, uploads one SPZ, and Prism imports it through
 * the shared ingestion. No provider call, no paid call. Everything created is removed.
 */
const { email: EMAIL, password: PASSWORD } = getPrismStudioDevCredentials();
const ORIGIN = "http://localhost:3101";
const EP = "/projects/ojousama/episodes/ep-1";
const PREFIX = `e2e-remote-${Date.now()}`;
const NAMES = [`${PREFIX}-a.png`, `${PREFIX}-b.png`, `${PREFIX}-c.png`];
const LABEL = `Fictional remote rig ${randomUUID().slice(0, 8)}`;
const started = new Date();
let home: string;

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

/** A valid 1×1 RGB PNG of one colour (three DIFFERENT photographs: the engine refuses duplicates). */
function png(r: number, g: number, b: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])),
    chunk("IDAT", deflateSync(Buffer.from([0, r, g, b]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const PNGS = [png(210, 30, 30), png(30, 210, 30), png(30, 30, 210)];

const tsx = (args: string[]) =>
  execFileSync("npx", ["tsx", "--env-file=.env.local", "scripts/previs-cleanup.mts", ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PRISM_STUDIO_PERSISTENCE: "supabase",
      NODE_ENV: "test",
      PRISM_STUDIO_WORKER_DEV_STORAGE: "1",
    },
    encoding: "utf8",
    timeout: 120_000,
    shell: process.platform === "win32",
  });
const cleanup = () => {
  try {
    tsx(["--yes", `--e2e-assets-prefix=${PREFIX}`]);
  } catch {
    /* best effort; idempotent */
  }
};

test.beforeAll(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "prism-e2e-supabase-remote-"));
  cleanup();
});
test.afterAll(async () => {
  cleanup();
  rmSync(home, { recursive: true, force: true });
  const url = process.env.SUPABASE_DB_URL ?? "";
  const dev = process.env.PRISM_STUDIO_DEV_USER_ID?.trim();
  if (!url.includes("lyqdxiyjperhniwhzsvg") || !dev) return;
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
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

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("お嬢様、僕と結婚してください。").first()).toBeVisible({ timeout: 30_000 });
}

async function openSet(page: Page, url?: string) {
  if (url) await page.goto(url);
  else {
    await page.goto(`${EP}/shots`);
    await page.getByRole("link", { name: "3A", exact: true }).click();
    await page.waitForURL(/\/shots\/[0-9a-f-]{36}/);
    await page.goto(`${page.url().split("?")[0]}?section=set`);
    await page.getByTestId("open-in-3d-set").click();
    await page.waitForURL(/\/locations\/[0-9a-f-]{36}\/3d\?shot=/);
  }
  await expect(page.getByTestId("reconstruction-jobs")).toHaveAttribute("data-loaded", "true", {
    timeout: 60_000,
  });
  return page.url();
}

type JobRow = {
  id: string;
  status: string;
  provider: string;
  provider_operation_id: string | null;
  provider_operation_json: Record<string, unknown> | null;
  reconstruction: {
    method: string;
    calibration_json: { scaleMethod: string };
    asset: { mime: string; object_path: string; bucket_public: boolean; source: string };
  } | null;
};

test("hosted: Remote Local Agent job runs on the paired workstation with the browser closed; Prism imports the SPZ", async ({
  page,
}) => {
  test.setTimeout(600_000);
  const start = await agentProcess(home);
  await signIn(page);
  for (const [i, name] of NAMES.entries()) {
    await page.goto("/projects/ojousama/assets");
    await page.locator("input[type=file]").setInputFiles({ name, mimeType: "image/png", buffer: PNGS[i]! });
    await page.locator("select[name=purpose]").first().selectOption("location_ref");
    await page.getByRole("button", { name: "Upload asset" }).click();
    await expect(page.getByText(name).first()).toBeVisible({ timeout: 60_000 });
  }

  // pair through the hosted stack (the agent routes answer without any session)
  await page.goto("/projects/ojousama/agents");
  await page.getByTestId("pair-local-agent").click();
  const code = (await page.getByTestId("pairing-code").textContent())!.trim();
  const pair = start(["pair", "--server", ORIGIN, "--code", code, "--label", LABEL]);
  expect(await pair.exit, pair.output()).toBe(0);
  await expect(page.getByTestId("pairing-outcome")).toHaveAttribute("data-state", "paired");

  const agent = start(["run", "--fake-tools", "--max-jobs", "1", "--poll-ms", "1000"], true);
  await expect.poll(() => agent.output().includes("heartbeat accepted"), { timeout: 90_000 }).toBe(true);
  const setUrl = await openSet(page);
  await page.getByTestId("recon-provider").selectOption("local_agent_capture");
  await expect(page.getByTestId("recon-provider-status")).toHaveAttribute("data-state", "ready", {
    timeout: 60_000,
  });
  await expect(page.getByTestId("recon-remote-runtime")).toHaveAttribute("data-state", "ready");
  for (const n of NAMES) await page.getByTestId("recon-add-source").filter({ hasText: n }).click();
  await expect(page.getByTestId("recon-generate")).toBeEnabled({ timeout: 30_000 });
  await page.getByTestId("recon-generate").click();
  await expect(page.getByTestId("recon-job").first()).toHaveAttribute("data-status", /queued|running/, {
    timeout: 60_000,
  });

  // the browser leaves; the workstation does the work
  await page.goto("about:blank");
  expect(await agent.exit, agent.output()).toBe(0);
  expect(agent.output()).toContain("Jobs: succeeded");
  expect(agent.output()).not.toMatch(/BEGIN PRIVATE KEY|prism-assets|supabase\.co|sb_secret/);

  // the database: one job of the remote provider, leased, imported as a generated, private SPZ with unknown scale
  const out = tsx(["--report-jobs"]);
  const rows = JSON.parse(out.slice(out.indexOf("["))) as JobRow[];
  const mine = rows.filter((r) => r.provider === "local_agent_capture" && r.status === "succeeded");
  expect(mine.length).toBeGreaterThanOrEqual(1);
  const row = mine.at(-1)!;
  expect(row.provider_operation_id).toMatch(/^agent:[0-9a-f]{32}$/);
  expect(row.provider_operation_json).toMatchObject({ runner: "remote_agent" });
  expect(JSON.stringify(row.provider_operation_json)).not.toMatch(/https?:|object_?path|secret|[A-Za-z]:\\/i);
  expect(row.reconstruction).toMatchObject({
    method: "generated",
    calibration_json: { scaleMethod: "unknown" },
    asset: { mime: "application/x-spz", bucket_public: false, source: "provider_output" },
  });

  // back in Prism (the session is still valid): the job is done
  await openSet(page, setUrl);
  const job = page.locator(`[data-testid="recon-job"][data-job-id="${row.id}"]`);
  await expect(job).toHaveAttribute("data-status", "succeeded", { timeout: 60_000 });
  await job.click();
  await expect(page.getByTestId("recon-job-agent")).toContainText(`Remote Local Agent · ${LABEL}`);
  await expect(page.getByTestId("recon-result")).toContainText("SPZ");
});
