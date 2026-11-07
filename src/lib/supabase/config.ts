/**
 * Public Supabase settings (URL + publishable key). Safe for server and browser code: the publishable key is
 * designed to be exposed and is useless without a user session + RLS. The service-role/secret key is never
 * read anywhere in the application runtime.
 */
import { DEV_PROJECT_REF, deploymentTarget, publicUrlTargetsRef } from "./target";

/** @deprecated the DEV project ref; the deployment's own target is `deploymentTarget().ref` (Phase 5A.2) */
export const PRISM_STUDIO_SUPABASE_REF = DEV_PROJECT_REF;

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
  if (!publicUrlTargetsRef(url, deploymentTarget().ref)) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL does not target the Prism Studio project; refusing.");
  }
  return { url, key };
}
