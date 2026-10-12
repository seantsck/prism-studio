/**
 * Password-recovery logic, free of Next/Supabase imports so it can be unit tested with fakes.
 * The thin adapters (route handler, server action, client form) inject the real Supabase client.
 */
import {
  RESET_MESSAGES,
  isNetworkError,
  isRateLimited,
  isSessionProblem,
  reasonForCallbackError,
  updatePasswordMessage,
  type AuthErrorLike,
  type AuthErrorReason,
} from "./auth-errors";
import { isPlausibleEmail, validateNewPassword, type PasswordFieldErrors } from "./password-policy";
import { safeInternalPath } from "./safe-redirect";
import { recoveryRedirectUrl } from "./site-url";

export const DEFAULT_AFTER_CALLBACK = "/";
export const UPDATE_PASSWORD_PATH = "/update-password";
export const FORGOT_PASSWORD_PATH = "/forgot-password";

// ── 1. request a reset email (browser) ─────────────────────────────────────────────────────────────────────────

export interface ResetClient {
  auth: {
    resetPasswordForEmail(
      email: string,
      options: { redirectTo: string },
    ): Promise<{ error: (AuthErrorLike & { message?: string }) | null }>;
  };
}

export interface ResetResult {
  ok: boolean;
  /** Fixed, user-safe text. Identical for existing and unknown accounts. */
  message: string;
}

export async function requestPasswordReset(
  client: ResetClient,
  rawEmail: string,
  siteUrl?: string,
): Promise<ResetResult> {
  const email = rawEmail.trim();
  if (!isPlausibleEmail(email)) return { ok: false, message: RESET_MESSAGES.invalidEmail };
  try {
    const { error } = await client.auth.resetPasswordForEmail(email, {
      redirectTo: recoveryRedirectUrl(siteUrl),
    });
    if (!error) return { ok: true, message: RESET_MESSAGES.sent };
    if (isRateLimited(error)) return { ok: false, message: RESET_MESSAGES.rate };
    if (isNetworkError(error)) return { ok: false, message: RESET_MESSAGES.network };
    return { ok: false, message: RESET_MESSAGES.generic };
  } catch (err) {
    return { ok: false, message: isNetworkError(err) ? RESET_MESSAGES.network : RESET_MESSAGES.generic };
  }
}

// ── 2. auth callback (server, PKCE) ───────────────────────────────────────────────────────────────────────────

export interface CallbackClient {
  auth: {
    exchangeCodeForSession(code: string): Promise<{ error: AuthErrorLike | null }>;
  };
}

export function authErrorPath(reason: AuthErrorReason): string {
  return `/auth/error?reason=${reason}`;
}

/**
 * Decides where the browser goes after following an email link. Returns an internal path only; the code
 * is passed to Supabase and never logged or echoed.
 */
export async function resolveAuthCallback(
  params: URLSearchParams,
  client: CallbackClient,
): Promise<{ path: string; reason?: AuthErrorReason }> {
  // Supabase reports link problems (expired/used) as ?error=…&error_code=… on the redirect.
  if (params.get("error") || params.get("error_code")) {
    const reason = reasonForCallbackError({ code: params.get("error_code") ?? undefined });
    return { path: authErrorPath(reason), reason };
  }
  const code = params.get("code");
  if (!code || code.length > 512) {
    return { path: authErrorPath("failed"), reason: "failed" };
  }
  const next = safeInternalPath(params.get("next"), DEFAULT_AFTER_CALLBACK);

  try {
    const { error } = await client.auth.exchangeCodeForSession(code);
    if (error) {
      const reason = reasonForCallbackError(error);
      return { path: authErrorPath(reason), reason };
    }
  } catch {
    return { path: authErrorPath("failed"), reason: "failed" };
  }
  return { path: next };
}

// ── 3. choose a new password (server action) ──────────────────────────────────────────────────────────────────

export interface UpdateClient {
  auth: {
    getUser(): Promise<{ data: { user: { id: string } | null } }>;
    updateUser(attrs: { password: string }): Promise<{ error: AuthErrorLike | null }>;
    signOut(opts?: { scope?: "global" | "local" | "others" }): Promise<{ error: AuthErrorLike | null }>;
  };
}

export type UpdatePasswordOutcome =
  | { status: "updated" }
  | { status: "invalid"; fieldErrors: PasswordFieldErrors }
  | { status: "no_session"; message: string }
  | { status: "error"; message: string };

export async function updatePasswordWithSession(
  client: UpdateClient,
  password: string,
  confirm: string,
): Promise<UpdatePasswordOutcome> {
  // Local validation first: a mismatching or weak password never reaches Supabase.
  const fieldErrors = validateNewPassword(password, confirm);
  if (fieldErrors.password || fieldErrors.confirm) return { status: "invalid", fieldErrors };

  const { data } = await client.auth.getUser();
  if (!data.user) return { status: "no_session", message: updatePasswordMessage({ status: 401 }) };

  const { error } = await client.auth.updateUser({ password });
  if (error) {
    return isSessionProblem(error)
      ? { status: "no_session", message: updatePasswordMessage(error) }
      : { status: "error", message: updatePasswordMessage(error) };
  }

  // Deliberate boundary: end the recovery session (and every other session of this user) so the next step
  // is a clean sign-in with the new password. If global sign-out fails, still drop this browser's session.
  const global = await client.auth.signOut({ scope: "global" }).catch(() => ({ error: { code: "x" } }));
  if (global.error) await client.auth.signOut({ scope: "local" }).catch(() => undefined);
  return { status: "updated" };
}

export const PASSWORD_UPDATED_LOGIN_PATH = "/login?passwordUpdated=1";
