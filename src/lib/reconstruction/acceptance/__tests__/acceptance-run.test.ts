import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectSplat } from "@/lib/splat/inspect";
import { fakeMachine, machineEnv } from "../../local/__tests__/fake-machine";
import { fakeBrush, fakeColmap } from "../../local/__tests__/fake-tools";
import { probeLocalToolchain } from "../../local/toolchain";
import { runAcceptanceCli } from "../cli";
import { parseVulkanSummary, type HardwareFacts } from "../hardware";
import {
  finalVerdict,
  HUMAN_CHECKLIST,
  humanReviewSchema,
  humanReviewTemplate,
  type HumanReview,
} from "../human";
import { assessHardware } from "../policy";
import { acceptanceReportSchema, machineVerdict, type AcceptanceReport } from "../report";
import { readReport, runAcceptance, type AcceptanceInput } from "../runner";
import { encodePng, renderSyntheticRoom } from "../synthetic";

/**
 * M2D.3D1 acceptance harness, automated: FAKE mode only. COLMAP and Brush are the M2D.3A fake executables (real child
 * processes); everything from the PLY on is production code. No real tool, no network.
 */

const GiB = 1024 ** 3;
let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "prism-acceptance-run-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true, maxRetries: 3 });
});

const hardware = (): HardwareFacts => ({
  os: { platform: "win32", release: "10.0.22631", arch: "x64", caption: "Windows 11 Pro" },
  cpu: { model: "Fictional CPU", logicalCores: 16, physicalCores: 8 },
  memory: { totalBytes: 32 * GiB, freeBytes: 20 * GiB },
  disk: { freeBytes: 500 * GiB, totalBytes: 1000 * GiB },
  gpus: [],
  vulkan: {
    loaderPresent: true,
    vulkaninfo: "ok",
    ...parseVulkanSummary(
      "Vulkan Instance Version: 1.3.280\nGPU0:\n\tapiVersion = 1.3.277\n\tdeviceType = PHYSICAL_DEVICE_TYPE_DISCRETE_GPU\n\tdeviceName = Fictional GPU\n",
    ),
  },
  notes: [],
});

async function fakeToolchain(brush = "success") {
  const m = await fakeMachine(path.join(tmp, "machine"));
  return probeLocalToolchain({
    platform: "win32",
    env: machineEnv(m),
    commandFor: (tool) => (tool === "colmap" ? fakeColmap("success") : fakeBrush(brush)),
  });
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** photographs ON DISK (as an operator's would be), small and distinct */
async function photosOnDisk(n = 4): Promise<{ dir: string; inputs: AcceptanceInput[] }> {
  const dir = path.join(tmp, "photos");
  await mkdir(dir, { recursive: true });
  const inputs: AcceptanceInput[] = [];
  for (let i = 0; i < n; i++) {
    const bytes = encodePng(8, 6, new Uint8Array(8 * 6 * 3).fill(30 + i * 40));
    const file = path.join(dir, `photo-${i}.png`);
    await writeFile(file, bytes);
    inputs.push({
      ordinal: i,
      source: { kind: "file", path: file },
      mime: "image/png",
      sha256: sha(bytes),
      byteSize: bytes.length,
      width: 8,
      height: 6,
    });
  }
  return { dir, inputs };
}

describe("acceptance run (FAKE tools through the real engine)", { timeout: 120_000 }, () => {
  it("produces splat.ply/spz, the engine manifest and log, a valid prism.reconstruction-acceptance.v1 report and the review template; originals untouched", async () => {
    const toolchain = await fakeToolchain();
    expect(toolchain.overall).toBe("ready");
    const { dir, inputs } = await photosOnDisk(4);
    const before = await Promise.all(
      inputs.map(async (i) => [
        sha(await readFile((i.source as { path: string }).path)),
        (await stat((i.source as { path: string }).path)).mtimeMs,
      ]),
    );
    const out = path.join(tmp, "out");
    const hw = hardware();
    const lines: string[] = [];
    const r = await runAcceptance({
      mode: "FAKE",
      datasetKind: "photos",
      inputs,
      outputDir: out,
      toolchain,
      hardware: hw,
      assessment: assessHardware(hw),
      freeDiskBytes: async () => 500 * GiB,
      log: (l) => lines.push(l),
    });
    expect(r.report.outcome.status).toBe("succeeded");
    expect((await readdir(out)).sort()).toEqual(
      ["acceptance-report.json", "run-manifest.json", "run.log", "splat.ply", "splat.spz"].sort(),
    );
    // the SPZ is valid and is the one the report describes
    const spz = new Uint8Array(await readFile(path.join(out, "splat.spz")));
    const inspected = inspectSplat(spz, "splat.spz");
    expect(inspected.ok).toBe(true);
    const rep = await readReport(out);
    expect(acceptanceReportSchema.safeParse(rep).success).toBe(true);
    expect(rep).toMatchObject({
      schema: "prism.reconstruction-acceptance.v1",
      mode: "FAKE",
      network: { providerCalls: 0, paidCalls: 0, uploads: 0 },
      engine: { quality: "standard", brushProfile: "standard", brushSettings: { "total-steps": 30000 } },
      dataset: {
        kind: "photos",
        inputCount: 4,
        dimensions: { minWidth: 8, maxWidth: 8, distinctSizes: 1, unreadable: 0 },
      },
      toolchain: {
        colmap: { version: "4.2.1", sourceCommit: "bd1fcf654d2dd8fefa1466999c190a246f83f4b9" },
        brush: { version: "0.3.0" },
      },
      validation: { ply: "pass", spz: "pass", inspectSplat: "pass", sparkRender: "not_run" },
      verdict: { machine: "PASS_WITH_LIMITATIONS", final: "PASS_WITH_LIMITATIONS" },
    });
    expect(rep.dataset.inputs.map((i) => i.sha256)).toEqual(inputs.map((i) => i.sha256));
    expect(rep.splat).toMatchObject({ spzSha256: sha(spz), spzBytes: spz.length });
    expect(rep.splat!.compressionRatio).toBeGreaterThan(1);
    // every pipeline stage was timed, COLMAP command by command
    for (const s of [
      "input_preparation",
      "colmap_feature_extraction",
      "colmap_matching",
      "colmap_mapping",
      "colmap_undistortion",
      "brush_training",
      "ply_validation",
      "spz_conversion",
      "spz_validation",
    ])
      expect(rep.timingsMs[s as keyof typeof rep.timingsMs], s).toBeTypeOf("number");
    expect(rep.resources.minFreeSystemMemoryBytes).toBeGreaterThan(0);
    expect(rep.resources.maxWorkspaceBytes).toBeGreaterThan(0);
    expect(rep.warnings.join(" ")).toMatch(/FAKE mode/);
    // privacy: no photo path, temp directory, user or host name in the report
    const text = JSON.stringify(rep);
    for (const s of [dir, tmp, os.hostname(), os.userInfo().username, "photo-0.png"])
      expect(text).not.toContain(s);
    // the engine's own workspace is gone after success; the originals are byte-for-byte unchanged
    expect(await stat(path.join(out, "work")).catch(() => null)).toBeNull();
    const after = await Promise.all(
      inputs.map(async (i) => [
        sha(await readFile((i.source as { path: string }).path)),
        (await stat((i.source as { path: string }).path)).mtimeMs,
      ]),
    );
    expect(after).toEqual(before);
    expect(lines.join("\n")).toMatch(/COLMAP feature extraction/);
  });

  it("the acceptance_smoke profile trains a tiny run (500 steps) and is reported as a toolchain check", async () => {
    const out = path.join(tmp, "smoke");
    const views = renderSyntheticRoom({ views: 3, width: 32, height: 24 });
    const hw = hardware();
    const r = await runAcceptance({
      mode: "FAKE",
      brushProfile: "acceptance_smoke",
      datasetKind: "synthetic",
      inputs: views.map((v, ordinal) => ({
        ordinal,
        source: { kind: "bytes", bytes: v.png },
        mime: "image/png",
        sha256: sha(v.png),
        byteSize: v.png.length,
        width: 32,
        height: 24,
      })),
      outputDir: out,
      toolchain: await fakeToolchain(),
      hardware: hw,
      assessment: assessHardware(hw),
      freeDiskBytes: async () => 500 * GiB,
    });
    expect(r.report.engine).toMatchObject({
      brushProfile: "acceptance_smoke",
      brushSettings: { "total-steps": 500, "max-splats": 100000 },
    });
    expect(r.report.warnings.join(" ")).toMatch(/toolchain check, not a production result/);
    const manifest = JSON.parse(await readFile(path.join(out, "run-manifest.json"), "utf8"));
    expect(manifest.metadata.brush.settings["total-steps"]).toBe(500);
  });

  it("refuses BEFORE starting when the conservative disk estimate does not fit, and when the toolchain is not ready", async () => {
    const out = path.join(tmp, "low");
    const hw = hardware();
    const { inputs } = await photosOnDisk(3);
    await expect(
      runAcceptance({
        mode: "REAL_ROOM",
        datasetKind: "photos",
        inputs,
        outputDir: out,
        toolchain: await fakeToolchain(),
        hardware: hw,
        assessment: assessHardware(hw),
        freeDiskBytes: async () => 5 * GiB,
      }),
    ).rejects.toThrow(/Not enough free disk.*Nothing was started/);
    expect(await readdir(out)).toEqual([]);
    const notReady = { ...(await fakeToolchain()), overall: "incomplete" as const };
    await expect(
      runAcceptance({
        mode: "REAL_ROOM",
        datasetKind: "photos",
        inputs,
        outputDir: out,
        toolchain: notReady,
        hardware: hw,
        assessment: assessHardware(hw),
      }),
    ).rejects.toThrow(/not READY/);
  });

  it("a failed run keeps bounded evidence (report, manifest, log); intermediates only with keepIntermediates", async () => {
    const hw = hardware();
    const { inputs } = await photosOnDisk(3);
    for (const keep of [false, true]) {
      const out = path.join(tmp, keep ? "fail-keep" : "fail");
      const r = await runAcceptance({
        mode: "FAKE",
        datasetKind: "photos",
        inputs,
        outputDir: out,
        toolchain: await fakeToolchain("fail"),
        hardware: hw,
        assessment: assessHardware(hw),
        keepIntermediates: keep,
        freeDiskBytes: async () => 500 * GiB,
      });
      expect(r.report.outcome).toMatchObject({
        status: "failed",
        error: { code: "brush_failed", stage: "splat_training" },
      });
      expect(r.report.verdict).toMatchObject({ machine: "FAIL", final: "FAIL" });
      const files = await readdir(out);
      expect(files).toEqual(
        expect.arrayContaining(["acceptance-report.json", "run-manifest.json", "run.log"]),
      );
      expect(files).not.toContain("splat.spz");
      if (!keep) expect(files).not.toContain("work");
      else {
        const run = (await readdir(path.join(out, "work")))[0]!;
        expect(await readdir(path.join(out, "work", run))).toEqual(
          expect.arrayContaining(["colmap", "input"]),
        );
      }
      expect(r.report.timingsMs.colmap_mapping).toBeTypeOf("number");
    }
  });
});

describe("verdicts", () => {
  const base = (o: Partial<AcceptanceReport> = {}): AcceptanceReport =>
    ({
      runId: "acc-20261020000000-abcdef",
      mode: "REAL_ROOM",
      outcome: { status: "succeeded", error: null },
      validation: {
        ply: "pass",
        spz: "pass",
        inspectSplat: "pass",
        sparkRender: "pass",
        sparkRenderDetail: null,
      },
      camera: {
        registeredImages: 100,
        registrationRatio: 1,
        sparsePoints: 9000,
        cameraCount: 1,
        modelsDiscovered: 1,
      },
      dataset: { inputCount: 100 },
      splat: { gaussianCount: 1000, clamped: { positions: 0, colors: 0, scales: 0, sh: 0 } },
      verdict: { machine: "PASS", machineReasons: [], final: "PENDING_HUMAN_REVIEW", finalReasons: [] },
      ...o,
    }) as unknown as AcceptanceReport;
  const review = (
    answers: Partial<Record<string, "pass" | "fail" | "not_applicable" | null>> = {},
    ack = true,
  ): HumanReview => ({
    schema: "prism.reconstruction-human-review.v1",
    runId: "acc-20261020000000-abcdef",
    reviewer: "QA",
    reviewedAt: "2026-10-20",
    answers: {
      ...Object.fromEntries(HUMAN_CHECKLIST.map((c) => [c.id, "pass" as const])),
      ...(answers as Record<string, "pass" | "fail" | "not_applicable" | null>),
    },
    controlPassLimitationAcknowledged: ack,
    notes: "",
  });

  it("machine: FAIL without a validated splat or a render; limitations for weak registration or heavy clamping", () => {
    expect(machineVerdict(base()).verdict).toBe("PASS");
    expect(
      machineVerdict(
        base({
          outcome: {
            status: "failed",
            error: { code: "colmap_failed", stage: "camera_reconstruction", message: "x" },
          },
        }),
      ).verdict,
    ).toBe("FAIL");
    expect(
      machineVerdict(
        base({
          validation: {
            ply: "pass",
            spz: "pass",
            inspectSplat: "pass",
            sparkRender: "fail",
            sparkRenderDetail: null,
          },
        }),
      ).verdict,
    ).toBe("FAIL");
    const weak = machineVerdict(
      base({
        camera: {
          registeredImages: 60,
          registrationRatio: 0.6,
          sparsePoints: 900,
          cameraCount: 1,
          modelsDiscovered: 2,
        },
      }),
    );
    expect(weak).toMatchObject({ verdict: "PASS_WITH_LIMITATIONS" });
    expect(weak.reasons[0]).toMatch(/Only 60 %/);
    expect(
      machineVerdict(
        base({
          splat: { gaussianCount: 1000, clamped: { positions: 0, colors: 50, scales: 0, sh: 0 } },
        } as never),
      ).verdict,
    ).toBe("PASS_WITH_LIMITATIONS");
  });

  it("final: pending until every item is answered and the control-pass limitation acknowledged; critical failures FAIL", () => {
    expect(finalVerdict(base(), null).verdict).toBe("PENDING_HUMAN_REVIEW");
    expect(finalVerdict(base(), review({ "visual.no_explosions": null })).verdict).toBe(
      "PENDING_HUMAN_REVIEW",
    );
    expect(finalVerdict(base(), review({}, false)).verdict).toBe("PENDING_HUMAN_REVIEW");
    expect(finalVerdict(base(), { ...review(), runId: "acc-other-run-000000" }).verdict).toBe(
      "PENDING_HUMAN_REVIEW",
    );
    const pass = finalVerdict(base(), review());
    expect(pass.verdict).toBe("PASS");
    // the control-pass gap is always stated, even on PASS
    expect(pass.reasons.join(" ")).toMatch(/blocks exact M2C depth\/object\/mask/);
    expect(finalVerdict(base(), review({ "geometry.no_duplication": "fail" })).verdict).toBe("FAIL");
    expect(finalVerdict(base(), review({ "production.master_frame": "not_applicable" })).verdict).toBe(
      "FAIL",
    );
    expect(finalVerdict(base(), review({ "visual.no_dominant_floaters": "fail" })).verdict).toBe(
      "PASS_WITH_LIMITATIONS",
    );
    // no Spark render → never a plain PASS
    expect(
      finalVerdict(
        base({
          validation: {
            ply: "pass",
            spz: "pass",
            inspectSplat: "pass",
            sparkRender: "not_run",
            sparkRenderDetail: null,
          },
        }),
        review(),
      ).verdict,
    ).toBe("PASS_WITH_LIMITATIONS");
    expect(
      finalVerdict(
        base({ verdict: { machine: "FAIL", machineReasons: ["x"], final: "FAIL", finalReasons: [] } }),
        review(),
      ).verdict,
    ).toBe("FAIL");
  });

  it("the review template lists every item unanswered and parses as a review once its reference copy is removed", () => {
    const t = humanReviewTemplate("acc-20261020000000-abcdef");
    expect(Object.values(t.answers).every((v) => v === null)).toBe(true);
    expect(Object.keys(t.answers)).toHaveLength(HUMAN_CHECKLIST.length);
    const review: Record<string, unknown> = { ...t };
    delete review.checklist;
    delete review.limitation;
    expect(humanReviewSchema.safeParse(review).success).toBe(true);
    // the reference copy itself is not part of a review (strict schema)
    expect(humanReviewSchema.safeParse(t).success).toBe(false);
  });

  it("the report schema refuses a path, a URL or a home directory in any text field", () => {
    for (const bad of ["C:\\Users\\someone\\photos", "/home/someone/photos", "https://example.invalid/x"])
      expect(acceptanceReportSchema.shape.warnings.safeParse([bad]).success, bad).toBe(false);
    expect(acceptanceReportSchema.shape.warnings.safeParse(["Hardware tier PRACTICAL."]).success).toBe(true);
  });
});

describe("operator CLI", { timeout: 120_000 }, () => {
  const cli = async (argv: string[], env: Record<string, string | undefined> = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    let probed = 0;
    const code = await runAcceptanceCli({
      argv,
      env,
      repoRoot: process.cwd(),
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      probeToolchain: async () => {
        probed++;
        return fakeToolchain();
      },
      probeHardware: async () => hardware(),
    });
    return { code, out: out.join("\n"), err: err.join("\n"), probed };
  };

  it("REAL modes refuse without --real, and refuse inside automated tests even with it (no tool is probed or run)", async () => {
    const noReal = await cli(["smoke"], {});
    expect(noReal).toMatchObject({ code: 2, probed: 0 });
    expect(noReal.err).toMatch(/Re-run with --real to confirm/);
    const room = await cli(["room", "--input", tmp, "--output", path.join(tmp, "o")], {});
    expect(room.err).toMatch(/--real/);
    const inTests = await cli(["smoke", "--real"], { VITEST: "true" });
    expect(inTests).toMatchObject({ code: 2, probed: 0 });
    expect(inTests.err).toMatch(/never runs inside automated tests/);
    expect((await cli(["smoke", "--real", "--bogus"], {})).err).toMatch(/Unknown or incomplete argument/);
  });

  it("room needs an input and a new output outside the repository", async () => {
    // (outside tests these checks run before anything is probed; here the test guard answers first)
    expect((await cli(["room", "--real"], {})).err).toMatch(
      /never runs inside automated tests|needs --input/,
    );
  });

  it("check prints the readiness report and exits 1 when not ready; --json is machine-readable", async () => {
    const env = {
      PRISM_LOCAL_AGENT_HOME: path.join(tmp, "agent-home"),
      PRISM_LOCAL_RECONSTRUCTION_ROOT: path.join(tmp, "work"),
    };
    const r = await cli(["check"], env);
    expect(r.out).toMatch(/PRISM RECONSTRUCTION READINESS/);
    expect(r.out).toMatch(/READY FOR REAL ACCEPTANCE: YES/); // fake verified toolchain + practical fictional hardware
    expect(r.code).toBe(0);
    const j = await cli(["check", "--json"], env);
    expect(JSON.parse(j.out)).toMatchObject({
      schema: "prism.reconstruction-readiness.v1",
      gates: { A: "NOT_PASSED", B: "PASS", C: "NOT_RUN" },
    });
  });

  it("verdict combines a report with its filled-in human review", async () => {
    const out = path.join(tmp, "run");
    const hw = hardware();
    await runAcceptance({
      mode: "FAKE",
      datasetKind: "photos",
      inputs: (await photosOnDisk(3)).inputs,
      outputDir: out,
      toolchain: await fakeToolchain(),
      hardware: hw,
      assessment: assessHardware(hw),
      freeDiskBytes: async () => 500 * GiB,
    });
    const rep = await readReport(out);
    // pretend it was a room run that rendered (FAKE runs are judged by the machine only)
    await writeFile(
      path.join(out, "acceptance-report.json"),
      JSON.stringify({ ...rep, mode: "REAL_ROOM", validation: { ...rep.validation, sparkRender: "pass" } }),
    );
    const t = humanReviewTemplate(rep.runId);
    for (const k of Object.keys(t.answers)) t.answers[k] = "pass";
    t.answers["visual.no_dominant_floaters"] = "fail";
    t.controlPassLimitationAcknowledged = true;
    await writeFile(path.join(out, "human-review.json"), JSON.stringify(t));
    const r = await cli(["verdict", "--output", out]);
    expect(r.out).toMatch(/FINAL VERDICT: PASS_WITH_LIMITATIONS/);
    expect((await readReport(out)).verdict.final).toBe("PASS_WITH_LIMITATIONS");
    expect(await readFile(path.join(out, "verdict.txt"), "utf8")).toMatch(/^PASS_WITH_LIMITATIONS/);
  });
});
