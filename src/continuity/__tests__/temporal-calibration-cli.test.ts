import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCalibrationCli } from "../calibration/temporal-calibration-cli";

/**
 * CLI ORDERING: every live refusal (acknowledgement, env flags, model, ceilings, the operator's quota/billing
 * readiness, model check, credential) happens BEFORE the network transport exists. Three independent tripwires: the
 * injected transport factory, the SDK client constructor (mocked: it must never run here) and a trapped global fetch.
 * No real credential is used and nothing can leave the process.
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

const READY = [
  "--live",
  "--model",
  "gemini-3.8-flash",
  "--max-calls",
  "48",
  "--max-usd",
  "1.25",
  "--max-rpm",
  "10",
  "--max-tpm",
  "2000000",
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
  PRISM_STUDIO_TEMPORAL_CALIBRATION_LIVE: "1",
  PRISM_STUDIO_ALLOW_PAID_ANALYSIS: "1",
  GEMINI_API_KEY: "test-key-not-a-real-credential",
};
/** READY without a flag (and its value, when it takes one). */
const without = (name: string) => {
  const i = READY.indexOf(name as (typeof READY)[number]);
  const takesValue = i + 1 < READY.length && !READY[i + 1]!.startsWith("--");
  return READY.filter((_, j) => j !== i && !(takesValue && j === i + 1));
};
/** READY with a flag's value replaced. */
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
});

async function cli(argv: readonly string[], env: Record<string, string | undefined> = ENV) {
  const errors: string[] = [];
  const written: string[] = [];
  const createLiveTransport = vi.fn(async () => {
    throw new Error("sentinel: the live transport factory was reached");
  });
  let thrown: unknown = null;
  let code: number | null = null;
  try {
    code = await runCalibrationCli({
      argv,
      env,
      createLiveTransport,
      log: () => undefined,
      error: (l) => void errors.push(l),
      writeReport: (p) => void written.push(p),
    });
  } catch (err) {
    thrown = err;
  }
  return {
    code,
    thrown,
    errors,
    written,
    factoryCalls: createLiveTransport.mock.calls.length,
    createLiveTransport,
  };
}

describe("calibration CLI: live readiness is validated before any SDK transport exists", () => {
  const cases: Array<[string, readonly string[], RegExp, Record<string, string | undefined>?]> = [
    ["missing --max-rpm", without("--max-rpm"), /--max-rpm must be the project's active RPM limit/],
    ["non-positive --max-rpm", withValue("--max-rpm", "0"), /--max-rpm must be/],
    ["fractional --max-rpm", withValue("--max-rpm", "7.5"), /--max-rpm must be/],
    [
      "non-numeric --max-tpm",
      withValue("--max-tpm", "lots"),
      /--max-tpm must be the project's active TPM limit/,
    ],
    ["missing --max-tpm", without("--max-tpm"), /--max-tpm must be/],
    ["missing --max-rpd", without("--max-rpd"), /--max-rpd must be the project's active RPD limit/],
    ["negative --max-rpd", withValue("--max-rpd", "-5"), /--max-rpd must be/],
    [
      "no remaining-RPD confirmation",
      without("--confirm-rpd-remaining"),
      /--confirm-rpd-remaining is required/,
    ],
    ["billing not active", withValue("--billing-active", "no"), /--billing-active yes is required/],
    ["billing not declared", without("--billing-active"), /--billing-active yes is required/],
    ["no project tier", without("--project-tier"), /--project-tier is required/],
    ["blank project tier", withValue("--project-tier", "  "), /--project-tier is required/],
    ["no spend cap", without("--spend-cap"), /--spend-cap is required/],
    [
      "no acknowledgement flag",
      without("--i-understand-this-sends-synthetic-video-and-costs-money"),
      /--i-understand/,
    ],
    [
      "live env flag unset",
      READY,
      /PRISM_STUDIO_TEMPORAL_CALIBRATION_LIVE=1 is not set/,
      { ...ENV, PRISM_STUDIO_TEMPORAL_CALIBRATION_LIVE: undefined },
    ],
    [
      "paid-analysis flag off",
      READY,
      /PRISM_STUDIO_ALLOW_PAID_ANALYSIS=1 is not set/,
      { ...ENV, PRISM_STUDIO_ALLOW_PAID_ANALYSIS: "false" },
    ],
    ["no model", without("--model"), /--model is required/],
    ["invalid --max-calls", withValue("--max-calls", "0"), /--max-calls must be a positive integer/],
    ["invalid --max-usd", withValue("--max-usd", "Infinity"), /--max-usd must be a positive amount/],
    ["unverified model", withValue("--model", "gemini-unverified-model"), /gemini-unverified-model/],
    ["no credential", READY, /GEMINI_API_KEY is not set/, { ...ENV, GEMINI_API_KEY: undefined }],
  ];

  for (const [name, argv, reason, env] of cases) {
    it(`refuses (${name}): exit 2, the failed requirement named, no transport, no SDK client, no request`, async () => {
      const r = await cli(argv, env);
      expect(r.thrown).toBeNull();
      expect(r.code).toBe(2);
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]).toMatch(/^REFUSED: /);
      expect(r.errors[0]).toMatch(reason);
      expect(r.errors[0]).toMatch(/Nothing was sent\.$/);
      expect(r.factoryCalls).toBe(0);
      expect(sdk.created).toBe(0);
      expect(outbound).toBe(0);
      expect(r.written).toEqual([]);
    });
  }

  it("names EVERY missing readiness requirement at once (nothing partially accepted)", async () => {
    const bare = READY.filter(
      (a, j) =>
        ![
          "--max-rpm",
          "--max-tpm",
          "--max-rpd",
          "--confirm-rpd-remaining",
          "--billing-active",
          "--project-tier",
          "--spend-cap",
        ].includes(a) &&
        ![
          "--max-rpm",
          "--max-tpm",
          "--max-rpd",
          "--billing-active",
          "--project-tier",
          "--spend-cap",
        ].includes(READY[j - 1] ?? ""),
    );
    const r = await cli(bare);
    expect(r.code).toBe(2);
    for (const req of [
      "--max-rpm",
      "--max-tpm",
      "--max-rpd",
      "--confirm-rpd-remaining",
      "--billing-active yes",
      "--project-tier",
      "--spend-cap",
    ])
      expect(r.errors[0]).toContain(req);
    expect(r.factoryCalls).toBe(0);
    expect(sdk.created).toBe(0);
    expect(outbound).toBe(0);
  });

  it("control: with complete readiness the factory is reached exactly once (with the key) — still nothing sent", async () => {
    const r = await cli(READY);
    expect(r.thrown).toBeInstanceOf(Error);
    expect((r.thrown as Error).message).toMatch(/sentinel: the live transport factory was reached/);
    expect(r.factoryCalls).toBe(1);
    expect(r.createLiveTransport).toHaveBeenCalledWith("test-key-not-a-real-credential");
    expect(sdk.created).toBe(0);
    expect(outbound).toBe(0);
    expect(r.written).toEqual([]);
  });
});
