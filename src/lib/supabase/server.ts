import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { supabasePublicConfig } from "./config";

/**
 * Supabase client bound to the signed-in user's session cookies (Server Components, Route Handlers, Server
 * Actions). Everything done through it runs as that user: Auth, Storage, and RLS apply.
 */
export async function createSupabaseServerClient() {
  const { url, key } = supabasePublicConfig();
  const cookieStore = await cookies();
  return createServerClient(url, key, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (toSet) => {
        try {
          for (const { name, value, options } of toSet) cookieStore.set(name, value, options);
        } catch {
          // Called from a Server Component: cookies are read-only there. The proxy refreshes the session.
        }
      },
    },
  });
}
