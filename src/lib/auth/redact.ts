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
]);

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
  return text;
}

/** One-line, secret-free description of an unknown error for server logs. */
export function describeError(err: unknown): string {
  if (err instanceof Error) return redactText(`${err.name}: ${err.message}`);
  return redactText(err);
}
