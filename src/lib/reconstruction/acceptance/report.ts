import { z } from "zod";

/**
 * `prism.reconstruction-acceptance.v1` (M2D.3D1): the record of one REAL acceptance run. Facts only: counts, sizes,
 * checksums, versions, timings and verdict reasons. Never a user name, host name, home directory, original photo path,
 * secret or raw tool log. Photographs are identified by ordinal and sha256 only.
 *
 * Verdicts are plain words, never a score: PASS, PASS_WITH_LIMITATIONS, FAIL. The MACHINE verdict covers what software
 * can check; the FINAL verdict also needs the human review (./human.ts).
 */

export const ACCEPTANCE_REPORT_SCHEMA = "prism.reconstruction-acceptance.v1" as const;
export const ACCEPTANCE_MODES = ["FAKE", "REAL_SMOKE", "REAL_ROOM"] as const;
export type AcceptanceMode = (typeof ACCEPTANCE_MODES)[number];
export const VERDICTS = ["PASS", "PASS_WITH_LIMITATIONS", "FAIL"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** timed stages, in pipeline order (COLMAP's four commands are timed separately) */
export const TIMED_STAGES = [
  "input_preparation",
  "colmap_feature_extraction",
  "colmap_matching",
  "colmap_mapping",
  "colmap_undistortion",
  "brush_training",
  "ply_validation",
  "spz_conversion",
  "spz_validation",
  "render_acceptance",
] as const;
export type TimedStage = (typeof TIMED_STAGES)[number];

const sha = z.string().regex(/^[0-9a-f]{64}$/);
const safeText = z
  .string()
  .max(600)
  // no absolute path, home directory or URL ever enters a report
  .refine(
    (s) => !/[A-Za-z]:\\|\\\\|(?:^|\s)\/(?:home|Users|root|mnt|var|tmp)\/|https?:\/\//.test(s),
    "unsafe text",
  );

export const acceptanceReportSchema = z
  .object({
    schema: z.literal(ACCEPTANCE_REPORT_SCHEMA),
    runId: z.string().regex(/^acc-[0-9a-z-]{8,64}$/),
    createdAt: z.string().max(40),
    mode: z.enum(ACCEPTANCE_MODES),
    network: z.object({ providerCalls: z.literal(0), paidCalls: z.literal(0), uploads: z.literal(0) }),
    engine: z.object({
      runSchema: z.string().max(80),
      quality: z.literal("standard"),
      brushProfile: z.enum(["standard", "acceptance_smoke"]),
      brushSettings: z.record(z.string(), z.number()),
    }),
    dataset: z.object({
      kind: z.enum(["synthetic", "photos"]),
      inputCount: z.number().int().min(0),
      totalBytes: z.number().int().min(0),
      inputs: z
        .array(
          z.object({
            ordinal: z.number().int().min(0),
            sha256: sha,
            byteSize: z.number().int().min(1),
            mime: z.enum(["image/jpeg", "image/png"]),
            width: z.number().int().positive().nullable(),
            height: z.number().int().positive().nullable(),
          }),
        )
        .max(300),
      dimensions: z.object({
        minWidth: z.number().int().nullable(),
        maxWidth: z.number().int().nullable(),
        minHeight: z.number().int().nullable(),
        maxHeight: z.number().int().nullable(),
        distinctSizes: z.number().int().min(0),
        unreadable: z.number().int().min(0),
      }),
    }),
    toolchain: z.object({
      colmap: z.object({
        version: z.string().max(20).nullable(),
        sourceCommit: z.string().max(64).nullable(),
        binarySha256: sha.nullable(),
      }),
      brush: z.object({ version: z.string().max(20).nullable() }),
      spzEncoder: z.string().max(80).nullable(),
    }),
    hardware: z.object({
      os: safeText,
      cpu: safeText,
      logicalCores: z.number().int().min(0),
      ramBytes: z.number().min(0),
      tier: z.enum(["UNSUPPORTED", "SUPPORTED_FOR_TEST", "PRACTICAL"]),
    }),
    gpuBackend: z.object({
      api: z.literal("vulkan"),
      instanceVersion: z.string().max(20).nullable(),
      devices: z.array(safeText).max(8),
    }),
    camera: z
      .object({
        registeredImages: z.number().int().min(0),
        registrationRatio: z.number().min(0).max(1),
        sparsePoints: z.number().int().min(0),
        cameraCount: z.number().int().min(0),
        modelsDiscovered: z.number().int().min(0),
      })
      .nullable(),
    splat: z
      .object({
        gaussianCount: z.number().int().min(0),
        shDegree: z.number().int().min(0).max(3),
        plyBytes: z.number().int().min(0),
        spzBytes: z.number().int().min(0),
        compressionRatio: z.number().min(0),
        plySha256: sha,
        spzSha256: sha,
        clamped: z.record(z.string(), z.number()),
      })
      .nullable(),
    timingsMs: z.partialRecord(z.enum(TIMED_STAGES), z.number().min(0)),
    totalMs: z.number().min(0),
    resources: z.object({
      /** sampled once a second while the run was active; a system-wide figure, not the tools' own usage */
      minFreeSystemMemoryBytes: z.number().min(0).nullable(),
      /** the run workspace's size at stage boundaries (its maximum) */
      maxWorkspaceBytes: z.number().min(0).nullable(),
      notMeasured: z.array(safeText),
    }),
    validation: z.object({
      ply: z.enum(["pass", "fail", "not_run"]),
      spz: z.enum(["pass", "fail", "not_run"]),
      inspectSplat: z.enum(["pass", "fail", "not_run"]),
      sparkRender: z.enum(["pass", "fail", "not_run"]),
      sparkRenderDetail: z
        .object({
          gaussianCount: z.number().int().nullable(),
          frames: z.array(
            z.object({ name: z.string().max(20), coverage: z.number(), file: z.string().max(40).nullable() }),
          ),
          webglRenderer: safeText.nullable(),
          reasons: z.array(safeText),
        })
        .nullable(),
    }),
    outcome: z.object({
      status: z.enum(["succeeded", "failed", "cancelled"]),
      error: z
        .object({ code: z.string().max(60), stage: z.string().max(40).nullable(), message: safeText })
        .nullable(),
    }),
    warnings: z.array(safeText),
    verdict: z.object({
      machine: z.enum(VERDICTS),
      machineReasons: z.array(safeText),
      /** set by `npm run local:acceptance:verdict` from the human review; PENDING until then */
      final: z.enum([...VERDICTS, "PENDING_HUMAN_REVIEW"]),
      finalReasons: z.array(safeText),
    }),
  })
  .strict();

export type AcceptanceReport = z.infer<typeof acceptanceReportSchema>;

/** A registration ratio below this is reported as a limitation (the engine's hard floor is 40 %). */
export const GOOD_REGISTRATION_RATIO = 0.9;

/**
 * What software can decide. FAIL: the run did not produce a validated SPZ. PASS_WITH_LIMITATIONS: it did, but
 * something a person should weigh is off (registration well below all photographs, values clamped by SPZ, the render
 * check not run or failed). REAL_SMOKE is judged only on running end to end (a synthetic scene has no quality).
 */
export function machineVerdict(r: Omit<AcceptanceReport, "verdict">): {
  verdict: Verdict;
  reasons: string[];
} {
  const reasons: string[] = [];
  if (r.outcome.status !== "succeeded")
    return {
      verdict: "FAIL",
      reasons: [
        r.outcome.error
          ? `The run failed at ${r.outcome.error.stage ?? "an unknown stage"}: ${r.outcome.error.code}.`
          : "The run did not complete.",
      ],
    };
  if (r.validation.ply !== "pass" || r.validation.spz !== "pass" || r.validation.inspectSplat !== "pass")
    return { verdict: "FAIL", reasons: ["The splat did not pass PLY/SPZ validation."] };
  if (r.validation.sparkRender === "fail")
    return {
      verdict: "FAIL",
      reasons: ["Spark could not render the SPZ.", ...(r.validation.sparkRenderDetail?.reasons ?? [])],
    };
  if (r.validation.sparkRender === "not_run") reasons.push("The Spark render check was not run.");
  if (r.mode === "REAL_ROOM" && r.camera && r.camera.registrationRatio < GOOD_REGISTRATION_RATIO)
    reasons.push(
      `Only ${Math.round(r.camera.registrationRatio * 100)} % of the photographs were registered (${r.camera.registeredImages}/${r.dataset.inputCount}).`,
    );
  const clamped = Object.values(r.splat?.clamped ?? {}).reduce((a, b) => a + b, 0);
  if (r.splat && clamped > r.splat.gaussianCount * 0.01)
    reasons.push(`${clamped} values were clamped by SPZ quantization (more than 1 % of the Gaussians).`);
  return { verdict: reasons.length ? "PASS_WITH_LIMITATIONS" : "PASS", reasons };
}

export function dimensionSummary(inputs: Array<{ width: number | null; height: number | null }>) {
  const known = inputs.filter((i) => i.width && i.height) as Array<{ width: number; height: number }>;
  const ws = known.map((i) => i.width);
  const hs = known.map((i) => i.height);
  return {
    minWidth: ws.length ? Math.min(...ws) : null,
    maxWidth: ws.length ? Math.max(...ws) : null,
    minHeight: hs.length ? Math.min(...hs) : null,
    maxHeight: hs.length ? Math.max(...hs) : null,
    distinctSizes: new Set(known.map((i) => `${i.width}x${i.height}`)).size,
    unreadable: inputs.length - known.length,
  };
}
