import { crc32, deflateSync } from "node:zlib";
import { expect, test, type Page } from "@playwright/test";

/**
 * Phase 4C-I2 — the Shot-centric Spatial Workspace and the Production Frame handoff. Memory mode (its own server), the
 * real renderer (SwiftShader), the real UI and server actions. No provider call, no generated media.
 *
 *   A  Shot workspace deep link + refresh: the route owns the Shot (no selector); server-derived state is identical
 *   D  shared Location (RELEASE BLOCKER): one set, independent Shot camera / blocking / lighting; a Set save stales
 *   E  shared warning only for Location-owned edits (geometry, camera, skybox), never for Shot lighting / blocking
 *   I  restore Shot camera on open: scene revision + saved fingerprint unchanged, not dirty; no silent bookmark change
 *   B  Location selector A → B (RELEASE BLOCKER, P6): a navigation, a remount, no A state; back / forward
 *   C  dirty Set switch (RELEASE BLOCKER): Stay keeps the edit; Discard navigates and nothing is saved
 *   J  workspace Master Frame → Production Frame through the same promotion action
 *   K  stale Use anyway; a digest that changed meanwhile asks again
 *   L  missing source Master Frame: truthful lineage, nothing breaks
 *   F  Create 3D Set from the Shot route: THE Location's set, the same one the Location page opens
 *   G  no Location: optional spatial empty state, no editor; the image-first path still works
 *   H  Location reassignment: the workspace opens the CURRENT Location; old rows are history only
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

const EP = "/projects/ojousama/episodes/ep-1";
type ShotRef = { code: string; id: string; prepUrl: string; spatialUrl: string };

async function shotOf(page: Page, code: string): Promise<ShotRef> {
  await page.goto(`${EP}/shots`);
  const href = (await page.getByRole("link", { name: code, exact: true }).first().getAttribute("href"))!;
  const id = /\/shots\/([0-9a-f-]{36})/.exec(href)![1]!;
  const prepUrl = `${EP}/shots/${id}`;
  return { code, id, prepUrl, spatialUrl: `${prepUrl}/spatial` };
}

const set = (page: Page) => page.getByTestId("virtual-set");

async function ready(page: Page) {
  await expect(set(page)).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
  await expect(page.getByTestId("character-blocking")).toHaveAttribute("data-loaded", "true", {
    timeout: 30_000,
  });
  await expect(page.getByTestId("shot-lighting")).toHaveAttribute("data-loaded", "true", { timeout: 30_000 });
}

/** Shot Prep → Open Spatial Workspace (the product entry point) */
async function openWorkspace(page: Page, s: ShotRef) {
  await page.goto(`${s.prepUrl}?section=set`);
  await page.getByTestId("open-spatial-workspace").click();
  await page.waitForURL(new RegExp(`/shots/${s.id}/spatial$`));
  await ready(page);
}

/** Shot Prep → the Location's 3D Set page (Location-first set management) */
async function openLocationPage(page: Page, s: ShotRef) {
  await page.goto(`${s.prepUrl}?section=set`);
  await page.getByTestId("open-in-3d-set").click();
  await page.waitForURL(/\/locations\/[0-9a-f-]{36}\/3d\?shot=/);
  await ready(page);
  return page.url();
}

const setInput = async (page: Page, testId: string, value: string) => {
  const input = page.getByTestId(testId);
  await input.fill(value);
  await input.press("Enter");
  await expect(input).toHaveValue(value);
};

async function saveSet(page: Page, text = "Saved") {
  await page.getByTestId("save-set").click();
  await expect(page.getByTestId("set-status")).toContainText(text, { timeout: 30_000 });
  await expect(set(page)).toHaveAttribute("data-dirty", "false");
}

async function link(page: Page) {
  await page.getByTestId("link-shot-camera").click();
  await expect(page.getByTestId("set-status")).toContainText("linked", { timeout: 30_000 });
}

async function capture(page: Page) {
  await page.getByTestId("capture-master-frame").click();
  await expect(page.getByTestId("set-status")).toContainText("Master frame saved", { timeout: 60_000 });
}

async function saveLight(page: Page, intensity: string) {
  if ((await page.getByTestId("light-intensity").count()) === 0) {
    await page.getByTestId("lighting-base-mode").selectOption("replace");
    await page.getByTestId("lighting-add-type").selectOption("point");
    await page.getByTestId("lighting-add").click();
  }
  await page.getByTestId("light-intensity").fill(intensity);
  await page.getByTestId("lighting-save").click();
  await expect(page.getByTestId("shot-lighting")).toHaveAttribute("data-dirty", "false", { timeout: 30_000 });
}

async function block(page: Page, name: string, x: string) {
  await page.getByTestId("blocking-character").selectOption({ label: name });
  await page.getByTestId("add-character-proxy").click();
  await expect(page.getByTestId("blocking-figure").filter({ hasText: name })).toHaveCount(1);
  await setInput(page, "blocking-pos-x", x);
  await page.getByTestId("save-blocking").click();
  await expect(page.getByTestId("blocking-status")).toContainText("Character blocking saved", {
    timeout: 60_000,
  });
}

const attr = async (page: Page, name: string) => (await set(page).getAttribute(name)) ?? "";
const lightingFp = async (page: Page) =>
  (await page.getByTestId("shot-lighting").getAttribute("data-saved-fingerprint")) ?? "";
const figures = (page: Page) =>
  page
    .getByTestId("blocking-figure")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-character-id")).sort());
const workspaceFrames = (page: Page) =>
  page
    .locator('[data-testid^="workspace-promote-"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")!.replace("workspace-promote-", "")));
const hook = <T>(page: Page, path: string[], ...args: unknown[]) =>
  page.evaluate(
    ([p, a]) => {
      let o = (window as unknown as { __prismSet: Record<string, unknown> }).__prismSet as Record<
        string,
        unknown
      >;
      for (const k of (p as string[]).slice(0, -1)) o = o[k] as Record<string, unknown>;
      return (o[(p as string[]).at(-1)!] as (...x: unknown[]) => unknown)(...(a as unknown[]));
    },
    [path, args] as const,
  ) as Promise<T>;

type Pkg = {
  references: {
    productionFrame?: { frameId: string; sourceSpatial?: { masterFrameId: string } };
  };
  spatialReference?: { locationId: string };
};
const pkg = async (page: Page, shotId: string): Promise<Pkg> => {
  const r = await page.request.get(`/api/projects/ojousama/shots/${shotId}/package`);
  expect(r.ok()).toBe(true);
  return (await r.json()) as Pkg;
};

function png(width: number, height: number, rgb: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) raw.set(rgb, y * (width * 3 + 1) + 1 + x * 3);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function assignLocation(page: Page, s: ShotRef, locationName: string | null) {
  await page.goto(`${s.prepUrl}?section=set`);
  const select = page.locator('select[name="spatial.locationId"]');
  const value =
    locationName === null
      ? ""
      : await select.evaluate(
          (el, name) =>
            [...(el as HTMLSelectElement).options].find((o) => o.textContent?.startsWith(name))!.value,
          locationName,
        );
  await select.selectOption(value);
  await page.getByRole("button", { name: "Save location / set" }).click();
  // saved on the server: a fresh load of Shot Prep shows the new assignment
  await expect
    .poll(
      async () => {
        await page.goto(`${s.prepUrl}?section=set`);
        return page.locator('select[name="spatial.locationId"]').inputValue();
      },
      { timeout: 30_000 },
    )
    .toBe(value);
}

// Tokyo Night Streets is the shared set of Shots 1A (A) and 1B (B); nothing else in this server touches it
let A: ShotRef;
let B: ShotRef;
let sceneId = "";
let aFrame = "";
let aLightFp = "";
let bLightFp = "";
let aCameraX = "";

test("A — Shot workspace deep link + refresh: the route owns the Shot; the same server state after reload", async ({
  page,
}) => {
  test.setTimeout(360_000);
  A = await shotOf(page, "1A");
  B = await shotOf(page, "1B");
  await openWorkspace(page, A);
  await expect(page.getByRole("heading", { name: "Spatial Workspace — Shot 1A" })).toBeVisible();
  await expect(set(page)).toHaveAttribute("data-mode", "shot");
  await expect(set(page)).toHaveAttribute("data-shot-id", A.id);
  await expect(page.getByTestId("shot-select")).toHaveCount(0); // the route owns the Shot
  await expect(page.getByTestId("workspace-shot")).toContainText("Shot 1A");
  await expect(page.getByTestId("back-to-shot-prep")).toHaveAttribute("href", A.prepUrl);

  // build the shared set on A, then A's own camera, blocking, lighting and one capture
  await page.getByTestId("load-test-set").click();
  await expect(page.getByTestId("set-status")).toContainText("Hotel Canopy", { timeout: 30_000 });
  await setInput(page, "camera-pos-x", "1");
  await saveSet(page, "3D Set created");
  sceneId = await attr(page, "data-scene-document-id");
  expect(sceneId).not.toBe("");
  await link(page);
  aCameraX = "1";
  await block(page, "Yumeko", "2");
  await saveLight(page, "200");
  aLightFp = await lightingFp(page);
  await capture(page);
  await expect(page.getByTestId("master-frame")).toHaveCount(1, { timeout: 30_000 });
  [aFrame] = await workspaceFrames(page);

  // refresh: identical server-derived state, nothing dirty
  const before = {
    revision: await attr(page, "data-revision"),
    saved: await attr(page, "data-saved-fingerprint"),
  };
  await page.reload();
  await ready(page);
  await expect(set(page)).toHaveAttribute("data-shot-id", A.id);
  await expect(set(page)).toHaveAttribute("data-scene-document-id", sceneId);
  await expect(set(page)).toHaveAttribute("data-revision", before.revision);
  await expect(set(page)).toHaveAttribute("data-saved-fingerprint", before.saved);
  await expect(set(page)).toHaveAttribute("data-dirty", "false");
  await expect(page.getByTestId("bookmark-info")).toBeVisible();
  expect(await figures(page)).toHaveLength(1);
  expect(await lightingFp(page)).toBe(aLightFp);
  expect(await workspaceFrames(page)).toEqual([aFrame]);
  await expect(page.getByTestId("camera-pos-x")).toHaveValue(aCameraX);
});

test("D + E — shared Location: independent Shot state; the shared warning only for Location-owned edits", async ({
  page,
}) => {
  test.setTimeout(420_000);
  await openWorkspace(page, B);
  // the SAME Location set, quiet shared context, and none of A's Shot-owned state
  await expect(set(page)).toHaveAttribute("data-scene-document-id", sceneId);
  await expect(page.getByTestId("shared-set-context")).toHaveText(
    "This 3D Set is shared by 1 other Shot: 1A.",
  );
  await expect(page.getByTestId("bookmark-info")).toHaveCount(0);
  expect(await figures(page)).toEqual([]);
  expect(await lightingFp(page)).toBe("");
  expect(await workspaceFrames(page)).toEqual([]);
  const warning = page.getByTestId("shared-set-warning");

  // Shot-owned edits: lighting and blocking never show the shared-Set warning
  await page.getByTestId("lighting-base-mode").selectOption("replace");
  await page.getByTestId("lighting-add-type").selectOption("point");
  await page.getByTestId("lighting-add").click();
  await expect(page.getByTestId("shot-lighting")).toHaveAttribute("data-dirty", "true");
  await expect(warning).toHaveCount(0);
  await saveLight(page, "50");
  bLightFp = await lightingFp(page);
  expect(bLightFp).not.toBe(aLightFp);
  await page.getByTestId("blocking-character").selectOption({ label: "Sean" });
  await page.getByTestId("add-character-proxy").click();
  await expect(page.getByTestId("character-blocking")).toHaveAttribute("data-dirty", "true");
  await expect(warning).toHaveCount(0);
  await setInput(page, "blocking-pos-x", "-1");
  await page.getByTestId("save-blocking").click();
  await expect(page.getByTestId("blocking-status")).toContainText("Character blocking saved", {
    timeout: 60_000,
  });
  await expect(set(page)).toHaveAttribute("data-dirty", "false");
  await expect(warning).toHaveCount(0);

  // skybox-only (base environment): the scene fingerprint does not move, but it IS shared Set truth
  await hook(page, ["spatial", "setSkyboxId"], "e2e-sky-i2");
  await expect(set(page)).toHaveAttribute("data-dirty", "true", { timeout: 10_000 });
  expect(await attr(page, "data-live-fingerprint")).toBe(await attr(page, "data-saved-fingerprint"));
  await expect(warning).toBeVisible();
  await page.reload(); // discarded: nothing is autosaved
  await ready(page);
  await expect(set(page)).toHaveAttribute("data-dirty", "false");
  await expect(warning).toHaveCount(0);

  // Location-owned geometry: the warning appears; saving it changes the Set for A too
  const revisionBefore = Number(await attr(page, "data-revision"));
  await page.getByTestId("add-box").click();
  await expect(set(page)).toHaveAttribute("data-dirty", "true", { timeout: 10_000 });
  await expect(warning).toHaveText(
    "Saving changes this Set for every Shot using this Location. Their Master Frames may become STALE SCENE.",
  );
  // B's own camera (a Location-owned working camera move, then frozen for B)
  await setInput(page, "camera-pos-x", "-2");
  await saveSet(page);
  await expect(warning).toHaveCount(0);
  expect(Number(await attr(page, "data-revision"))).toBe(revisionBefore + 1);
  await link(page);
  await capture(page);

  // A: still its own camera, blocking and lighting; its old frame is now STALE SCENE (the shared set changed)
  await openWorkspace(page, A);
  await expect(set(page)).toHaveAttribute("data-scene-document-id", sceneId);
  await expect(page.getByTestId("camera-pos-x")).toHaveValue(aCameraX);
  expect(await lightingFp(page)).toBe(aLightFp);
  await expect(page.getByTestId("blocking-figure")).toHaveCount(1);
  await expect(page.getByTestId("blocking-figure").first()).toContainText("Yumeko");
  expect(await workspaceFrames(page)).toEqual([aFrame]);
  await expect(page.getByTestId(`mf-axis-${aFrame}-scene`)).toHaveAttribute("data-state", "stale", {
    timeout: 30_000,
  });
  await expect(page.getByTestId(`mf-axis-${aFrame}-camera`)).toHaveAttribute("data-state", "fresh");
});

test("I — restore Shot camera on open: no Set save, not dirty; moving it changes nothing until linked", async ({
  page,
}) => {
  test.setTimeout(240_000);
  // the saved Set's working camera is B's (x = -2); A's bookmark is x = 1
  await openWorkspace(page, A);
  const revision = await attr(page, "data-revision");
  const saved = await attr(page, "data-saved-fingerprint");
  await expect(page.getByTestId("camera-pos-x")).toHaveValue(aCameraX); // A's camera is in the viewport
  await expect(set(page)).toHaveAttribute("data-camera-restored", "true");
  await expect(page.getByTestId("camera-restored-note")).toBeVisible();
  await expect(set(page)).toHaveAttribute("data-dirty", "false");
  await expect(page.getByTestId("shared-set-warning")).toHaveCount(0);
  await expect(set(page)).not.toHaveAttribute("data-live-fingerprint", "");
  expect(await attr(page, "data-live-fingerprint")).not.toBe(saved); // really a different camera than the saved Set

  // the server's Set did not move
  await openLocationPage(page, B);
  await expect(set(page)).toHaveAttribute("data-revision", revision);
  await expect(set(page)).toHaveAttribute("data-saved-fingerprint", saved);
  await expect(page.getByTestId("camera-pos-x")).toHaveValue("-2"); // the Location page keeps the saved camera

  // moving the working camera is a Set change (existing production-camera rule), never a bookmark change
  await openWorkspace(page, A);
  await setInput(page, "camera-pos-x", "5");
  await expect(set(page)).toHaveAttribute("data-dirty", "true", { timeout: 10_000 });
  await page.reload(); // not saved, not linked
  await ready(page);
  await expect(page.getByTestId("camera-pos-x")).toHaveValue(aCameraX); // A's bookmark is unchanged
  await expect(set(page)).toHaveAttribute("data-revision", revision);
});

test("B — Location selector A → B is a navigation and a remount; no A state; back / forward", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const urlA = await openLocationPage(page, A);
  await expect(set(page)).toHaveAttribute("data-mode", "location");
  await expect(set(page)).toHaveAttribute("data-shot-id", A.id);
  const bFrames = async () => {
    await expect(set(page)).toHaveAttribute("data-shot-id", B.id, { timeout: 60_000 });
    await ready(page);
    await expect(page.getByTestId("bookmark-info")).toBeVisible();
    expect(await lightingFp(page)).toBe(bLightFp);
    await expect(page.getByTestId("blocking-figure")).toHaveCount(1);
    await expect(page.getByTestId("blocking-figure").first()).toContainText("Sean");
    const ids = await workspaceFrames(page);
    expect(ids).toHaveLength(1);
    expect(ids).not.toContain(aFrame);
    expect(await page.getByTestId("set-canvas").count()).toBe(1); // one editor, one engine canvas
  };
  const aState = async () => {
    await expect(set(page)).toHaveAttribute("data-shot-id", A.id, { timeout: 60_000 });
    await ready(page);
    expect(await lightingFp(page)).toBe(aLightFp);
    await expect(page.getByTestId("blocking-figure")).toHaveCount(1);
    await expect(page.getByTestId("blocking-figure").first()).toContainText("Yumeko");
    expect(await workspaceFrames(page)).toEqual([aFrame]);
    expect(await page.getByTestId("set-canvas").count()).toBe(1);
  };
  await aState();

  await page.getByTestId("shot-select").selectOption(B.id);
  await expect(page).toHaveURL(new RegExp(`[?&]shot=${B.id}`), { timeout: 60_000 });
  await bFrames();

  // browser Back: A reloads correctly (a remount, no B state)
  await page.goBack();
  await expect(page).toHaveURL(urlA);
  await aState();
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`[?&]shot=${B.id}`));
  await bFrames();

  // and the selector B → A
  await page.getByTestId("shot-select").selectOption(A.id);
  await expect(page).toHaveURL(new RegExp(`[?&]shot=${A.id}`), { timeout: 60_000 });
  await aState();
});

test("C — dirty Set switch: Stay keeps the unsaved edit; Discard and switch navigates and saves nothing", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await openLocationPage(page, A);
  const revision = await attr(page, "data-revision");
  const objects = Number(await attr(page, "data-object-count"));
  await page.getByTestId("add-box").click();
  await expect(set(page)).toHaveAttribute("data-dirty", "true", { timeout: 10_000 });
  await expect(set(page)).toHaveAttribute("data-object-count", String(objects + 1));

  await page.getByTestId("shot-select").selectOption(B.id);
  await expect(page.getByTestId("shot-switch-confirm")).toContainText(
    "You have unsaved 3D Set changes. Switching Shots will discard them.",
  );
  await expect(page).toHaveURL(new RegExp(`[?&]shot=${A.id}`));
  await page.getByTestId("shot-switch-stay").click();
  await expect(page.getByTestId("shot-switch-confirm")).toHaveCount(0);
  await expect(page.getByTestId("shot-select")).toHaveValue(A.id);
  await expect(set(page)).toHaveAttribute("data-shot-id", A.id);
  await expect(set(page)).toHaveAttribute("data-dirty", "true");
  await expect(set(page)).toHaveAttribute("data-object-count", String(objects + 1));

  await page.getByTestId("shot-select").selectOption(B.id);
  await page.getByTestId("shot-switch-discard").click();
  await expect(page).toHaveURL(new RegExp(`[?&]shot=${B.id}`), { timeout: 60_000 });
  await expect(set(page)).toHaveAttribute("data-shot-id", B.id, { timeout: 60_000 });
  await ready(page);
  await expect(set(page)).toHaveAttribute("data-dirty", "false");
  await expect(set(page)).toHaveAttribute("data-revision", revision); // the unsaved A edit was not saved
  await expect(set(page)).toHaveAttribute("data-object-count", String(objects));
});

test("C2 — immediate switch (release blocker): an edit made just before choosing a Shot is never discarded silently", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const confirm = page.getByTestId("shot-switch-confirm");
  await openLocationPage(page, A);
  const revision = await attr(page, "data-revision");
  const objects = Number(await attr(page, "data-object-count"));

  // geometry: choose B IMMEDIATELY after the edit. Deliberately no wait for data-dirty, the dirty badge or the
  // debounced fingerprint: the switch must read the Set as it is at the click
  await page.getByTestId("add-box").click();
  await page.getByTestId("shot-select").selectOption(B.id);
  await expect(confirm).toContainText("You have unsaved 3D Set changes. Switching Shots will discard them.");
  await page.getByTestId("shot-switch-stay").click();
  await expect(confirm).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`[?&]shot=${A.id}`));
  await expect(set(page)).toHaveAttribute("data-shot-id", A.id);
  await expect(set(page)).toHaveAttribute("data-object-count", String(objects + 1)); // the edit is still there

  await page.getByTestId("shot-select").selectOption(B.id);
  await expect(confirm).toBeVisible();
  await page.getByTestId("shot-switch-discard").click();
  await expect(page).toHaveURL(new RegExp(`[?&]shot=${B.id}`), { timeout: 60_000 });
  await expect(set(page)).toHaveAttribute("data-shot-id", B.id, { timeout: 60_000 });
  await ready(page);
  await expect(set(page)).toHaveAttribute("data-dirty", "false");
  await expect(set(page)).toHaveAttribute("data-revision", revision); // loaded from the saved set: nothing was saved
  await expect(set(page)).toHaveAttribute("data-object-count", String(objects));

  // skybox-only (base environment, Location-owned): the same immediate switch asks first
  await hook(page, ["spatial", "setSkyboxId"], "e2e-sky-immediate");
  await page.getByTestId("shot-select").selectOption(A.id);
  await expect(confirm).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`[?&]shot=${B.id}`));
  await page.getByTestId("shot-switch-discard").click();
  await expect(page).toHaveURL(new RegExp(`[?&]shot=${A.id}`), { timeout: 60_000 });
  await expect(set(page)).toHaveAttribute("data-shot-id", A.id, { timeout: 60_000 });
  await ready(page);
  await expect(set(page)).toHaveAttribute("data-dirty", "false");
  await expect(set(page)).toHaveAttribute("data-revision", revision);
});

let bFrame = "";

test("J — workspace Master Frame → Production Frame (the same promotion action as Shot Prep)", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await openWorkspace(page, B);
  [bFrame] = await workspaceFrames(page);
  for (const axis of ["scene", "camera", "blocking", "lighting"])
    await expect(page.getByTestId(`mf-axis-${bFrame}-${axis}`)).toHaveAttribute("data-state", "fresh", {
      timeout: 30_000,
    });
  await page.getByTestId(`pf-use-master-${bFrame}`).click();
  await expect(page.getByTestId(`pf-master-row-${bFrame}`).getByTestId("pf-master-promoted")).toBeVisible({
    timeout: 30_000,
  });
  const p = await pkg(page, B.id);
  expect(p.references.productionFrame!.sourceSpatial!.masterFrameId).toBe(bFrame);

  // Shot Prep shows the lineage and the four axes of every Master Frame (server-computed)
  await page.goto(`${B.prepUrl}?section=production_frame`);
  await expect(page.getByTestId("pf-selected")).toHaveAttribute("data-source", "previs_master");
  await expect(page.getByTestId("pf-lineage-source")).toContainText("From 3D Master Frame captured");
  await expect(page.getByTestId("pf-lineage-open-workspace")).toHaveAttribute(
    "href",
    /\/shots\/[0-9a-f-]{36}\/spatial$/,
  );
  await expect(page.getByTestId(`pf-master-axes-${bFrame}-scene`)).toHaveAttribute("data-state", "fresh");
  await expect(page.getByTestId("pf-master-thumb").first()).toBeVisible();
  await expect(page.getByTestId(`pf-master-open-workspace-${bFrame}`)).toBeVisible();
});

test("K — stale Use anyway in the workspace; a digest that changed meanwhile asks again", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await openWorkspace(page, A); // A's frame is STALE SCENE since B's Set save
  const confirm = page.getByTestId(`pf-master-confirm-${aFrame}`);
  await page.getByTestId(`pf-use-master-${aFrame}`).click();
  await expect(confirm).toContainText("STALE SCENE", { timeout: 30_000 });
  expect((await pkg(page, A.id)).references.productionFrame).toBeUndefined();

  // the 3D setup changes after the user saw the reasons: the old digest promotes nothing, the new reasons are shown
  await saveLight(page, "260");
  await page.getByTestId(`pf-use-master-anyway-${aFrame}`).click();
  await expect(confirm).toContainText("STALE LIGHTING", { timeout: 30_000 });
  expect((await pkg(page, A.id)).references.productionFrame).toBeUndefined();
  await page.getByTestId(`pf-use-master-anyway-${aFrame}`).click();
  await expect(page.getByTestId(`pf-master-row-${aFrame}`).getByTestId("pf-master-promoted")).toBeVisible({
    timeout: 30_000,
  });
  expect((await pkg(page, A.id)).references.productionFrame!.sourceSpatial!.masterFrameId).toBe(aFrame);
});

test("L — missing source Master Frame: the Production Frame and its frozen lineage stay; nothing breaks", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const r = await page.request.post("/api/dev/previs/master-frame-fixture", {
    data: { action: "delete", masterFrameId: bFrame },
  });
  expect(r.ok()).toBe(true);
  await page.goto(`${B.prepUrl}?section=production_frame`);
  await expect(page.getByTestId("pf-selected")).toHaveAttribute("data-source", "previs_master");
  await expect(page.getByTestId("pf-lineage-missing")).toHaveText(
    "Source Master Frame no longer exists; frozen source provenance retained.",
  );
  await expect(page.getByTestId("pf-lineage-provenance")).toBeAttached();
  expect((await pkg(page, B.id)).references.productionFrame!.sourceSpatial!.masterFrameId).toBe(bFrame);
  await openWorkspace(page, B); // no throw, no 404
  expect(await workspaceFrames(page)).toEqual([]);
});

test("F — Create 3D Set from the Shot route: THE Location's set, the same row the Location page opens", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const s = await shotOf(page, "3A"); // Grand Celeste Lobby: no 3D set yet
  await openWorkspace(page, s);
  await expect(page.getByTestId("new-set-state")).toBeVisible();
  await expect(page.getByTestId("save-set")).toHaveText("Create 3D Set");
  await expect(set(page)).toHaveAttribute("data-scene-document-id", "");
  await expect(set(page)).toHaveAttribute("data-revision", "");
  await page.getByTestId("load-test-set").click();
  await expect(page.getByTestId("set-status")).toContainText("Hotel Canopy", { timeout: 30_000 });
  await saveSet(page, "Saved — revision 1 (3D Set created)");
  const id = await attr(page, "data-scene-document-id");
  const fp = await attr(page, "data-saved-fingerprint");
  expect(id).not.toBe("");
  await expect(page.getByTestId("new-set-state")).toHaveCount(0);

  await openLocationPage(page, s);
  await expect(set(page)).toHaveAttribute("data-mode", "location");
  await expect(set(page)).toHaveAttribute("data-scene-document-id", id);
  await expect(set(page)).toHaveAttribute("data-revision", "1");
  await expect(set(page)).toHaveAttribute("data-saved-fingerprint", fp);
});

test("G — no Location: the optional spatial empty state, no editor; the image-first path still works", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const s = await shotOf(page, "5A");
  await assignLocation(page, s, null);
  await page.goto(s.spatialUrl);
  await expect(page.getByTestId("workspace-no-location")).toContainText(
    "Assign a Location to use optional spatial tools.",
  );
  await expect(set(page)).toHaveCount(0);
  await expect(page.getByTestId("set-canvas")).toHaveCount(0);
  await page.getByTestId("assign-location-link").click();
  await page.waitForURL(new RegExp(`/shots/${s.id}\\?section=set$`));
  await expect(page.getByTestId("shot-no-location")).toBeVisible();

  await page.goto(`${s.prepUrl}?section=production_frame`);
  await page.getByTestId("pf-upload-file").setInputFiles({
    name: "e2e-4c2-no-location.png",
    mimeType: "image/png",
    buffer: png(956, 400, [60, 90, 140]),
  });
  await page.getByTestId("pf-upload-submit").click();
  await expect(page.getByTestId("pf-selected")).toHaveAttribute("data-source", "upload", { timeout: 30_000 });
  expect((await pkg(page, s.id)).spatialReference).toBeUndefined();
});

test("H — Location reassignment: the workspace opens the CURRENT Location; old rows are history only", async ({
  page,
}) => {
  test.setTimeout(420_000);
  const s = await shotOf(page, "4A"); // Sky-View Restaurant (L1)
  await openWorkspace(page, s);
  await page.getByTestId("load-test-set").click();
  await expect(page.getByTestId("set-status")).toContainText("Hotel Canopy", { timeout: 30_000 });
  await saveSet(page, "3D Set created");
  const l1Scene = await attr(page, "data-scene-document-id");
  const l1Url = (await openLocationPage(page, s)).toString();
  await openWorkspace(page, s);
  await link(page);
  await block(page, "Yumeko", "1.5");
  await saveLight(page, "120");
  await capture(page);
  const [l1Frame] = await workspaceFrames(page);
  expect((await pkg(page, s.id)).spatialReference!.locationId).toBeTruthy();

  // reassign to L2 (Black Luxury Sedan, no 3D set) through Shot Prep
  await assignLocation(page, s, "Black Luxury Sedan");
  await openWorkspace(page, s);
  await expect(page.getByRole("heading", { name: "Spatial Workspace — Shot 4A" })).toBeVisible();
  await expect(page.getByText("Black Luxury Sedan", { exact: false }).first()).toBeVisible();
  await expect(set(page)).not.toHaveAttribute("data-scene-document-id", l1Scene);
  await expect(page.getByTestId("new-set-state")).toBeVisible();
  // none of L1's Shot-owned rows is working state on L2
  await expect(page.getByTestId("bookmark-info")).toHaveCount(0);
  expect(await figures(page)).toEqual([]);
  expect((await hook<{ applied: string | null }>(page, ["lightingInfo"])).applied).toBeNull();
  await expect(page.getByTestId("shot-lighting")).toHaveAttribute("data-dirty", "false");
  // the L1 frame is history: listed, marked, and stale against L2
  expect(await workspaceFrames(page)).toEqual([l1Frame]);
  await expect(page.getByTestId("master-frame-other-set")).toBeVisible();
  await expect(page.getByTestId(`mf-axis-${l1Frame}-scene`)).toHaveAttribute("data-state", "stale");
  expect((await pkg(page, s.id)).spatialReference).toBeUndefined(); // L2 has no setup yet

  // capture can never use L1
  await page.goto(l1Url);
  await ready(page);
  await page.getByTestId("capture-master-frame").click();
  await expect(page.getByTestId("set-status")).toContainText("different location", { timeout: 60_000 });

  // L2 gets its own set and camera: it becomes the current spatial reference, and its capture is fresh
  await openWorkspace(page, s);
  await page.getByTestId("load-test-set").click();
  await expect(page.getByTestId("set-status")).toContainText("Hotel Canopy", { timeout: 30_000 });
  await saveSet(page, "3D Set created");
  await link(page);
  const ref = (await pkg(page, s.id)).spatialReference!;
  expect(ref).toBeDefined();
  // the L1 rig never lights L2 (I1 refuses a capture until the Shot's lighting is authored on this set): the panel
  // says so, the user clears it, then lights the Shot here
  await expect(page.getByTestId("lighting-elsewhere")).toBeVisible();
  await page.getByTestId("lighting-clear").click();
  await expect(page.getByTestId("lighting-elsewhere")).toHaveCount(0, { timeout: 30_000 });
  await saveLight(page, "90");
  await capture(page);
  const ids = await workspaceFrames(page);
  expect(ids).toHaveLength(2);
  const l2Frame = ids.find((x) => x !== l1Frame)!;
  await expect(page.getByTestId(`mf-axis-${l2Frame}-scene`)).toHaveAttribute("data-state", "fresh", {
    timeout: 30_000,
  });
  await expect(page.getByTestId(`mf-axis-${l1Frame}-scene`)).toHaveAttribute("data-state", "stale");
  // a blocking save on L2 replaces the L1 row (no false conflict)
  await block(page, "Yumeko", "-0.5");
});
