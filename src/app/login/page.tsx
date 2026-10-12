import Link from "next/link";
import { LoginForm } from "@/components/login-form";
import { persistenceMode } from "@/lib/supabase/config";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in — Prism Studio" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
  const demo = persistenceMode() === "memory";
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <div className="mb-6">
        <div className="text-[11px] uppercase tracking-[0.18em] text-accent">Prism Studio</div>
        <h1 className="mt-1 text-xl font-semibold tracking-tight">Sign in</h1>
      </div>
      {demo ? (
        <div className="border border-line bg-panel p-4 text-muted">
          <p>Accounts are disabled in demo mode (in-memory data, single local user).</p>
          <Link href="/" className="mt-3 inline-block text-accent underline-offset-2 hover:underline">
            Open the demo workspace →
          </Link>
        </div>
      ) : (
        <div className="border border-line bg-panel p-4">
          <LoginForm next={safeNext} />
        </div>
      )}
    </main>
  );
}
