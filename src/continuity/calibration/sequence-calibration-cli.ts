import { writeFileSync } from "node:fs";
import { FfmpegMediaProcessor } from "@/media/ffmpeg";
import { GeminiAnalysisProvider } from "../providers/gemini/analyzer";
import { geminiModelBlocker, readGeminiConfig } from "../providers/gemini/config";
import { FakeGeminiTransport } from "../providers/gemini/fake-transport";
import type { GeminiTransport } from "../providers/gemini/transport";
import {
  estimateSequenceCalibration,
  inlineOnlyProblems,
  materialChecksums,
  prepareSequenceMaterials,
  runSequenceCalibration,
  sequenceCalibrationIdentity,
  SEQUENCE_CALIBRATION_PREREGISTERED,
  type SequenceMaterials,
} from "./sequence-calibration";
import {
  SEQUENCE_CALIBRATION_PLAN,
  SEQUENCE_CALIBRATION_VERSION,
  sequenceDefinitionHash,
  sequenceInputHash,
} from "./sequence-fixtures";
import { sequenceOracle } from "./sequence-oracle";
import { liveReadinessProblems, type CalibrationQuota } from "./temporal-calibration";

/**
 * The Sequence Continuity calibration CLI (scripts/continuity-sequence-calibration.mts is a thin wrapper). The default
 * is OFFLINE: the truthful fake oracle over the real media. The real SDK transport is INJECTED and only ever created
 * after every live refusal has passed, in this order: acknowledgement, both env flags, model, ceilings, the operator's
 * quota and billing readiness, the model check, the credential, the local media, the reviewed input hash, inline-only
 * media, the worst case. A refusal returns exit code 2 with "REFUSED: … Nothing was sent."
 */
export interface SequenceCalibrationCliDeps {
  argv: readonly string[];
  env: Record<string, string | undefined>;
  createLiveTransport: (apiKey: string) => Promise<GeminiTransport>;
  /** Injected for tests; default renders and derives with the local ffmpeg. */
  prepare?: () => Promise<SequenceMaterials>;
  preregistered?: { inputHash: string };
  /** Injected for tests, which never wait; default: fake mode never waits, live mode really paces. */
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  error?: (line: string) => void;
  writeReport?: (path: string, json: string) => void;
}

const FAKE_CONFIG = {
  PRISM_STUDIO_CONTINUITY_ANALYZERS: "gemini",
  GEMINI_API_KEY: "fake-transport-no-key",
  PRISM_STUDIO_GEMINI_DIRECT_VIDEO: "1",
};

class Refusal extends Error {}

/** Returns the process exit code: 0 completed, 2 refused (nothing sent), 3 aborted (partial report written). */
export async function runSequenceCalibrationCli(deps: SequenceCalibrationCliDeps): Promise<number> {
  const { argv, env } = deps;
  const log = deps.log ?? ((l: string) => console.log(l));
  const error = deps.error ?? ((l: string) => console.error(l));
  const writeReport = deps.writeReport ?? ((p: string, j: string) => writeFileSync(p, j));
  const flag = (n: string) => argv.includes(n);
  const value = (n: string) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const num = (n: string) => (value(n) === undefined ? undefined : Number(value(n)));
  const live = flag("--live");
  const out = value("--out") ?? `sequence-calibration-${live ? "live" : "fake"}.json`;
  const fail = (m: string): never => {
    throw new Refusal(m);
  };
  const prepare = deps.prepare ?? (() => prepareSequenceMaterials({ processor: new FfmpegMediaProcessor() }));
  const preregistered = deps.preregistered ?? SEQUENCE_CALIBRATION_PREREGISTERED;

  try {
    const readiness = {
      maxRpm: num("--max-rpm"),
      maxTpm: num("--max-tpm"),
      maxRpd: num("--max-rpd"),
      rpdRemainingConfirmed: flag("--confirm-rpd-remaining"),
      billingActive: value("--billing-active"),
      projectTier: value("--project-tier"),
      spendCap: value("--spend-cap"),
    };
    let maxCalls: number = SEQUENCE_CALIBRATION_PLAN.maxTransportRequests;
    let maxUsd = 5; // fake transport: spends nothing; the ceiling still has to hold the worst-case estimate
    let quota: CalibrationQuota | undefined;
    let liveConfig: ReturnType<typeof readGeminiConfig> | null = null;
    let apiKey = "";
    if (live) {
      if (!flag("--i-understand-this-sends-synthetic-video-and-costs-money"))
        fail("--live needs --i-understand-this-sends-synthetic-video-and-costs-money.");
      if (env.PRISM_STUDIO_SEQUENCE_CALIBRATION_LIVE !== "1")
        fail("PRISM_STUDIO_SEQUENCE_CALIBRATION_LIVE=1 is not set.");
      if (env.PRISM_STUDIO_ALLOW_PAID_ANALYSIS !== "1")
        fail("PRISM_STUDIO_ALLOW_PAID_ANALYSIS=1 is not set.");
      const model = value("--model") ?? fail("--model is required (an exact verified Gemini model id).");
      const mc = Number(value("--max-calls"));
      const mu = Number(value("--max-usd"));
      if (!Number.isInteger(mc) || mc < SEQUENCE_CALIBRATION_PLAN.qualityRequests)
        fail(
          `--max-calls must be an integer of at least ${SEQUENCE_CALIBRATION_PLAN.qualityRequests}: it counts every outbound request, corrections included (the plan's worst case is ${SEQUENCE_CALIBRATION_PLAN.maxTransportRequests}).`,
        );
      if (!(mu > 0) || !Number.isFinite(mu)) fail("--max-usd must be a positive amount.");
      const problems = liveReadinessProblems(readiness);
      if (problems.length) fail(problems.join(" "));
      if (!value("--input-hash")) fail("--input-hash is required: the reviewed calibration input hash.");
      const blocker = geminiModelBlocker(model);
      if (blocker) fail(blocker);
      liveConfig = readGeminiConfig({
        ...env,
        PRISM_STUDIO_CONTINUITY_ANALYZERS: "gemini",
        PRISM_STUDIO_GEMINI_ANALYSIS_MODEL: model,
        PRISM_STUDIO_GEMINI_DIRECT_VIDEO: "1",
      });
      apiKey = liveConfig.apiKey ?? fail("GEMINI_API_KEY is not set.");
      maxCalls = Math.min(mc, SEQUENCE_CALIBRATION_PLAN.maxTransportRequests);
      maxUsd = mu;
      quota = {
        maxRpm: readiness.maxRpm ?? Number.NaN,
        maxTpm: readiness.maxTpm ?? Number.NaN,
        maxRpd: readiness.maxRpd ?? Number.NaN,
      };
    }

    // the hash is computed and compared before any real transport exists
    const materials = await prepare();
    const inputHash = sequenceInputHash(materialChecksums(materials));
    const matches = inputHash === preregistered.inputHash;
    log(`CALIBRATION INPUT HASH: ${inputHash}`);
    log(`DEFINITION HASH: ${sequenceDefinitionHash()}`);
    log(`MATCHES THE REVIEWED HASH: ${matches ? "YES" : "NO"}`);
    if (live) {
      if (!matches)
        fail(
          `The computed input hash differs from the reviewed one (${preregistered.inputHash}): the experiment or the ffmpeg build changed.`,
        );
      if (value("--input-hash") !== inputHash)
        fail(`--input-hash does not match the computed input hash ${inputHash}.`);
    }

    const identity = sequenceCalibrationIdentity();
    const fakeConfig = readGeminiConfig(FAKE_CONFIG);
    // a planning provider holds no network: the real inputs are checked and costed with it first
    const planner = new GeminiAnalysisProvider({
      config: liveConfig ?? fakeConfig,
      transport: new FakeGeminiTransport([]),
      testCrossCutCalibration: identity,
    });
    const inline = inlineOnlyProblems(planner, materials);
    if (inline.length) fail(`Calibration v1 is inline-only. ${inline.join(" ")}`);
    const now = new Date();
    const estimate = (() => {
      try {
        return estimateSequenceCalibration(planner, materials, now);
      } catch (err) {
        return fail(err instanceof Error ? err.message.replace(/ Nothing was sent\.$/, "") : String(err));
      }
    })();
    if (estimate.worstCaseUsd > maxUsd)
      fail(`The worst-case estimate $${estimate.worstCaseUsd} exceeds --max-usd ${maxUsd}.`);

    const transport = liveConfig
      ? // the ONLY place the network transport is created: every refusal above has already passed
        await deps.createLiveTransport(apiKey)
      : new FakeGeminiTransport(sequenceOracle(materials, "truthful"));
    const provider = new GeminiAnalysisProvider({
      config: liveConfig ?? fakeConfig,
      transport,
      testCrossCutCalibration: identity,
    });
    log(
      `${SEQUENCE_CALIBRATION_VERSION} · ${live ? "LIVE" : "FAKE transport"} · ${SEQUENCE_CALIBRATION_PLAN.fixtures} fixtures × ${SEQUENCE_CALIBRATION_PLAN.trials} trials = ${SEQUENCE_CALIBRATION_PLAN.qualityRequests} quality requests · ceilings: ${maxCalls} outbound requests, $${maxUsd}`,
    );
    log(
      `estimate: expected $${estimate.expectedUsd}, worst case $${estimate.worstCaseUsd} over ${estimate.worstCaseTransportRequests} requests (${estimate.pricingVersion})`,
    );
    if (live) {
      log(`PROJECT TIER: ${readiness.projectTier}`);
      log(`MODEL RPM LIMIT: ${readiness.maxRpm}`);
      log(`MODEL TPM LIMIT: ${readiness.maxTpm}`);
      log(`MODEL RPD LIMIT: ${readiness.maxRpd} (remaining capacity confirmed by the operator)`);
      log(`PROJECT SPEND CAP: ${readiness.spendCap}`);
      log(`BILLING ACTIVE: YES`);
    }
    let report;
    try {
      report = await runSequenceCalibration({
        provider,
        materials,
        maxTransportCalls: maxCalls,
        maxUsd,
        live,
        quota,
        now,
        ...(deps.sleep ? { sleep: deps.sleep } : live ? {} : { sleep: async () => undefined }),
      });
    } catch (err) {
      // the runner refuses only before its first request
      return fail(
        err instanceof Error ? err.message.replace(/;? ?[Nn]othing was sent\.$/, ".") : String(err),
      );
    }
    const operator = live
      ? {
          projectTier: readiness.projectTier,
          spendCap: readiness.spendCap,
          billingActive: true,
          rpdRemainingConfirmed: true,
        }
      : null;
    // the report is written for every run that got this far, including an aborted one (the audit trail)
    writeReport(out, JSON.stringify({ ...report, operator }, null, 2));
    if (report.quota)
      log(
        `pacing: ${report.quota.effectiveRpm} req/min (≥${report.quota.minIntervalMs} ms apart) · worst case ${report.quota.worstCaseTokensPerMinute} tokens/min ≤ TPM ${report.quota.maxTpm} · ${report.quota.plannedAnalysisRequests} requests ≤ RPD ${report.quota.maxRpd}`,
      );
    log(
      `status=${report.status}${report.abort ? ` abort=${report.abort.reason} http=${report.abort.httpStatus ?? "-"} at ${report.abort.fixture}#${report.abort.trial}` : ""} trials=${report.trialsAttempted}/${report.trialsPlanned} rejected=${report.trialsRejected} unanswered=${report.trialsUnanswered} unattempted=${report.trialsUnattempted} model_responses=${report.answersReceived}`,
    );
    for (const [family, f] of Object.entries(report.families))
      log(
        `${f.decision.toUpperCase()}  ${family}  ${f.correct}/${f.required}${f.corrections ? `  CORRECTIONS=${f.corrections} (owner review required)` : ""}`,
      );
    log(
      `requests=${report.transportCalls} (analysis=${report.analysisAttempts} upload=${report.uploadAttempts} correction=${report.correctionAttempts} usage_reported=${report.usageReportedCalls}) ${live ? `actual=${report.actualUsd == null ? "UNKNOWN" : `$${report.actualUsd}`} (${report.costStatus}; known usage $${report.knownUsageUsd ?? "?"}${report.costStatus === "unknown" ? "; billing could not be established from usage metadata" : ""})` : `actual=$0 (nothing left Prism; simulated usage $${report.knownUsageUsd ?? "?"})`}`,
    );
    log(
      `report: ${out}${live ? "" : " (fake transport: says nothing about a real analyzer)"}. Production configuration is unchanged.`,
    );
    return report.status === "completed" ? 0 : 3;
  } catch (err) {
    if (err instanceof Refusal) {
      error(`REFUSED: ${err.message} Nothing was sent.`);
      return 2;
    }
    throw err;
  }
}
