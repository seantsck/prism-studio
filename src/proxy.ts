import { NextResponse, type NextRequest } from "next/server";
import { persistenceMode } from "@/lib/supabase/config";
import { updateSession } from "@/lib/supabase/proxy";

/**
 * Route protection. In supabase mode every page and API route except /login requires a verified session;
 * unauthenticated page requests are redirected to /login?next=<path>, API requests get 401.
 * (Memory/demo mode has no accounts and skips this entirely.) This is a convenience layer: data access is
 * still enforced by RLS, and server actions re-check the session themselves.
 */
export async function proxy(request: NextRequest) {
  if (persistenceMode() !== "supabase") return NextResponse.next();

  const { pathname, search } = request.nextUrl;
  const { response, signedIn } = await updateSession(request);

  if (pathname === "/login") {
    if (signedIn) {
      const next = request.nextUrl.searchParams.get("next");
      const target = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
      return NextResponse.redirect(new URL(target, request.url));
    }
    return response();
  }

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
