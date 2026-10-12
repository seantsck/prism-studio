"use server";
import { redirect } from "next/navigation";
import { persistenceMode } from "@/lib/supabase/config";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { describeError } from "@/lib/auth/redact";
import { safeInternalPath } from "@/lib/auth/safe-redirect";
import {
  PASSWORD_UPDATED_LOGIN_PATH,
  updatePasswordWithSession,
  type UpdateClient,
} from "@/lib/auth/recovery";
import type { PasswordFieldErrors } from "@/lib/auth/password-policy";

export interface SignInState {
  error: string | null;
}

const FRIENDLY = {
  invalid: "Email or password is incorrect.",
  unconfirmed: "This account's email address has not been confirmed yet.",
  rate: "Too many attempts. Wait a minute and try again.",
  generic: "Sign-in failed. Please try again.",
} as const;

export async function signIn(_prev: SignInState, form: FormData): Promise<SignInState> {
  if (persistenceMode() !== "supabase") return { error: "Sign-in is disabled in demo mode." };
  const email = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");
  if (!email || !password) return { error: "Enter your email and password." };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    // Detail stays server-side; the user sees a fixed, non-leaking message.
    console.warn("[auth] sign-in failed:", error.code ?? error.status ?? "unknown");
    const code = error.code ?? "";
    if (code === "email_not_confirmed") return { error: FRIENDLY.unconfirmed };
    if (code === "over_request_rate_limit" || error.status === 429) return { error: FRIENDLY.rate };
    if (code === "invalid_credentials" || error.status === 400) return { error: FRIENDLY.invalid };
    return { error: FRIENDLY.generic };
  }
  redirect(safeInternalPath(form.get("next"), "/"));
}

export async function signOut(): Promise<void> {
  if (persistenceMode() === "supabase") {
    const supabase = await createSupabaseServerClient();
    await supabase.auth.signOut();
  }
  redirect("/login");
}

export interface UpdatePasswordState {
  error: string | null;
  fieldErrors?: PasswordFieldErrors;
  /** True when the recovery session is gone: the form is replaced by "request another link". */
  needsNewLink?: boolean;
}

/**
 * Sets a new password for the CURRENT session (the recovery session created by /auth/callback), then ends
 * that session and sends the user to sign in again. The password is only read from the POST body: it never
 * appears in a URL, a log line, or the returned state.
 */
export async function updatePassword(
  _prev: UpdatePasswordState,
  form: FormData,
): Promise<UpdatePasswordState> {
  if (persistenceMode() !== "supabase") return { error: "Password changes are disabled in demo mode." };
  const password = String(form.get("password") ?? "");
  const confirm = String(form.get("confirm") ?? "");

  let outcome;
  try {
    const supabase = await createSupabaseServerClient();
    outcome = await updatePasswordWithSession(supabase as unknown as UpdateClient, password, confirm);
  } catch (err) {
    console.warn("[auth] password update failed:", describeError(err));
    return { error: "We couldn't update your password. Please try again." };
  }

  switch (outcome.status) {
    case "invalid":
      return { error: null, fieldErrors: outcome.fieldErrors };
    case "no_session":
      return { error: outcome.message, needsNewLink: true };
    case "error":
      return { error: outcome.message };
    case "updated":
      redirect(PASSWORD_UPDATED_LOGIN_PATH);
  }
}
