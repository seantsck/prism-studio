import { AuthShell, DemoModeNotice } from "@/components/auth-shell";
import { ForgotPasswordForm } from "@/components/forgot-password-form";
import { persistenceMode } from "@/lib/supabase/config";

export const dynamic = "force-dynamic";
export const metadata = { title: "Forgot password — Prism Studio" };

export default function ForgotPasswordPage() {
  return (
    <AuthShell title="Forgot your password?">
      {persistenceMode() === "memory" ? <DemoModeNotice what="Password reset" /> : <ForgotPasswordForm />}
    </AuthShell>
  );
}
