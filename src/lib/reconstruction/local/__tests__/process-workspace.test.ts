import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { materializeInputs, sha256File, validateInputList } from "../inputs";
import { runProcess } from "../process";
import { LocalReconstructionError, type LocalReconstructionInput } from "../types";
import {
  assertContained,
  cleanupWorkspace,
  createWorkspace,
  defaultWorkRoot,
  directoryBytes,
  inWorkspace,
  resolveWorkRoot,
} from "../workspace";
import { jpegBytes, PNG_BYTES, tempDir } from "./fixtures";

let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups) await c();
  cleanups = [];
});
async function dir() {
  const t = await tempDir();
  cleanups.push(t.cleanup);
  return t.dir;
}
const node = process.execPath;
const script = async (d: string, body: string) => {
  const f = path.join(d, `s${Math.random().toString(36).slice(2)}.cjs`);
  await writeFile(f, body);
  return f;
};

describe("process runner (shell: false, bounded, abortable)", () => {
  it("runs an absolute executable with an argv array; arguments are never interpreted by a shell", async () => {
    const d = await dir();
    const s = await script(d, "process.stdout.write(JSON.stringify(process.argv.slice(2))); process.exit(3)");
    const hostile = ['a b"; rm -rf / #', "$(whoami)", "%PATH%", "`id`", "& calc.exe"];
    const r = await runProcess({ executable: node, args: [s, ...hostile], cwd: d, timeoutMs: 20_000 });
    expect(r).toMatchObject({ outcome: "exited", exitCode: 3, spawnError: null });
    expect(JSON.parse(r.stdout)).toEqual(hostile);
    expect(r.pid).toBeGreaterThan(0);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    expect(Date.parse(r.startedAt)).not.toBeNaN();
  }, 60_000);

  it("refuses a relative executable or working directory (never resolved from the current directory)", async () => {
    const d = await dir();
    expect((await runProcess({ executable: "node", args: [], cwd: d, timeoutMs: 1000 })).outcome).toBe(
      "spawn_failed",
    );
    expect((await runProcess({ executable: node, args: [], cwd: ".", timeoutMs: 1000 })).outcome).toBe(
      "spawn_failed",
    );
    const missing = await runProcess({
      executable: path.join(d, "nope.exe"),
      args: [],
      cwd: d,
      timeoutMs: 1000,
    });
    expect(missing.outcome).toBe("spawn_failed");
  }, 60_000);

  it("keeps only a bounded TAIL of output and still reports lines", async () => {
    const d = await dir();
    const s = await script(
      d,
      "for (let i=0;i<20000;i++) process.stdout.write('line ' + i + '\\n'); process.stderr.write('oops\\n');",
    );
    const lines: string[] = [];
    const r = await runProcess({
      executable: node,
      args: [s],
      cwd: d,
      timeoutMs: 20_000,
      maxOutputBytes: 1024,
      onLine: (stream, l) => stream === "stdout" && lines.push(l),
    });
    expect(r.exitCode).toBe(0);
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBeLessThanOrEqual(1024);
    expect(r.stdout).toContain("line 19999");
    expect(r.stderr).toBe("oops\n");
    expect(lines.length).toBe(20000);
  }, 60_000);

  it("times out and aborts: the process (tree) is stopped and the outcome says why", async () => {
    const d = await dir();
    const s = await script(d, "setInterval(() => {}, 1000)");
    const t = await runProcess({ executable: node, args: [s], cwd: d, timeoutMs: 300, killGraceMs: 500 });
    expect(t.outcome).toBe("timeout");
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const a = await runProcess({
      executable: node,
      args: [s],
      cwd: d,
      timeoutMs: 20_000,
      signal: ac.signal,
      killGraceMs: 500,
    });
    expect(a.outcome).toBe("aborted");
    const pre = new AbortController();
    pre.abort();
    expect(
      (await runProcess({ executable: node, args: [s], cwd: d, timeoutMs: 1000, signal: pre.signal }))
        .outcome,
    ).toBe("aborted");
  }, 30_000);

  it("passes only a minimal environment (no secrets reach an external tool)", async () => {
    const d = await dir();
    process.env.PRISM_TEST_SECRET_KEY = "sk-should-not-leak";
    try {
      const s = await script(
        d,
        "process.stdout.write(String(process.env.PRISM_TEST_SECRET_KEY) + '|' + process.env.EXTRA)",
      );
      const r = await runProcess({
        executable: node,
        args: [s],
        cwd: d,
        timeoutMs: 20_000,
        env: { EXTRA: "yes" },
      });
      expect(r.stdout).toBe("undefined|yes");
    } finally {
      delete process.env.PRISM_TEST_SECRET_KEY;
    }
  }, 60_000);
});

describe("workspace", () => {
  it("resolves the work root: explicit absolute, per-user default, never relative, never inside the repository", () => {
    expect(() => resolveWorkRoot({ PRISM_LOCAL_RECONSTRUCTION_ROOT: "relative/dir" })).toThrow(/absolute/);
    expect(() =>
      resolveWorkRoot({ PRISM_LOCAL_RECONSTRUCTION_ROOT: path.join(process.cwd(), "public", "x") }),
    ).toThrow(/outside the Prism repository/);
    const abs = path.resolve(path.parse(process.cwd()).root, "prism-work-root-test");
    expect(resolveWorkRoot({ PRISM_LOCAL_RECONSTRUCTION_ROOT: abs })).toBe(abs);
    expect(defaultWorkRoot({ LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, "win32")).toBe(
      path.join("C:\\Users\\u\\AppData\\Local", "PrismStudio", "local-reconstruction"),
    );
    expect(defaultWorkRoot({ HOME: "/home/u" }, "linux")).toBe(
      path.join("/home/u", ".cache", "prism-studio", "local-reconstruction"),
    );
  }, 60_000);

  it("creates an isolated, fresh run directory; refuses unsafe run ids, reuse and path escapes", async () => {
    const root = await dir();
    const ws = await createWorkspace(root, "run-1");
    expect((await readdir(ws.dir)).sort()).toEqual(["brush", "colmap", "input", "logs", "output"]);
    await expect(createWorkspace(root, "run-1")).rejects.toThrow(/already exists/);
    for (const bad of ["../x", "a/b", "", "-x", "x".repeat(65), "a b", "C:\\x"])
      await expect(createWorkspace(root, bad)).rejects.toBeInstanceOf(LocalReconstructionError);
    expect(() => inWorkspace(ws, "..", "escape")).toThrow(/escaped/);
    expect(() => inWorkspace(ws, path.resolve("/etc/passwd"))).toThrow(/escaped/);
    expect(inWorkspace(ws, "output", "a.spz")).toBe(path.join(ws.dir, "output", "a.spz"));
  }, 60_000);

  it("detects a symlink escape where the platform allows creating one", async () => {
    const root = await dir();
    const outside = await dir();
    const ws = await createWorkspace(root, "sym");
    const link = path.join(ws.paths.output, "link");
    const made = await symlink(outside, link, "junction").then(
      () => true,
      () => false,
    );
    if (made) await expect(assertContained(ws, link)).rejects.toThrow(/outside its run directory/);
    await expect(assertContained(ws, ws.paths.output)).resolves.toBeUndefined();
  }, 60_000);

  it("cleanup keeps output, logs and manifest for ingestion, or removes everything", async () => {
    const root = await dir();
    const ws = await createWorkspace(root, "clean");
    for (const d of ["input", "colmap", "brush", "output", "logs"] as const)
      await writeFile(path.join(ws.paths[d], "f.bin"), new Uint8Array(100));
    await writeFile(ws.manifestPath, "{}");
    expect(await directoryBytes(ws.dir)).toBe(502);
    await cleanupWorkspace(ws, "intermediates");
    expect((await readdir(ws.dir)).sort()).toEqual(["logs", "manifest.json", "output"]);
    await cleanupWorkspace(ws, "all");
    expect(await readdir(root)).toEqual([]);
  }, 60_000);
});

describe("input materialization", () => {
  const limits = { minImages: 3, maxImages: 10, maxImageBytes: 1024, maxTotalBytes: 4096 };
  const img = (ordinal: number, bytes: Uint8Array, mime = "image/jpeg"): LocalReconstructionInput => ({
    ordinal,
    source: { kind: "bytes", bytes },
    checksum: null,
    mime,
  });

  it("copies photographs in ORDER as 000001.<ext>…, byte-for-byte, with streaming checksums", async () => {
    const root = await dir();
    const src = await dir();
    const ws = await createWorkspace(root, "inputs");
    // a hostile original file name is never used for anything
    const hostile = path.join(src, "..evil; rm -rf ~ #.png");
    await writeFile(hostile, PNG_BYTES);
    const m = await materializeInputs(
      ws,
      [
        img(0, jpegBytes(1)),
        { ordinal: 1, source: { kind: "file", path: hostile }, checksum: null, mime: "image/png" },
        img(2, jpegBytes(3)),
      ],
      limits,
    );
    expect(m.map((x) => x.fileName)).toEqual(["000001.jpg", "000002.png", "000003.jpg"]);
    expect(await readdir(ws.paths.input)).toEqual(["000001.jpg", "000002.png", "000003.jpg"]);
    expect(new Uint8Array(await readFile(path.join(ws.paths.input, "000002.png")))).toEqual(PNG_BYTES);
    expect(m[1]!.checksum).toBe(await sha256File(hostile));
  }, 60_000);

  it("refuses bad inputs: too few/many, wrong order, unsupported or lying MIME, empty, oversize, duplicates, checksum mismatch, relative paths", async () => {
    const root = await dir();
    let n = 0;
    const attempt = async (inputs: LocalReconstructionInput[], over: Partial<typeof limits> = {}) => {
      const ws = await createWorkspace(root, `r${n++}`);
      return materializeInputs(ws, inputs, { ...limits, ...over }).then(
        () => "ok",
        (e: LocalReconstructionError) => e.code,
      );
    };
    const three = [img(0, jpegBytes(1)), img(1, jpegBytes(2)), img(2, jpegBytes(3))];
    expect(await attempt(three)).toBe("ok");
    expect(await attempt(three.slice(0, 2))).toBe("invalid_inputs");
    expect(await attempt(three, { maxImages: 2 })).toBe("invalid_inputs");
    expect(await attempt([three[1]!, three[0]!, three[2]!])).toBe("invalid_inputs");
    expect(await attempt([...three.slice(0, 2), img(2, jpegBytes(3), "image/webp")])).toBe("invalid_inputs");
    expect(await attempt([...three.slice(0, 2), img(2, PNG_BYTES, "image/jpeg")])).toBe("invalid_inputs");
    expect(await attempt([...three.slice(0, 2), img(2, new Uint8Array(0))])).toBe("invalid_inputs");
    expect(await attempt(three, { maxImageBytes: 5 })).toBe("invalid_inputs");
    expect(await attempt(three, { maxTotalBytes: 20 })).toBe("invalid_inputs");
    expect(await attempt([...three.slice(0, 2), img(2, jpegBytes(1))])).toBe("invalid_inputs"); // same bytes twice
    expect(await attempt([...three.slice(0, 2), { ...img(2, jpegBytes(3)), checksum: "0".repeat(64) }])).toBe(
      "invalid_inputs",
    );
    expect(() =>
      validateInputList(
        [
          ...three.slice(0, 2),
          { ordinal: 2, source: { kind: "file", path: "rel/a.jpg" }, checksum: null, mime: "image/jpeg" },
        ],
        limits,
      ),
    ).toThrow(/absolute/);
  }, 60_000);

  it("streams large inputs and stops on cancellation", async () => {
    const root = await dir();
    const src = await dir();
    await mkdir(src, { recursive: true });
    const big = path.join(src, "big.jpg");
    await writeFile(big, Buffer.concat([Buffer.from(jpegBytes(9)), Buffer.alloc(3 * 1024 * 1024, 7)]));
    const ws = await createWorkspace(root, "big");
    const m = await materializeInputs(
      ws,
      [0, 1, 2].map((i) => ({
        ordinal: i,
        source:
          i === 0 ? { kind: "file" as const, path: big } : { kind: "bytes" as const, bytes: jpegBytes(i) },
        checksum: null,
        mime: "image/jpeg",
      })),
      { ...limits, maxImageBytes: 8 * 1024 * 1024, maxTotalBytes: 16 * 1024 * 1024 },
    );
    expect(m[0]!.byteSize).toBe(3 * 1024 * 1024 + 10);
    const ac = new AbortController();
    ac.abort();
    const ws2 = await createWorkspace(root, "big2");
    await expect(
      materializeInputs(
        ws2,
        [img(0, jpegBytes(1)), img(1, jpegBytes(2)), img(2, jpegBytes(3))],
        limits,
        ac.signal,
      ),
    ).rejects.toMatchObject({ code: "cancelled" });
  }, 60_000);
});
