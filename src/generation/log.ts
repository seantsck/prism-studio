import { describeError, redactText } from "@/lib/auth/redact";

/**
 * Structured generation logging. Safe fields only: ids, provider/model, status, durations, counts and error
 * CATEGORIES. Prompts, dialogue audio, signed URLs, credentials, cookies and headers are never logged.
 */
export interface GenerationLogFields {
  event: string;
  jobId?: string;
  attemptId?: string;
  provider?: string;
  model?: string;
  status?: string;
  durationMs?: number;
  attemptCount?: number;
  errorCategory?: string;
  errorCode?: string;
  note?: string;
  [key: string]: unknown;
}

export interface GenerationLogger {
  info(fields: GenerationLogFields): void;
  warn(fields: GenerationLogFields): void;
  error(fields: GenerationLogFields, err?: unknown): void;
}

const SAFE_KEYS = new Set([
  "event",
  "jobId",
  "attemptId",
  "provider",
  "model",
  "status",
  "durationMs",
  "attemptCount",
  "errorCategory",
  "errorCode",
  "note",
  "workerId",
  "count",
  "phase",
  "outputs",
  "bytes",
  "nextRunInMs",
  "ref",
  "claimed",
]);

function render(level: string, fields: GenerationLogFields, err?: unknown): string {
  const safe: Record<string, unknown> = { level, at: new Date().toISOString() };
  for (const [k, v] of Object.entries(fields)) {
    if (!SAFE_KEYS.has(k)) continue; // anything not explicitly allow-listed is dropped
    safe[k] = typeof v === "string" ? redactText(v) : v;
  }
  if (err !== undefined) safe.error = describeError(err);
  return JSON.stringify(safe);
}

export const consoleLogger: GenerationLogger = {
  info: (f) => console.log(render("info", f)),
  warn: (f) => console.warn(render("warn", f)),
  error: (f, e) => console.error(render("error", f, e)),
};

export const silentLogger: GenerationLogger = { info() {}, warn() {}, error() {} };

/** Test helper: records rendered lines. */
export function memoryLogger(): GenerationLogger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (f) => void lines.push(render("info", f)),
    warn: (f) => void lines.push(render("warn", f)),
    error: (f, e) => void lines.push(render("error", f, e)),
  };
}
