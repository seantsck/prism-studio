import { encodeSpzFile, syntheticPlane } from "@/lib/splat/synthetic";
import {
  ProviderError,
  type ExtractedResult,
  type OperationSnapshot,
  type PreparedInput,
  type ProviderCapabilities,
  type ProviderInputImage,
  type ProviderStatus,
  type ReconstructionProvider,
  type ResultCandidate,
  type SubmitRequest,
} from "./provider";

/**
 * `mock_reconstruction`: a deterministic, FREE, test/dev-only provider. It is never offered in a production build
 * unless PRISM_STUDIO_ENABLE_MOCK_RECONSTRUCTION=1 (the E2E servers), and the UI labels it as a test provider.
 *
 * Operations are stateless: the id encodes the scenario and the start time, so a job resumes correctly after a page
 * navigation or a server restart. Scenarios (job option `scenario`):
 *   success      progress for `durationMs`, then a valid synthetic SPZ (generated from documented primitives)
 *   fail         progress, then a provider failure
 *   invalid      succeeds with bytes that are NOT a splat (Prism validation must refuse it)
 *   oversize     succeeds with a result larger than Prism's cap (refused before any byte is stored)
 *   slow         keeps running (for cancellation tests)
 *   submit_timeout  the submit call gets no answer (an ambiguous submission)
 */
export const MOCK_SCENARIOS = ["success", "fail", "invalid", "oversize", "slow", "submit_timeout"] as const;
export type MockScenario = (typeof MOCK_SCENARIOS)[number];

const cancelled = new Set<string>();

export interface MockConfig {
  available: boolean;
  durationMs: number;
}

export function readMockConfig(env: Record<string, string | undefined> = process.env): MockConfig {
  const durationMs = Number.parseInt(env.PRISM_STUDIO_MOCK_RECONSTRUCTION_MS ?? "", 10);
  return {
    available: env.NODE_ENV !== "production" || env.PRISM_STUDIO_ENABLE_MOCK_RECONSTRUCTION === "1",
    durationMs: Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 8000,
  };
}

const parse = (operationId: string) => {
  const m = /^mockop_([a-z_]+)_(\d+)_(\d+)_([0-9a-f]{6})$/.exec(operationId);
  if (!m) throw new ProviderError("invalid_request", "Unknown mock operation.");
  return { scenario: m[1] as MockScenario, startedAt: Number(m[2]), sources: Number(m[3]), seed: m[4]! };
};

export class MockReconstructionProvider implements ReconstructionProvider {
  readonly id = "mock_reconstruction" as const;

  constructor(
    private readonly config: MockConfig,
    private readonly now: () => number = () => Date.now(),
  ) {}

  capabilities(): ProviderCapabilities {
    return {
      capability: "mock_world",
      inputModes: ["single_image", "multi_image"],
      resultKinds: ["gaussian_splat"],
      maxImages: 8,
      models: [{ id: "mock-1", label: "Mock (test)", credits: null, usd: { min: 0, max: 0 } }],
      defaultModel: "mock-1",
      supportsCancel: true,
      supportsProgress: true,
      supportsWebhooks: false,
      supportsIdempotencyKey: true,
      requiresPublicInputUrls: false,
      supportsProviderAssetUpload: true,
      billable: false,
      testOnly: true,
    };
  }

  status(): ProviderStatus {
    return {
      provider: this.id,
      label: "Mock Reconstruction (test only)",
      configured: true,
      enabled: this.config.available,
      capability: this.config.available ? "available" : "unavailable",
      reason: this.config.available ? null : "The mock provider exists only in development and test servers.",
    };
  }

  async prepareInputs(images: ProviderInputImage[], reusable: PreparedInput[]): Promise<PreparedInput[]> {
    return images.map((img) => {
      const prior = reusable.find((r) => r.assetId === img.assetId && r.checksum === img.checksum);
      return {
        ordinal: img.ordinal,
        assetId: img.assetId,
        checksum: img.checksum,
        providerAssetId: prior?.providerAssetId ?? `mockasset_${(img.checksum ?? img.assetId).slice(0, 16)}`,
      };
    });
  }

  async submit(req: SubmitRequest): Promise<OperationSnapshot> {
    const scenario = (req.options.provider.scenario as MockScenario | undefined) ?? "success";
    if (!MOCK_SCENARIOS.includes(scenario))
      throw new ProviderError("invalid_request", "Unknown mock scenario.");
    if (scenario === "submit_timeout")
      throw new ProviderError("timeout", "The mock provider did not answer.");
    const seed = req.idempotencyKey
      .slice(-6)
      .replace(/[^0-9a-f]/g, "0")
      .padStart(6, "0");
    const id = `mockop_${scenario}_${this.now()}_${req.inputs.length}_${seed}`;
    return this.getOperation(id);
  }

  async getOperation(operationId: string): Promise<OperationSnapshot> {
    const op = parse(operationId);
    const elapsed = this.now() - op.startedAt;
    const base = { operationId, summary: { scenario: op.scenario, sources: op.sources }, rawResult: null };
    if (cancelled.has(operationId))
      return { ...base, status: "cancelled", progress: null, description: "Cancelled", error: null };
    if (op.scenario === "slow" || elapsed < this.config.durationMs) {
      const progress =
        op.scenario === "slow" ? 0.1 : Math.min(0.95, elapsed / Math.max(1, this.config.durationMs));
      return { ...base, status: "running", progress, description: "Reconstructing (mock)", error: null };
    }
    if (op.scenario === "fail")
      return {
        ...base,
        status: "failed",
        progress: null,
        description: null,
        error: { code: "mock_failure", message: "The mock provider failed this reconstruction on purpose." },
      };
    return {
      ...base,
      status: "succeeded",
      progress: 1,
      description: "Done",
      error: null,
      rawResult: { scenario: op.scenario, sources: op.sources, seed: op.seed },
    };
  }

  async cancel(operationId: string): Promise<boolean> {
    parse(operationId);
    cancelled.add(operationId);
    return true;
  }

  extractResult(op: OperationSnapshot): ExtractedResult {
    const r = op.rawResult as { scenario: MockScenario; sources: number; seed: string } | null;
    if (!r) return { candidates: [], metricScaleFactor: null, groundPlaneOffset: null, metadata: {} };
    return {
      candidates: [{ kind: "gaussian_splat", format: "spz", label: "full_res", transport: r }],
      // the mock makes no scale claim, like a provider that cannot infer one
      metricScaleFactor: null,
      groundPlaneOffset: null,
      metadata: { scenario: r.scenario, sources: r.sources, resolution: "full_res" },
    };
  }

  async download(candidate: ResultCandidate, maxBytes: number): Promise<Uint8Array> {
    const r = candidate.transport as { scenario: MockScenario; sources: number; seed: string };
    if (r.scenario === "oversize") {
      // declared far above any cap: refused without allocating it
      if (maxBytes < 64 * 1024 * 1024)
        throw new ProviderError("too_large", "The result is larger than Prism accepts.");
    }
    if (r.scenario === "invalid") return new TextEncoder().encode("this is not a gaussian splat");
    const hue = Number.parseInt(r.seed.slice(0, 2), 16);
    return encodeSpzFile(
      syntheticPlane({
        n: 16 + r.sources * 4,
        size: 2,
        cy: 1,
        rgb: [80 + (hue % 150), 140, 220 - (hue % 120)],
      }),
    );
  }
}
