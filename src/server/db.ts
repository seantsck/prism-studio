import "server-only";
import pg from "pg";

/**
 * Guarded Postgres access for the dedicated Prism Studio Supabase project.
 * The connection string must contain this project ref, otherwise we refuse to connect, so a
 * misconfigured env can never point the app at another Supabase project.
 */
export const PRISM_STUDIO_SUPABASE_REF = "lyqdxiyjperhniwhzsvg";

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
    max: 5,
  });
  return globalThis.__prismPool;
}
