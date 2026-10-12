import "server-only";
import pg from "pg";
import { PRISM_STUDIO_SUPABASE_REF } from "@/lib/supabase/config";

/**
 * Guarded Postgres access for the dedicated Prism Studio Supabase project.
 * The connection string must contain this project ref, otherwise we refuse to connect, so a
 * misconfigured env can never point the app at another Supabase project.
 *
 * NOTE: this connection is a privileged server connection. Application code must never run statements
 * on it directly; it is only handed to UserRepository (which drops to role `authenticated` per
 * transaction so RLS applies) — see src/data/postgres-repository.ts.
 */
export { PRISM_STUDIO_SUPABASE_REF };

declare global {
  var __prismPool: pg.Pool | undefined;
}

export function getPool(): pg.Pool {
  const url = process.env.SUPABASE_DB_URL;
  if (!url) throw new Error("SUPABASE_DB_URL is not set");
  if (!url.includes(PRISM_STUDIO_SUPABASE_REF)) {
    throw new Error("SUPABASE_DB_URL does not target the Prism Studio project; refusing to connect.");
  }
  globalThis.__prismPool ??= new pg.Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30_000,
  });
  return globalThis.__prismPool;
}
