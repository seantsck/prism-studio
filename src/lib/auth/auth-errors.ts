/**
 * Maps Supabase Auth failures to fixed, user-safe wording. Nothing from the raw error (message, hint, URL,
 * token) is ever returned; only the error *code* is used to pick a bucket.
 */
export interface AuthErrorLike {
  code?: string;
  status?: number;
  name?: string;
}

export type AuthErrorReason = "expired" | "used" | "session" | "legacy" | "failed";

export const AUTH_ERROR_REASONS: readonly AuthErrorReason[] = [
  "expired",
  "used",
  "session",
  "legacy",
  "failed",
];

/** Whitelist parse for ?reason=… so the error page can never echo arbitrary input. */
export function parseAuthErrorReason(raw: unknown): AuthErrorReason {
  return AUTH_ERROR_REASONS.find((r) => r === raw) ?? "failed";
}

/** Callback / code-exchange failures → which friendly page to show. */
export function reasonForCallbackError(err: AuthErrorLike | null | undefined): AuthErrorReason {
  const code = err?.code ?? "";
  if (code === "otp_expired" || code === "flow_state_expired") return "expired";
  if (code === "flow_state_not_found") return "used";
  if (code === "bad_code_verifier" || code === "session_not_found") return "session";
  return "failed";
}

export function isRateLimited(err: AuthErrorLike | null | undefined): boolean {
  const code = err?.code ?? "";
  return err?.status === 429 || code === "over_request_rate_limit" || code === "over_email_send_rate_limit";
}

export function isNetworkError(err: unknown): boolean {
  const e = err as AuthErrorLike | null;
  return (
    e?.name === "AuthRetryableFetchError" ||
    e?.status === 0 ||
    (err instanceof TypeError && /fetch|network/i.test(err.message))
  );
}

export const RESET_MESSAGES = {
  invalidEmail: "Enter a valid email address.",
  sent: "If an account exists for that email, we've sent a password reset link.",
  rate: "Too many reset requests. Wait a few minutes before trying again.",
  network: "Couldn't reach the server. Check your connection and try again.",
  generic: "We couldn't send a reset link right now. Please try again shortly.",
  demo: "Password reset is disabled in demo mode (there are no accounts).",
} as const;

export const UPDATE_MESSAGES = {
  noSession: "This reset link is no longer valid.",
  samePassword: "Choose a password you haven't used for this account before.",
  weak: "That password is too easy to guess. Try a longer or less common one.",
  rate: "Too many attempts. Wait a minute and try again.",
  generic: "We couldn't update your password. Please try again.",
} as const;

export function updatePasswordMessage(err: AuthErrorLike | null | undefined): string {
  const code = err?.code ?? "";
  if (code === "same_password") return UPDATE_MESSAGES.samePassword;
  if (code === "weak_password") return UPDATE_MESSAGES.weak;
  if (isRateLimited(err)) return UPDATE_MESSAGES.rate;
  if (code === "session_not_found" || code === "reauthentication_needed" || err?.status === 401) {
    return UPDATE_MESSAGES.noSession;
  }
  return UPDATE_MESSAGES.generic;
}

export function isSessionProblem(err: AuthErrorLike | null | undefined): boolean {
  return updatePasswordMessage(err) === UPDATE_MESSAGES.noSession;
}
