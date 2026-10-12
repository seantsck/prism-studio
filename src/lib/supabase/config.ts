/**
 * Public Supabase settings (URL + publishable key). Safe for server and browser code: the publishable key is
 * designed to be exposed and is useless without a user session + RLS. The service-role/secret key is never
 * read anywhere in the application runtime.
 */
export const PRISM_STUDIO_SUPABASE_REF = "lyqdxiyjperhniwhzsvg";

export type PersistenceMode = "memory" | "supabase";

export function persistenceMode(): PersistenceMode {
  return process.env.PRISM_STUDIO_PERSISTENCE === "supabase" ? "supabase" : "memory";
}

export function supabasePublicConfig(): { url: string; key: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be set");
  }
  if (!url.includes(PRISM_STUDIO_SUPABASE_REF)) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL does not target the Prism Studio project; refusing.");
  }
  return { url, key };
}
