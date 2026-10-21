import { isServerSecretKey } from "@/generation/sink";

/**
 * The ONE module that names the Prism server's dedicated agent-relay Storage key (Phase 2F M2D.3C2/M2D.3D1):
 *
 *   PRISM_STUDIO_AGENT_RELAY_SUPABASE_SECRET_KEY
 *
 * Two readers, each with a narrow purpose (source tests enforce both the single module and its importers):
 *   - `readRelayKey`    the VALUE, for the server-only relay (`relay-storage.ts`) and nothing else;
 *   - `relayKeyStatus`  configured / missing / invalid ONLY, for the operator readiness check. It never returns,
 *                       logs or compares the value against another variable.
 *
 * There is no fallback: the worker key, a service-role key or a session never stand in for it.
 */

export const AGENT_RELAY_KEY_ENV = "PRISM_STUDIO_AGENT_RELAY_SUPABASE_SECRET_KEY";

export function readRelayKey(env: Record<string, string | undefined>): string | null {
  return env.PRISM_STUDIO_AGENT_RELAY_SUPABASE_SECRET_KEY?.trim() || null;
}

/** Presence and shape only: never the value. `invalid` = set, but not a server secret key (e.g. a publishable key). */
export function relayKeyStatus(
  env: Record<string, string | undefined>,
): "configured" | "missing" | "invalid" {
  const v = readRelayKey(env);
  if (!v) return "missing";
  return isServerSecretKey(v) ? "configured" : "invalid";
}
