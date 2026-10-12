"use server";
import { redirect } from "next/navigation";
import { persistenceMode } from "@/lib/supabase/config";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export interface SignInState {
  error: string | null;
}

const FRIENDLY = {
  invalid: "Email or password is incorrect.",
  unconfirmed: "This account's email address has not been confirmed yet.",
  rate: "Too many attempts. Wait a minute and try again.",
  generic: "Sign-in failed. Please try again.",
} as const;

/** Only same-site absolute paths: prevents open redirects through ?next=. */
function safeNextPath(raw: unknown): string {
  const value = typeof raw === "string" ? raw : "";
  return value.startsWith("/") && !value.startsWith("//") && !value.includes("\\") ? value : "/";
}

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
  redirect(safeNextPath(form.get("next")));
}

export async function signOut(): Promise<void> {
  if (persistenceMode() === "supabase") {
    const supabase = await createSupabaseServerClient();
    await supabase.auth.signOut();
  }
  redirect("/login");
}
