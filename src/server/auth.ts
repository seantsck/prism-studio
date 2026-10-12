import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { LOCAL_USER_ID } from "@/data/seed";
import { persistenceMode } from "@/lib/supabase/config";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export interface AppUser {
  /** auth.users id from a VERIFIED JWT. The only source of identity for persistence. */
  id: string;
  email: string | null;
  /** "local" = memory/demo mode (no accounts). */
  kind: "supabase" | "local";
}

/** The signed-in user for this request, or null. Verified once per request. */
export const getCurrentUser = cache(async (): Promise<AppUser | null> => {
  if (persistenceMode() === "memory") return { id: LOCAL_USER_ID, email: null, kind: "local" };
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (error || !claims?.sub) return null;
  return {
    id: String(claims.sub),
    email: typeof claims.email === "string" ? claims.email : null,
    kind: "supabase",
  };
});

/** Guard for pages, route handlers and server actions. Redirects to /login when there is no session. */
export async function requireUser(): Promise<AppUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}
