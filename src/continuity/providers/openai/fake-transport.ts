import {
  OpenAITransportError,
  type OpenAIRequest,
  type OpenAIResponse,
  type OpenAITransport,
  type OpenAIUsage,
} from "./transport";

/**
 * Deterministic in-memory transport for tests, the pre-paid check and local development. Never touches the
 * network. Scripted behaviour per call; records every request it received (image bytes are summarised).
 */
export type OpenAIFakeStep =
  | { kind: "json"; body: unknown; usage?: Partial<OpenAIUsage>; status?: string }
  | { kind: "text"; text: string; usage?: Partial<OpenAIUsage>; status?: string }
  | { kind: "error"; error: OpenAITransportError }
  | { kind: "refusal"; text?: string }
  | { kind: "incomplete"; reason: "max_output_tokens" | "content_filter"; partial?: string }
  | { kind: "no_usage"; body: unknown };

export interface OpenAIRecordedRequest {
  model: string;
  instructions: string;
  textParts: string[];
  images: number;
  imageDetails: string[];
  imageUrlPrefixes: string[];
  turns: number;
  maxOutputTokens: number;
  reasoningEffort: string;
  schemaName: string;
  strict: boolean;
}

const DEFAULT_USAGE: OpenAIUsage = {
  inputTokens: 2400,
  outputTokens: 360,
  reasoningTokens: 60,
  cachedTokens: 0,
  totalTokens: 2760,
};

export class FakeOpenAITransport implements OpenAITransport {
  readonly requests: OpenAIRecordedRequest[] = [];
  /** The full requests (test inspection only; media are data URLs held in memory). */
  readonly raw: OpenAIRequest[] = [];
  private i = 0;

  constructor(
    private readonly script: OpenAIFakeStep[] | ((req: OpenAIRequest, n: number) => OpenAIFakeStep),
  ) {}

  get calls() {
    return this.requests.length;
  }

  async create(req: OpenAIRequest): Promise<OpenAIResponse> {
    const parts = req.input.flatMap((t) => t.content);
    this.raw.push(req);
    this.requests.push({
      model: req.model,
      instructions: req.instructions,
      textParts: parts.flatMap((p) => (p.type === "input_text" || p.type === "output_text" ? [p.text] : [])),
      images: parts.filter((p) => p.type === "input_image").length,
      imageDetails: parts.flatMap((p) => (p.type === "input_image" ? [p.detail] : [])),
      imageUrlPrefixes: parts.flatMap((p) => (p.type === "input_image" ? [p.imageUrl.slice(0, 22)] : [])),
      turns: req.input.length,
      maxOutputTokens: req.maxOutputTokens,
      reasoningEffort: req.reasoningEffort,
      schemaName: req.schemaName,
      strict: Boolean(req.jsonSchema),
    });
    const n = this.i++;
    const step =
      typeof this.script === "function"
        ? this.script(req, n)
        : (this.script[Math.min(n, this.script.length - 1)] as OpenAIFakeStep);
    if (!step) throw new Error("FakeOpenAITransport: no scripted step");
    const base = { responseId: `resp_fake_${n}`, modelVersion: req.model };
    switch (step.kind) {
      case "error":
        throw step.error;
      case "refusal":
        return {
          ...base,
          text: null,
          status: "completed",
          incompleteReason: null,
          refusal: step.text ?? "I can't help with that.",
          usage: { ...DEFAULT_USAGE, outputTokens: 20, reasoningTokens: 0 },
        };
      case "incomplete":
        return {
          ...base,
          text: step.partial ?? null,
          status: "incomplete",
          incompleteReason: step.reason,
          refusal: null,
          usage: DEFAULT_USAGE,
        };
      case "no_usage":
        return {
          ...base,
          text: JSON.stringify(step.body),
          status: "completed",
          incompleteReason: null,
          refusal: null,
          usage: null,
        };
      case "text":
        return {
          ...base,
          text: step.text,
          status: step.status ?? "completed",
          incompleteReason: null,
          refusal: null,
          usage: { ...DEFAULT_USAGE, ...step.usage },
        };
      case "json":
        return {
          ...base,
          text: JSON.stringify(step.body),
          status: step.status ?? "completed",
          incompleteReason: null,
          refusal: null,
          usage: { ...DEFAULT_USAGE, ...step.usage },
        };
    }
  }
}

/** A valid answer for exactly the criteria the request asks about (reads DATA from the first user text part). */
export function openaiAnswerAll(
  result: "pass" | "warn" | "fail" | "unchecked" = "pass",
  evidenceInput?: string,
): (req: OpenAIRequest) => OpenAIFakeStep {
  return (req) => {
    const data = req.input[0]!.content.flatMap((p) => (p.type === "input_text" ? [p.text] : [])).find((t) =>
      t.startsWith("DATA"),
    );
    const json = JSON.parse(data!.slice(data!.indexOf("{"))) as {
      criteria: Array<{ criterionId: string }>;
      inputs: Array<{ inputId: string }>;
    };
    const input = evidenceInput ?? json.inputs.at(-1)?.inputId ?? "none";
    return {
      kind: "json",
      body: {
        criteria: json.criteria.map((c) => ({
          criterionId: c.criterionId,
          result,
          confidence: 0.8,
          summary: `Appears ${result === "pass" ? "consistent" : "inconsistent"} with the expectation.`,
          evidence: [{ input, timestampMs: null, observation: "Visible in the supplied frame." }],
          contradictions: result === "fail" ? ["Differs from the reference."] : [],
          limitations: [],
        })),
      },
    };
  };
}
