import Link from "next/link";
import { AuthShell, DemoModeNotice } from "@/components/auth-shell";
import { LoginForm } from "@/components/login-form";
import { safeInternalPath } from "@/lib/auth/safe-redirect";
import { persistenceMode } from "@/lib/supabase/config";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in — Prism Studio" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; passwordUpdated?: string }>;
}) {
  const { next, passwordUpdated } = await searchParams;
  const safeNext = safeInternalPath(next, "/");
  const demo = persistenceMode() === "memory";
  return (
    <AuthShell title="Sign in">
      {demo ? (
        <DemoModeNotice what="Sign-in" />
      ) : (
        <>
          {passwordUpdated === "1" ? (
            <p role="status" className="mb-3 border border-line bg-panel p-3 text-[12.5px]">
              Password updated. Sign in with your new password.
            </p>
          ) : null}
          <div className="border border-line bg-panel p-4">
            <LoginForm next={safeNext} />
            <Link
              href="/forgot-password"
              className="mt-4 inline-block text-[12px] text-accent underline-offset-2 hover:underline"
            >
              Forgot password?
            </Link>
          </div>
        </>
      )}
    </AuthShell>
  );
}
