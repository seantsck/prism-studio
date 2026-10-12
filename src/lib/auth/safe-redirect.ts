/**
 * Single place that decides whether a user-supplied `next` value may be redirected to.
 * Only same-origin, absolute *paths* are accepted (e.g. "/projects/abc?tab=x"). Used by the login page, the
 * proxy, the sign-in action and the auth callback.
 */
const MAX_LENGTH = 2048;

// C0/C1 controls, DEL, and Unicode line/paragraph separators (browsers strip some of these inside URLs).
const CONTROL = new RegExp("[\u0000-\u001f\u007f-\u009f\u2028\u2029]");

function decodeOnce(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function isUnsafe(candidate: string): boolean {
  return (
    CONTROL.test(candidate) ||
    candidate.includes("\\") ||
    !candidate.startsWith("/") ||
    candidate.startsWith("//") ||
    /^\/[\s/\\]*[/\\]/.test(candidate) // "/ /evil", "/\evil" and friends that browsers normalise to "//"
  );
}

/**
 * Returns `raw` unchanged when it is a safe internal path, otherwise `fallback`.
 * Percent-decodes up to three times so "/%2Fevil.example", "/%5Cevil" and double-encoded variants are caught.
 */
export function safeInternalPath(raw: unknown, fallback = "/"): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_LENGTH) return fallback;

  let candidate: string | null = raw;
  for (let i = 0; i <= 3; i++) {
    if (candidate === null) return fallback; // malformed escape sequence
    if (isUnsafe(candidate)) return fallback;
    const decoded = decodeOnce(candidate);
    if (decoded === candidate) break;
    candidate = decoded;
  }

  // Final structural check: the value must resolve against a dummy origin back to that same origin.
  try {
    const base = "http://internal.invalid";
    if (new URL(raw, base).origin !== base) return fallback;
  } catch {
    return fallback;
  }
  return raw;
}
