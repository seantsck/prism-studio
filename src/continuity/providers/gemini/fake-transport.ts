import {
  GeminiTransportError,
  type GeminiRequest,
  type GeminiResponse,
  type GeminiTransport,
} from "./transport";

/**
 * Deterministic in-memory transport for tests, the pre-paid check and local development. Never touches the
 * network. Scripted behaviour per call; records every request it received (media bytes are summarised).
 */
export type FakeStep =
  | {
      kind: "json";
      body: unknown;
      usage?: Partial<NonNullable<GeminiResponse["usage"]>>;
      finishReason?: string;
    }
  | {
      kind: "text";
      text: string;
      usage?: Partial<NonNullable<GeminiResponse["usage"]>>;
      finishReason?: string;
    }
  | { kind: "error"; error: GeminiTransportError }
  | { kind: "block"; blockReason: string }
  | { kind: "finish"; finishReason: string };

export interface RecordedRequest {
  model: string;
  systemInstruction: string;
  textParts: string[];
  inlineMedia: number;
  turns: number;
  maxOutputTokens: number;
  /** 3A.3: media parts by kind, and the sampling rate each video part carried. Never the bytes or file URI. */
  inlineVideos: number;
  fileParts: number;
  videoFps: number[];
  /** Whether the request used the direct-video structured-output schema (has `endMs`). */
  videoSchema: boolean;
}

const DEFAULT_USAGE = { promptTokens: 2000, candidatesTokens: 300, thoughtsTokens: 40, totalTokens: 2340 };

export class FakeGeminiTransport implements GeminiTransport {
  readonly requests: RecordedRequest[] = [];
  private i = 0;

  constructor(private readonly script: FakeStep[] | ((req: GeminiRequest, n: number) => FakeStep)) {}

  get calls() {
    return this.requests.length;
  }

  /** Files API doubles (recorded; deletion can be made to fail). */
  readonly uploads: Array<{ name: string; mimeType: string; bytes: number }> = [];
  readonly deleted: string[] = [];
  failDelete = false;

  async uploadFile(args: { bytes: Uint8Array; mimeType: string; displayName: string }) {
    const name = `files/fake-${this.uploads.length + 1}`;
    this.uploads.push({ name, mimeType: args.mimeType, bytes: args.bytes.length });
    return { name, uri: `fake://${name}` };
  }

  async deleteFile(name: string): Promise<void> {
    if (this.failDelete) throw new GeminiTransportError("server_error", 500, "delete failed");
    this.deleted.push(name);
  }

  async generate(req: GeminiRequest): Promise<GeminiResponse> {
    this.requests.push({
      model: req.model,
      systemInstruction: req.systemInstruction,
      textParts: req.turns.flatMap((t) => t.parts.flatMap((p) => (p.type === "text" ? [p.text] : []))),
      inlineMedia: req.turns.reduce((n, t) => n + t.parts.filter((p) => p.type === "inline").length, 0),
      turns: req.turns.length,
      maxOutputTokens: req.maxOutputTokens,
      inlineVideos: req.turns.reduce(
        (n, t) => n + t.parts.filter((p) => p.type === "inline" && p.mimeType.startsWith("video/")).length,
        0,
      ),
      fileParts: req.turns.reduce((n, t) => n + t.parts.filter((p) => p.type === "file").length, 0),
      videoFps: req.turns.flatMap((t) =>
        t.parts.flatMap((p) => (p.type !== "text" && p.videoFps ? [p.videoFps] : [])),
      ),
      videoSchema: JSON.stringify(req.responseJsonSchema).includes('"endMs"'),
    });
    const n = this.i++;
    const step =
      typeof this.script === "function"
        ? this.script(req, n)
        : (this.script[Math.min(n, this.script.length - 1)] as FakeStep);
    if (!step) throw new Error("FakeGeminiTransport: no scripted step");
    switch (step.kind) {
      case "error":
        throw step.error;
      case "block":
        return {
          text: null,
          finishReason: null,
          blockReason: step.blockReason,
          usage: { ...DEFAULT_USAGE, candidatesTokens: 0, thoughtsTokens: 0 },
          responseId: `fake-${n}`,
          modelVersion: "fake",
        };
      case "finish":
        return {
          text: null,
          finishReason: step.finishReason,
          blockReason: null,
          usage: DEFAULT_USAGE,
          responseId: `fake-${n}`,
          modelVersion: "fake",
        };
      case "text":
        return {
          text: step.text,
          finishReason: step.finishReason ?? "STOP",
          blockReason: null,
          usage: { ...DEFAULT_USAGE, ...step.usage },
          responseId: `fake-${n}`,
          modelVersion: "fake",
        };
      case "json":
        return {
          text: JSON.stringify(step.body),
          finishReason: step.finishReason ?? "STOP",
          blockReason: null,
          usage: { ...DEFAULT_USAGE, ...step.usage },
          responseId: `fake-${n}`,
          modelVersion: "fake",
        };
    }
  }
}

/** A valid answer for exactly the criteria the request asks about (reads DATA from the first text part). */
export function answerAll(
  result: "pass" | "warn" | "fail" | "unchecked" = "pass",
  evidenceInput?: string,
): (req: GeminiRequest) => FakeStep {
  return (req) => {
    const data = req.turns[0]!.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).find((t) =>
      t.startsWith("DATA"),
    );
    const json = JSON.parse(data!.slice(data!.indexOf("{"))) as {
      criteria: Array<{ criterionId: string }>;
      inputs: Array<{ inputId: string }>;
      video?: { durationMs: number | null };
    };
    const input = evidenceInput ?? json.inputs.at(-1)?.inputId ?? "none";
    // a cut (3A.4D): the sequence contract needs evidence from BOTH sides, each with an explicit endMs
    const sided =
      !evidenceInput && json.inputs.some((i) => i.inputId === "left:last")
        ? ["left:last", "right:first"].map((i) => ({
            input: i,
            timestampMs: null,
            endMs: null,
            observation: "Visible in this edge frame.",
          }))
        : null;
    // a direct-video batch: timestamped interval evidence inside the clip (schema 2)
    const duration = json.video?.durationMs ?? null;
    const evidence = sided
      ? sided
      : json.video && duration
        ? [
            {
              input,
              timestampMs: Math.round(duration * 0.2),
              endMs: Math.round(duration * 0.6),
              observation: "Observed across this interval of the clip.",
            },
          ]
        : [{ input, timestampMs: null, observation: "Visible in the supplied frame." }];
    return {
      kind: "json",
      body: {
        criteria: json.criteria.map((c) => ({
          criterionId: c.criterionId,
          result,
          confidence: 0.8,
          summary: `Appears ${result === "pass" ? "consistent" : "inconsistent"} with the expectation.`,
          evidence,
          contradictions: result === "fail" ? ["Differs from the reference."] : [],
          limitations: [],
        })),
      },
    };
  };
}
