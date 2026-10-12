import { NextResponse, type NextRequest } from "next/server";
import { authErrorPath, resolveAuthCallback } from "@/lib/auth/recovery";
import { persistenceMode } from "@/lib/supabase/config";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Landing point of Supabase email links (PKCE). Exchanges the one-time `code` for a session (the cookies are
 * written by @supabase/ssr), then redirects to a validated internal path. The code, tokens and cookies are
 * never logged, and nothing from Supabase's response is echoed to the user.
 */
export async function GET(request: NextRequest) {
  if (persistenceMode() !== "supabase") {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  try {
    const supabase = await createSupabaseServerClient();
    const { path } = await resolveAuthCallback(request.nextUrl.searchParams, supabase);
    return NextResponse.redirect(new URL(path, request.url));
  } catch {
    return NextResponse.redirect(new URL(authErrorPath("failed"), request.url));
  }
}
