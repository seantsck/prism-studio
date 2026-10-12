import Link from "next/link";
import { AuthShell, DemoModeNotice } from "@/components/auth-shell";
import { UpdatePasswordForm } from "@/components/update-password-form";
import { persistenceMode } from "@/lib/supabase/config";
import { getCurrentUser } from "@/server/auth";

export const dynamic = "force-dynamic";
export const metadata = { title: "Set a new password — Prism Studio" };

/**
 * Reachable without a session on purpose (the proxy lets it through) so that a missing/expired recovery
 * session produces a clear "request another link" state instead of a redirect loop. The form is only rendered
 * for a verified session, and the server action re-checks the session before touching the password.
 */
export default async function UpdatePasswordPage() {
  if (persistenceMode() === "memory") {
    return (
      <AuthShell title="Set a new password">
        <DemoModeNotice what="Changing the password" />
      </AuthShell>
    );
  }
  const user = await getCurrentUser();
  if (!user) {
    return (
      <AuthShell title="Set a new password">
        <div className="border border-line bg-panel p-4">
          <p role="alert" className="text-[12.5px]">
            This reset link has expired, was already used, or was opened in a different browser.
          </p>
          <Link
            href="/forgot-password"
            className="mt-3 inline-block text-[12px] text-accent underline-offset-2 hover:underline"
          >
            Request another reset link
          </Link>
          <div>
            <Link
              href="/login"
              className="mt-2 inline-block text-[12px] text-muted underline-offset-2 hover:underline"
            >
              Back to sign in
            </Link>
          </div>
        </div>
      </AuthShell>
    );
  }
  return (
    <AuthShell title="Set a new password">
      <UpdatePasswordForm />
    </AuthShell>
  );
}
