/**
 * Sanitisers for anything that might reach a log line, an error page or telemetry.
 * Strips: URL fragments, access/refresh/id tokens, authorization codes, token hashes, passwords, JWTs,
 * Authorization/Cookie/Set-Cookie header values and Postgres connection strings.
 * (scripts/lib/safety.mjs holds the equivalent for maintenance scripts.)
 */
const SENSITIVE_PARAMS = new Set([
  "access_token",
  "refresh_token",
  "provider_token",
  "provider_refresh_token",
  "id_token",
  "code",
  "token",
  "token_hash",
  "password",
  "new_password",
  "current_password",
  "apikey",
  "api_key",
  "secret",
  "client_secret",
  "code_verifier",
  // signed media URLs (provider outputs, Storage)
  "signature",
  "sig",
  "jwt",
  "x-amz-signature",
  "x-amz-credential",
  "x-amz-security-token",
  "x-goog-signature",
  "x-goog-credential",
  "googleaccessid",
  "policy",
  "keypairid",
]);

/** Environment variables whose VALUES must never appear in logs, even when they match no pattern. */
const SECRET_ENV_NAMES = [
  "PRISM_STUDIO_WORKER_DB_URL",
  "PRISM_STUDIO_WORKER_DB_PASSWORD",
  "PRISM_STUDIO_WORKER_SUPABASE_SECRET_KEY",
  "PRISM_STUDIO_WORKER_SERVICE_KEY",
  "RUNWAYML_API_SECRET",
  "SUPABASE_DB_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

function literalSecrets(): string[] {
  const out = new Set<string>();
  for (const name of SECRET_ENV_NAMES) {
    const v = process.env[name];
    if (!v || v.length < 8) continue;
    out.add(v);
    if (name.endsWith("_URL")) {
      try {
        const pw = new URL(v).password;
        if (pw.length >= 6) {
          out.add(pw);
          out.add(decodeURIComponent(pw));
        }
      } catch {
        /* not a URL */
      }
    }
  }
  return [...out].filter((v) => v.length >= 6);
}

const MASK = "[redacted]";

/** Returns the URL with its fragment dropped and every sensitive query value masked. Never throws. */
export function redactUrl(input: string): string {
  const withoutHash = input.split("#")[0] ?? "";
  const queryAt = withoutHash.indexOf("?");
  if (queryAt === -1) return withoutHash;
  const head = withoutHash.slice(0, queryAt);
  const query = withoutHash
    .slice(queryAt + 1)
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      const key = (eq === -1 ? pair : pair.slice(0, eq)).toLowerCase();
      return SENSITIVE_PARAMS.has(key) ? `${eq === -1 ? pair : pair.slice(0, eq)}=${MASK}` : pair;
    })
    .join("&");
  return `${head}?${query}`;
}

/** Masks secrets inside free text (error messages, stack traces, header dumps). Never throws. */
export function redactText(input: unknown): string {
  let text = typeof input === "string" ? input : input instanceof Error ? input.message : String(input ?? "");
  // postgres://user:password@host/db
  text = text.replace(/(postgres(?:ql)?:\/\/[^:\s/@]+:)([^@\s]+)(@)/gi, `$1${MASK}$3`);
  // Header-style values: "Authorization: Bearer xxx", "Cookie: a=b; c=d", "Set-Cookie: ..."
  text = text.replace(
    /\b(authorization|proxy-authorization)(["']?\s*[:=]\s*["']?)([^\r\n"']+)/gi,
    `$1$2${MASK}`,
  );
  text = text.replace(/\b(set-cookie|cookie)(["']?\s*[:=]\s*["']?)([^\r\n"']+)/gi, `$1$2${MASK}`);
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${MASK}`);
  // key=value / key: value / "key":"value" for sensitive keys
  const keys = [...SENSITIVE_PARAMS].join("|");
  text = text.replace(
    new RegExp(`(["']?\\b(?:${keys})\\b["']?\\s*[:=]\\s*["']?)([^\\s&"',;}]+)`, "gi"),
    `$1${MASK}`,
  );
  // Bare JWTs and Supabase-style keys.
  text = text.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g, MASK);
  text = text.replace(/\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{8,}\b/g, MASK);
  // Any fragment that looks like it carries tokens.
  text = text.replace(/#[^\s]*(?:access_token|refresh_token|type=recovery)[^\s]*/gi, `#${MASK}`);
  // Literal values of known secret environment variables.
  for (const secret of literalSecrets()) text = text.split(secret).join(MASK);
  return text;
}

/** One-line, secret-free description of an unknown error for server logs. */
export function describeError(err: unknown): string {
  if (err instanceof Error) return redactText(`${err.name}: ${err.message}`);
  return redactText(err);
}
