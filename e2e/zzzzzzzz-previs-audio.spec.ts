import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { ALL_FORMATS, BufferSource, Input } from "mediabunny";

/**
 * Phase 2F M2A.1 — performance audio muxed into the local previs (memory mode, no provider calls).
 *
 * The seeded take audio has no stored file, and no audio fixture is committed: the test synthesises WAV tones in
 * Node and serves them to the app's own authenticated asset fetch (page.route on fetch() requests only). The app
 * then fetches, verifies, decodes and composes them locally, and MediaBunny muxes them into the previs.
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
const RATE = 48_000;

/** 16-bit mono PCM WAV of a sine tone, generated at runtime (nothing binary is committed). */
function wav(freq: number, ms: number): Buffer {
  const n = Math.round((ms / 1000) * RATE);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++)
    data.writeInt16LE(Math.round(0.6 * 32767 * Math.sin((2 * Math.PI * freq * i) / RATE)), i * 2);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(RATE, 24);
  head.writeUInt32LE(RATE * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}
const freqFor = (assetId: string) => 300 + (createHash("sha1").update(assetId).digest()[0]! % 5) * 110;

/** Serve a generated tone for take audio fetched by the app (fetch()), and leave media elements alone. */
async function serveTakeAudio(page: Page, log: string[]) {
  await page.route(/\/api\/assets\/[0-9a-f-]{36}$/, async (route) => {
    if (route.request().resourceType() !== "fetch") return route.fallback();
    const id = route.request().url().split("/").pop()!;
    log.push(id);
    await route.fulfill({ status: 200, contentType: "audio/wav", body: wav(freqFor(id), 6000) });
  });
}

async function openSet(page: Page, code: string) {
  await page.goto(`${EP}/shots`);
  await page.getByRole("link", { name: code, exact: true }).click();
  await page.waitForURL(/\/shots\/[0-9a-f-]{36}/);
  const shotUrl = page.url().split("?")[0]!;
  await page.goto(`${shotUrl}?section=set`);
  await page.getByTestId("open-in-3d-set").click();
  await page.waitForURL(/\/locations\/[0-9a-f-]{36}\/3d\?shot=/);
  await expect(page.getByTestId("virtual-set")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
  return { shotUrl, setUrl: page.url(), shotId: /\/shots\/([0-9a-f-]{36})/.exec(shotUrl)![1]! };
}

const setInput = async (page: Page, testId: string, value: string) => {
  const input = page.getByTestId(testId);
  await input.fill(value);
  await input.press("Enter");
};

/** A two-keyframe path across the Shot's own duration, saved (idempotent when one already exists). */
async function ensurePath(page: Page) {
  if ((await page.getByTestId("kf-marker").count()) >= 2) return;
  if ((await page.getByTestId("create-camera-path").count()) === 0) return;
  const set = page.getByTestId("virtual-set");
  if ((await set.getAttribute("data-object-count")) === "0") await page.getByTestId("load-test-set").click();
  await setInput(page, "camera-pos-x", "3");
  await setInput(page, "camera-pos-z", "9");
  await setInput(page, "camera-focal", "35");
  await page.getByTestId("create-camera-path").click();
  await expect(page.getByTestId("kf-marker")).toHaveCount(1);
  await setInput(page, "camera-pos-x", "0");
  await setInput(page, "camera-pos-z", "2");
  await setInput(page, "camera-focal", "60");
  await page.getByTestId("to-end").click();
  await page.getByTestId("kf-add").click();
  await expect(page.getByTestId("kf-marker")).toHaveCount(2);
  await page.getByTestId("save-path").click();
  await expect(page.getByTestId("path-status")).toContainText(/Camera path saved/, { timeout: 60_000 });
}

async function encoderSupport(page: Page) {
  return page.evaluate(async () => {
    const ok = async (codec: string) => {
      try {
        return Boolean(
          (
            await AudioEncoder.isConfigSupported({
              codec,
              numberOfChannels: 2,
              sampleRate: 48000,
              bitrate: 128000,
            })
          ).supported,
        );
      } catch {
        return false;
      }
    };
    return { aac: await ok("mp4a.40.2"), opus: await ok("opus") };
  });
}

/** Demux the stored file in Node (no decoding): tracks, codecs and duration. */
async function inspect(bytes: Uint8Array) {
  const input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
  const video = await input.getPrimaryVideoTrack();
  const audio = await input.getPrimaryAudioTrack();
  return {
    format: (await input.getFormat()).name,
    videoCodec: video?.codec ?? null,
    audioCodec: audio?.codec ?? null,
    audioChannels: audio?.numberOfChannels ?? null,
    audioRate: audio?.sampleRate ?? null,
    duration: await input.computeDuration(),
  };
}

/** Decode the stored file in the browser and measure RMS in the given [fromMs, toMs] windows. */
async function windowRms(page: Page, bytes: Uint8Array, windows: Array<[number, number]>) {
  return page.evaluate(
    async ({ b64, windows }) => {
      // the file's bytes come from Node (a fetch here would hit the take-audio route stub)
      const buf = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
      const ctx = new OfflineAudioContext(2, 1, 48000);
      const audio = await ctx.decodeAudioData(buf);
      const ch = audio.getChannelData(0);
      return {
        seconds: audio.duration,
        channels: audio.numberOfChannels,
        rms: windows.map(([a, b]) => {
          const from = Math.floor((a / 1000) * audio.sampleRate);
          const to = Math.min(ch.length, Math.floor((b / 1000) * audio.sampleRate));
          let sum = 0;
          for (let i = from; i < to; i++) sum += ch[i]! * ch[i]!;
          return Math.sqrt(sum / Math.max(1, to - from));
        }),
      };
    },
    { b64: Buffer.from(bytes).toString("base64"), windows },
  );
}

const render = async (page: Page, timeout = 420_000) => {
  await page.getByTestId("render-previs").click();
  await expect(page.getByTestId("path-status")).toContainText(/Previs saved privately/, { timeout });
};

type Pkg = {
  spatialReference?: {
    cameraMotion?: {
      previsAssetId: string | null;
      previs?: { assetId: string; hasAudio: boolean; audioMixFingerprint: string | null };
    };
  };
};

test.describe("performance audio in the local previs", () => {
  let setUrl = "";
  let shotUrl = "";
  let shotId = "";

  test("renders a previs WITH the selected performance audio: tracks, timing, private asset, same origin", async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(480_000);
    const origin = new URL(baseURL!).origin;
    const foreign: string[] = [];
    page.on("request", (r) => {
      const u = r.url();
      if (u.startsWith("data:") || u.startsWith("blob:")) return;
      if (new URL(u).origin !== origin) foreign.push(u);
    });
    const served: string[] = [];
    await serveTakeAudio(page, served);
    const opened = await openSet(page, "3A");
    ({ setUrl, shotUrl, shotId } = opened);
    await ensurePath(page);

    // the option is offered, on by default, and the summary says what will be rendered
    await expect(page.getByTestId("include-audio")).toBeEnabled();
    await expect(page.getByTestId("include-audio")).toBeChecked();
    await expect(page.getByTestId("previs-audio-summary")).toContainText(
      "Selected performance · 48 kHz stereo",
    );
    await expect(page.getByTestId("previs-render-summary")).toContainText("956×400");

    const support = await encoderSupport(page);
    await render(page);
    const statusText = (await page.getByTestId("path-status").textContent()) ?? "";
    const src = (await page.getByTestId("previs-video").getAttribute("src"))!;
    const body = new Uint8Array(await (await page.request.get(src)).body());
    const info = await inspect(body);
    expect(info.videoCodec).not.toBeNull();

    if (support.aac || support.opus) {
      // audio-capable browser: the file really contains an audio track on the Shot timeline
      expect(statusText).toContain("with performance audio");
      expect(info.audioCodec).toMatch(/aac|opus/);
      expect(info.audioRate).toBe(48000);
      expect(info.audioChannels).toBe(2);
      expect(served.length).toBeGreaterThan(0); // take audio went through the app's own asset fetch
      await expect(page.getByTestId("previs-player")).toContainText("with audio");

      // 3A: pre-roll 0.8 s, selected take 0.8–3.6 s, then silence to the end of the path
      const m = await windowRms(page, body, [
        [100, 600], // pre-roll
        [1100, 3300], // the take
        [3900, 4300], // after the take
      ]);
      expect(m.channels).toBeGreaterThanOrEqual(1);
      expect(m.rms[0]).toBeLessThan(0.02);
      expect(m.rms[1]).toBeGreaterThan(0.15);
      expect(m.rms[2]).toBeLessThan(0.02);
      // audio and video share the Shot timebase (container/codec rounding only)
      expect(Math.abs(m.seconds - info.duration)).toBeLessThan(0.25);
    } else {
      // no audio encoder here: the app said so and rendered a silent file instead of pretending
      expect(statusText).toContain("silent");
      expect(info.audioCodec).toBeNull();
    }
    await expect(page.getByTestId("previs-current")).toBeVisible();
    expect(foreign, "no request leaves the origin").toEqual([]);

    // the package says the referenced previs has audio and which mix
    const pkg = (await (
      await page.request.get(`/api/projects/ojousama/shots/${shotId}/package`)
    ).json()) as Pkg;
    const motion = pkg.spatialReference!.cameraMotion!;
    expect(motion.previs?.assetId).toBe(motion.previsAssetId);
    if (support.aac || support.opus) {
      expect(motion.previs?.hasAudio).toBe(true);
      expect(motion.previs?.audioMixFingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("audio edits stale an audio previs but not a silent one; history is kept", async ({ page }) => {
    test.skip(!setUrl, "needs the first test");
    test.setTimeout(900_000);
    const served: string[] = [];
    await serveTakeAudio(page, served);

    // a silent camera test, rendered after the audio previs
    await page.goto(setUrl);
    await expect(page.getByTestId("virtual-set")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    const support = await encoderSupport(page);
    test.skip(!support.aac && !support.opus, "no browser audio encoder in this Chromium");
    await expect(page.getByTestId("previs-video")).toBeVisible(); // navigated away and back: it plays from storage
    await page.getByTestId("include-audio").uncheck();
    await expect(page.getByTestId("previs-audio-summary")).toContainText("Silent");
    await render(page);
    await expect(page.getByTestId("path-status")).toContainText("silent");
    await expect(page.getByTestId("previs-player")).toContainText("silent");

    // change the selected take of 3A's dialogue line
    const select = async (n: number) => {
      await page.goto(`${EP}/perform`);
      const card = page.locator("article", { hasText: "もう帰りたい" }).first();
      await card
        .locator("div", { hasText: new RegExp(`^#${n}`) })
        .getByRole("button", { name: "Select" })
        .first()
        .click();
      await expect(card.getByText(new RegExp(`canonical: take ${n}`))).toBeVisible();
    };
    await select(3);

    await page.goto(setUrl);
    await expect(page.getByTestId("virtual-set")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    // the newest previs is the silent one: still current. The audio one is stale (history).
    await expect(page.getByTestId("previs-current")).toBeVisible();
    const history = page.getByTestId("previs-history-item");
    await expect(history.filter({ hasText: "with audio" }).first()).toContainText("stale");
    await page.goto(`${shotUrl}?section=set`);
    await expect(page.getByTestId("shot-previs-stale")).toHaveCount(0); // latest (silent) is valid

    // render a new audio previs for the new take: both generations stay in history
    await page.goto(setUrl);
    await expect(page.getByTestId("virtual-set")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    await expect(page.getByTestId("include-audio")).toBeChecked(); // default is on again after a reload
    await render(page);
    await expect(page.getByTestId("path-status")).toContainText("with performance audio");
    await expect(page.getByTestId("previs-current")).toBeVisible();
    expect(await history.count()).toBeGreaterThanOrEqual(2);
    const pkg = (await (
      await page.request.get(`/api/projects/ojousama/shots/${shotId}/package`)
    ).json()) as Pkg;
    expect(pkg.spatialReference!.cameraMotion!.previs?.hasAudio).toBe(true);

    // and when the selection changes back, the new audio previs is stale while the silent one stands
    await select(1);
    await page.goto(setUrl);
    await expect(page.getByTestId("virtual-set")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    await expect(page.getByTestId("previs-stale")).toContainText("STALE AUDIO");
    await page.goto(`${shotUrl}?section=set`);
    await expect(page.getByTestId("shot-previs-stale")).toContainText("STALE AUDIO");
    const pkg2 = (await (
      await page.request.get(`/api/projects/ojousama/shots/${shotId}/package`)
    ).json()) as Pkg;
    // the package falls back to a previs that is still exactly current (the silent camera test) — never a stale mix
    expect(pkg2.spatialReference!.cameraMotion!.previs?.hasAudio ?? false).toBe(false);
  });

  test("two takes: pre-roll, take, a silent gap, take, post-roll on the Shot timeline", async ({ page }) => {
    test.setTimeout(600_000);
    const served: string[] = [];
    await serveTakeAudio(page, served);
    await openSet(page, "5A");
    const support = await encoderSupport(page);
    test.skip(!support.aac && !support.opus, "no browser audio encoder in this Chromium");

    await ensurePath(page);
    await expect(page.getByTestId("previs-audio-summary")).toContainText("Selected performance");
    await render(page, 540_000);
    const src = (await page.getByTestId("previs-video").getAttribute("src"))!;
    // 5A: pre-roll 0.4 · take 0.4–3.0 · gap 3.0–3.6 · take 3.6–5.9 · post-roll to 6.8 s
    const body = new Uint8Array(await (await page.request.get(src)).body());
    const m = await windowRms(page, body, [
      [50, 300],
      [700, 2800],
      [3150, 3450],
      [3900, 5700],
      [6100, 6600],
    ]);
    expect(m.rms[0]).toBeLessThan(0.02);
    expect(m.rms[1]).toBeGreaterThan(0.15);
    expect(m.rms[2]).toBeLessThan(0.02);
    expect(m.rms[3]).toBeGreaterThan(0.15);
    expect(m.rms[4]).toBeLessThan(0.02);
    expect(served.length).toBeGreaterThanOrEqual(2);
  });

  test("a Shot with no selected performance audio disables the option and says why", async ({ page }) => {
    test.setTimeout(180_000);
    await openSet(page, "1A");
    await ensurePath(page);
    await expect(page.getByTestId("include-audio")).toBeDisabled();
    await expect(page.getByTestId("include-audio-disabled")).toContainText(
      "No selected performance audio for this Shot.",
    );
    await expect(page.getByTestId("previs-audio-summary")).toContainText("Silent");
  });

  test("a take that cannot be read stops the render; dialogue is never silently dropped", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.route(/\/api\/assets\/[0-9a-f-]{36}$/, async (route) => {
      if (route.request().resourceType() !== "fetch") return route.fallback();
      await route.fulfill({ status: 200, contentType: "audio/wav", body: Buffer.from("not audio") });
    });
    await openSet(page, "2D");
    const support = await encoderSupport(page);
    test.skip(!support.aac && !support.opus, "no browser audio encoder in this Chromium");

    await ensurePath(page);
    await page.getByTestId("render-previs").click();
    await expect(page.getByTestId("path-status")).toContainText(/could not decode the selected take audio/i, {
      timeout: 60_000,
    });
    await expect(page.getByTestId("path-status")).not.toContainText(/http|token/i);
    await expect(page.getByTestId("previs-video")).toHaveCount(0);
  });
});
