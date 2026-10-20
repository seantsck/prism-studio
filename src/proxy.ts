import { NextResponse, type NextRequest } from "next/server";
import { persistenceMode } from "@/lib/supabase/config";
import { updateSession } from "@/lib/supabase/proxy";
import { safeInternalPath } from "@/lib/auth/safe-redirect";
import { isAgentProtocolPath, isPublicPath } from "@/lib/auth/public-paths";

/**
 * Route protection. In supabase mode every page and API route except the auth-flow pages (/login, /forgot-password, /update-password, /auth/*) requires a verified session;
 * unauthenticated page requests are redirected to /login?next=<path>, API requests get 401.
 * (Memory/demo mode has no accounts and skips this entirely.) This is a convenience layer: data access is
 * still enforced by RLS, and server actions re-check the session themselves.
 */
export async function proxy(request: NextRequest) {
  if (persistenceMode() !== "supabase") return NextResponse.next();

  const { pathname, search } = request.nextUrl;
  // Local Agent endpoints authenticate each request themselves (pairing secret / device signature), never by session.
  if (isAgentProtocolPath(pathname)) return NextResponse.next();
  const { response, signedIn } = await updateSession(request);

  // A recovery link that fell back to the Site URL arrives as /?code=… ; hand it to the callback.
  if (pathname === "/" && request.nextUrl.searchParams.has("code")) {
    const url = new URL("/auth/callback", request.url);
    url.searchParams.set("code", request.nextUrl.searchParams.get("code") ?? "");
    url.searchParams.set("next", "/update-password");
    return NextResponse.redirect(url);
  }

  if (pathname === "/login") {
    if (signedIn) {
      const target = safeInternalPath(request.nextUrl.searchParams.get("next"), "/");
      return NextResponse.redirect(new URL(target, request.url));
    }
    return response();
  }

  // Auth-flow pages must work without a session (forgot/update password, email callback, link errors).
  if (isPublicPath(pathname)) return response();

  if (!signedIn) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    const url = new URL("/login", request.url);
    if (pathname !== "/") url.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(url);
  }
  return response();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
