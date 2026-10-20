import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  HEARTBEAT_SCHEMA,
  WORKER_VERSION,
  workRootId,
  writeHeartbeat,
  type ToolchainReadiness,
} from "../src/lib/reconstruction/local-worker/runtime";
import { getPrismStudioDevCredentials } from "./dev-credentials";

/**
 * Phase 2F M2D.3B on the real stack (Supabase Auth + RLS): what the Reconstruction panel says about LOCAL execution.
 * Local Capture is offered only while the same-host worker's heartbeat is fresh AND its toolchain is ready. This spec
 * stands in for the worker by writing its heartbeat file in the server's work root (the server only ever READS it),
 * so no tool runs and no job is created. The worker itself is exercised end to end by `npm run db:local-worker`.
 */
const { email: EMAIL, password: PASSWORD } = getPrismStudioDevCredentials();
const EP = "/projects/ojousama/episodes/ep-1";
// must match PRISM_LOCAL_RECONSTRUCTION_ROOT in playwright.supabase.config.ts
const ROOT = path.join(os.tmpdir(), "prism-e2e-local-worker");

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

const readiness = (state: ToolchainReadiness["state"]): ToolchainReadiness => ({
  state,
  colmap: { provenance: state === "colmap_unverified" ? "unverified" : "verified", version: "4.2.1" },
  brush: { version: "0.3.0", compatible: true },
  gpu: { loaderPresent: true },
  checkedAt: new Date().toISOString(),
});
const beat = (o: { state?: ToolchainReadiness["state"]; busy?: boolean; ageMs?: number } = {}) =>
  writeHeartbeat(ROOT, {
    schema: HEARTBEAT_SCHEMA,
    workerId: "local-e2e00000-00000001",
    pid: process.pid,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    lastHeartbeatAt: new Date(Date.now() - (o.ageMs ?? 0)).toISOString(),
    workerVersion: WORKER_VERSION,
    workRoot: workRootId(ROOT),
    toolchain: readiness(o.state ?? "ready"),
    busy: o.busy ?? false,
  });

async function openSet(page: Page) {
  await page.goto(`${EP}/shots`);
  await page.getByRole("link", { name: "3A", exact: true }).click();
  await page.waitForURL(/\/shots\/[0-9a-f-]{36}/);
  await page.goto(`${page.url().split("?")[0]}?section=set`);
  await page.getByTestId("open-in-3d-set").click();
  await page.waitForURL(/\/locations\/[0-9a-f-]{36}\/3d\?shot=/);
  await expect(page.getByTestId("reconstruction-jobs")).toHaveAttribute("data-loaded", "true", {
    timeout: 60_000,
  });
}

test.beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
});
test.afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

test("Local Capture follows the worker: offline → Generate disabled; online + verified toolchain → free local default; stopped → unavailable", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.goto("/login");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("お嬢様、僕と結婚してください。").first()).toBeVisible({ timeout: 30_000 });

  const runtime = page.getByTestId("recon-local-runtime");
  const status = page.getByTestId("recon-provider-status");

  // 1. no worker has ever run on this root: offline, nothing pre-selected, Generate disabled
  await openSet(page);
  await expect(page.getByTestId("recon-provider")).toHaveValue("");
  await page.getByTestId("recon-provider").selectOption("local_capture");
  await expect(runtime).toHaveAttribute("data-worker", "offline");
  await expect(page.getByTestId("recon-local-worker")).toHaveText("Worker: Offline");
  await expect(page.getByTestId("recon-gate")).toContainText("worker is not running");
  await expect(page.getByTestId("recon-generate")).toBeDisabled();

  // 2. the worker is online with a verified toolchain: Local Capture is the FREE LOCAL DEFAULT (never a paid one)
  await beat();
  const keepAlive = setInterval(() => void beat(), 2_000);
  try {
    await openSet(page);
    await expect(page.getByTestId("recon-provider")).toHaveValue("local_capture");
    await expect(status).toHaveAttribute("data-state", "ready");
    await expect(status).toContainText("Free · runs on this machine");
    await expect(runtime).toHaveAttribute("data-worker", "online");
    await expect(runtime).toHaveAttribute("data-toolchain", "ready");
    await expect(page.getByTestId("recon-local-toolchain")).toHaveText("Toolchain: Ready");
    await expect(page.getByTestId("recon-ack-cost")).toHaveCount(0); // free: nothing to acknowledge
    await expect(page.getByTestId("recon-gate")).not.toContainText("worker");
    // nothing about the machine leaks into the page
    await expect(page.getByTestId("reconstruction-jobs")).not.toContainText(ROOT);
    await expect(page.getByTestId("reconstruction-jobs")).not.toContainText(String(process.pid));

    // busy: queued jobs wait their turn
    await beat({ busy: true });
    clearInterval(keepAlive);
    const busyAlive = setInterval(() => void beat({ busy: true }), 2_000);
    try {
      await openSet(page);
      await expect(runtime).toHaveAttribute("data-busy", "true");
      await expect(runtime).toContainText("new jobs wait their turn");
    } finally {
      clearInterval(busyAlive);
    }

    // worker online but COLMAP unverified: not usable (the provenance policy is never weakened for the UI)
    const unverified = setInterval(() => void beat({ state: "colmap_unverified" }), 2_000);
    try {
      await beat({ state: "colmap_unverified" });
      await openSet(page);
      await expect(page.getByTestId("recon-provider")).toHaveValue("");
      await page.getByTestId("recon-provider").selectOption("local_capture");
      await expect(runtime).toHaveAttribute("data-toolchain", "colmap_unverified");
      await expect(page.getByTestId("recon-gate")).toContainText("has not been verified");
      await expect(page.getByTestId("recon-generate")).toBeDisabled();
    } finally {
      clearInterval(unverified);
    }
  } finally {
    clearInterval(keepAlive);
  }

  // 3. the worker stopped (its last heartbeat is stale): verified toolchain, but unavailable; Generate disabled
  await beat({ ageMs: 120_000 });
  await openSet(page);
  await expect(page.getByTestId("recon-provider")).toHaveValue("");
  await page.getByTestId("recon-provider").selectOption("local_capture");
  await expect(status).toHaveAttribute("data-state", "unavailable");
  await expect(runtime).toHaveAttribute("data-worker", "offline");
  await expect(page.getByTestId("recon-local-toolchain")).toHaveText("Toolchain: Ready (last reported)");
  await expect(page.getByTestId("recon-generate")).toBeDisabled();
});
