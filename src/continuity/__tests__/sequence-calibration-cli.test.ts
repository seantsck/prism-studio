import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { materialChecksums } from "../calibration/sequence-calibration";
import { runSequenceCalibrationCli } from "../calibration/sequence-calibration-cli";
import { sequenceInputHash } from "../calibration/sequence-fixtures";
import { sequenceOracle } from "../calibration/sequence-oracle";
import { FakeGeminiTransport } from "../providers/gemini/fake-transport";
import { GeminiTransportError } from "../providers/gemini/transport";
import { stubMaterials } from "./sequence-calibration-stub";

/**
 * CLI ORDERING: every live refusal happens BEFORE the network transport exists. Three independent tripwires: the
 * injected factory, the SDK client constructor (mocked: it must never run here) and a trapped global fetch. No real
 * credential is used and nothing can leave the process.
 */
const sdk = vi.hoisted(() => ({ created: 0 }));
vi.mock("@google/genai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@google/genai")>()),
  GoogleGenAI: class {
    constructor() {
      sdk.created += 1;
      throw new Error("the Gemini SDK client must not be created in this test");
    }
  },
}));

const materials = stubMaterials();
const HASH = sequenceInputHash(materialChecksums(materials));
const READY = [
  "--live",
  "--model",
  "gemini-3.8-flash",
  "--max-calls",
  "120",
  "--max-usd",
  "2",
  "--input-hash",
  HASH,
  "--max-rpm",
  "1000",
  "--max-tpm",
  "100000000",
  "--max-rpd",
  "1000",
  "--confirm-rpd-remaining",
  "--billing-active",
  "yes",
  "--project-tier",
  "Tier 1",
  "--spend-cap",
  "none",
  "--i-understand-this-sends-synthetic-video-and-costs-money",
  "--out",
  "never-written.json",
] as const;
const ENV = {
  PRISM_STUDIO_SEQUENCE_CALIBRATION_LIVE: "1",
  PRISM_STUDIO_ALLOW_PAID_ANALYSIS: "1",
  GEMINI_API_KEY: "test-key-not-a-real-credential",
};
const without = (name: string) => {
  const i = READY.indexOf(name as (typeof READY)[number]);
  const takesValue = i + 1 < READY.length && !READY[i + 1]!.startsWith("--");
  return READY.filter((_, j) => j !== i && !(takesValue && j === i + 1));
};
const withValue = (name: string, v: string) => {
  const i = READY.indexOf(name as (typeof READY)[number]);
  return READY.map((a, j) => (j === i + 1 ? v : a));
};

let realFetch: typeof fetch;
let outbound = 0;
beforeEach(() => {
  sdk.created = 0;
  outbound = 0;
  realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    outbound += 1;
    throw new Error("network trapped");
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  expect(outbound).toBe(0);
  expect(sdk.created).toBe(0);
});

async function cli(
  argv: readonly string[],
  env: Record<string, string | undefined> = ENV,
  o: {
    transport?: FakeGeminiTransport;
    preregistered?: { inputHash: string };
  } = {},
) {
  const errors: string[] = [];
  const logs: string[] = [];
  const written: Array<{ path: string; json: string }> = [];
  const createLiveTransport = vi.fn(async () => {
    if (o.transport) return o.transport;
    throw new Error("sentinel: the live transport factory was reached");
  });
  const prepare = vi.fn(async () => materials);
  const code = await runSequenceCalibrationCli({
    argv,
    env,
    createLiveTransport,
    prepare,
    preregistered: o.preregistered ?? { inputHash: HASH },
    sleep: async () => undefined,
    log: (l) => void logs.push(l),
    error: (l) => void errors.push(l),
    writeReport: (path, json) => void written.push({ path, json }),
  });
  return { code, errors, logs, written, createLiveTransport, prepare };
}

describe("sequence calibration CLI: live refusals come before any transport", () => {
  const cases: Array<[string, readonly string[], RegExp, Record<string, string | undefined>?]> = [
    [
      "no acknowledgement",
      without("--i-understand-this-sends-synthetic-video-and-costs-money"),
      /--live needs --i-understand/,
    ],
    [
      "no live env",
      READY,
      /PRISM_STUDIO_SEQUENCE_CALIBRATION_LIVE=1 is not set/,
      { ...ENV, PRISM_STUDIO_SEQUENCE_CALIBRATION_LIVE: undefined },
    ],
    [
      "the temporal live env does not count",
      READY,
      /PRISM_STUDIO_SEQUENCE_CALIBRATION_LIVE=1 is not set/,
      {
        PRISM_STUDIO_TEMPORAL_CALIBRATION_LIVE: "1",
        PRISM_STUDIO_ALLOW_PAID_ANALYSIS: "1",
        GEMINI_API_KEY: "x",
      },
    ],
    [
      "no paid env",
      READY,
      /PRISM_STUDIO_ALLOW_PAID_ANALYSIS=1 is not set/,
      { ...ENV, PRISM_STUDIO_ALLOW_PAID_ANALYSIS: "true" },
    ],
    ["no model", without("--model"), /--model is required/],
    ["an unlisted model", withValue("--model", "gemini-made-up"), /gemini-made-up|not/i],
    ["no max calls", without("--max-calls"), /--max-calls must be an integer of at least 60/],
    [
      "max calls under the plan",
      withValue("--max-calls", "59"),
      /--max-calls must be an integer of at least 60/,
    ],
    ["fractional max calls", withValue("--max-calls", "60.5"), /--max-calls must be/],
    ["no max usd", without("--max-usd"), /--max-usd must be a positive amount/],
    ["zero max usd", withValue("--max-usd", "0"), /--max-usd must be a positive amount/],
    ["a worst case above max usd", withValue("--max-usd", "0.01"), /worst-case estimate/],
    ["no RPM", without("--max-rpm"), /--max-rpm must be the project's active RPM limit/],
    ["fractional RPM", withValue("--max-rpm", "7.5"), /--max-rpm must be/],
    ["no TPM", without("--max-tpm"), /--max-tpm must be the project's active TPM limit/],
    ["no RPD", without("--max-rpd"), /--max-rpd must be the project's active RPD limit/],
    [
      "no remaining RPD confirmation",
      without("--confirm-rpd-remaining"),
      /--confirm-rpd-remaining is required/,
    ],
    ["no billing", without("--billing-active"), /--billing-active yes is required/],
    ["billing not active", withValue("--billing-active", "no"), /--billing-active yes is required/],
    ["no tier", without("--project-tier"), /--project-tier is required/],
    ["no spend cap", without("--spend-cap"), /--spend-cap is required/],
    ["no input hash", without("--input-hash"), /--input-hash is required/],
    ["a wrong input hash", withValue("--input-hash", "0".repeat(64)), /--input-hash does not match/],
    [
      "no credential",
      READY,
      /GEMINI_API_KEY is not set/,
      { PRISM_STUDIO_SEQUENCE_CALIBRATION_LIVE: "1", PRISM_STUDIO_ALLOW_PAID_ANALYSIS: "1" },
    ],
  ];
  for (const [name, argv, re, env] of cases)
    it(`${name}: exit 2, zero transports`, async () => {
      const r = await cli(argv, env);
      expect(r.code).toBe(2);
      expect(r.errors.join(" ")).toMatch(re);
      expect(r.errors.join(" ")).toContain("Nothing was sent.");
      expect(r.createLiveTransport).not.toHaveBeenCalled();
      expect(r.written).toEqual([]);
    });

  it("a computed hash other than the reviewed one refuses, whatever the flag says", async () => {
    const r = await cli(READY, ENV, { preregistered: { inputHash: "f".repeat(64) } });
    expect(r.code).toBe(2);
    expect(r.errors.join(" ")).toMatch(/differs from the reviewed one/);
    expect(r.createLiveTransport).not.toHaveBeenCalled();
  });

  it("gate refusals happen before any media work", async () => {
    const r = await cli(without("--max-rpm"));
    expect(r.prepare).not.toHaveBeenCalled();
  });

  it("a TPM too low for the paced plan refuses before any request", async () => {
    const transport = new FakeGeminiTransport(sequenceOracle(materials, "truthful"));
    const r = await cli(withValue("--max-tpm", "1000"), ENV, { transport });
    expect(r.code).toBe(2);
    expect(r.errors.join(" ")).toMatch(/above the TPM limit/);
    expect(transport.calls).toBe(0);
    expect(r.written).toEqual([]);
  });
});

describe("sequence calibration CLI: the default is offline", () => {
  it("no flags and no env: the fake oracle, the hash printed, a report, exit 0, no factory", async () => {
    const r = await cli(["--out", "fake.json"], {});
    expect(r.code).toBe(0);
    expect(r.createLiveTransport).not.toHaveBeenCalled();
    const log = r.logs.join("\n");
    expect(log).toContain(`CALIBRATION INPUT HASH: ${HASH}`);
    expect(log).toContain("MATCHES THE REVIEWED HASH: YES");
    expect(log).toContain("FAKE transport");
    expect(log).toContain("ACCEPTED  screen_direction  6/6");
    expect(log).toContain("actual=$0 (nothing left Prism");
    expect(log).toContain("Production configuration is unchanged.");
    const report = JSON.parse(r.written[0]!.json) as { transport: string; operator: unknown };
    expect(report.transport).toBe("fake");
    expect(report.operator).toBeNull();
  });

  it("the live env alone never goes live without --live", async () => {
    const r = await cli(["--out", "fake.json"], ENV);
    expect(r.code).toBe(0);
    expect(r.createLiveTransport).not.toHaveBeenCalled();
  });

  it("offline, a hash mismatch is reported but does not refuse", async () => {
    const r = await cli(["--out", "fake.json"], {}, { preregistered: { inputHash: "f".repeat(64) } });
    expect(r.code).toBe(0);
    expect(r.logs.join("\n")).toContain("MATCHES THE REVIEWED HASH: NO");
  });
});

describe("sequence calibration CLI: with every gate passed (fake transport standing in)", () => {
  it("creates the transport once, after every check, and records the operator's readiness", async () => {
    const transport = new FakeGeminiTransport(sequenceOracle(materials, "truthful"));
    const r = await cli(READY, ENV, { transport });
    expect(r.code).toBe(0);
    expect(r.createLiveTransport).toHaveBeenCalledTimes(1);
    expect(transport.calls).toBe(60);
    const report = JSON.parse(r.written[0]!.json) as {
      transport: string;
      operator: { projectTier: string; billingActive: boolean };
    };
    expect(report.transport).toBe("live");
    expect(report.operator).toMatchObject({ projectTier: "Tier 1", billingActive: true });
    expect(JSON.stringify(report)).not.toContain(ENV.GEMINI_API_KEY);
    expect(r.logs.join("\n")).toContain("BILLING ACTIVE: YES");
  });

  it("an abort writes the partial report and exits 3", async () => {
    const transport = new FakeGeminiTransport([
      {
        kind: "error",
        error: new GeminiTransportError("invalid_input", 402, "prepayment credits are depleted"),
      },
    ]);
    const r = await cli(READY, ENV, { transport });
    expect(r.code).toBe(3);
    expect(transport.calls).toBe(1);
    expect(r.written).toHaveLength(1);
    expect(r.logs.join("\n")).toContain("abort=provider_billing_error");
    expect(r.logs.join("\n")).toContain("NOT_MEASURED  screen_direction");
  });
});
