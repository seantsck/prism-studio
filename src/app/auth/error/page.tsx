import Link from "next/link";
import { AuthShell } from "@/components/auth-shell";
import { parseAuthErrorReason, type AuthErrorReason } from "@/lib/auth/auth-errors";

export const dynamic = "force-dynamic";
export const metadata = { title: "Link problem — Prism Studio" };

const COPY: Record<AuthErrorReason, { title: string; body: string }> = {
  expired: {
    title: "This link has expired",
    body: "Password reset links are only valid for a short time. Request a new one and open it right away.",
  },
  used: {
    title: "This link was already used",
    body: "Each reset link works once. If you still need to change your password, request a new link.",
  },
  session: {
    title: "This recovery session is not valid here",
    body: "Open the reset link in the same browser where you requested it, or request a new link from this browser.",
  },
  legacy: {
    title: "This is an old-style link",
    body: "Links from earlier requests are no longer accepted. Request a new password reset link from Prism Studio.",
  },
  failed: {
    title: "We couldn't verify that link",
    body: "Something went wrong while signing you in from the email link. Request a new link or sign in with your password.",
  },
};

/** The reason is whitelisted; nothing from the URL (code, token, fragment) is ever rendered. */
export default async function AuthErrorPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const { reason } = await searchParams;
  const copy = COPY[parseAuthErrorReason(reason)];
  return (
    <AuthShell title={copy.title}>
      <div className="border border-line bg-panel p-4">
        <p className="text-[12.5px] text-muted">{copy.body}</p>
        <div className="mt-4 flex flex-col gap-2 text-[12px]">
          <Link href="/forgot-password" className="text-accent underline-offset-2 hover:underline">
            Request another password reset
          </Link>
          <Link href="/login" className="text-muted underline-offset-2 hover:underline">
            Back to sign in
          </Link>
        </div>
      </div>
    </AuthShell>
  );
}
