import "server-only";
import { LocalDiskSink, secretKeySink, SinkConfigError, type OutputSink } from "@/generation/sink";
import { AGENT_RELAY_KEY_ENV, readRelayKey } from "./relay-key";

/**
 * The Prism SERVER's Storage authority for remote Local Agent jobs (Phase 2F M2D.3C2).
 *
 * A remote agent request carries no browser session, yet the server must read the job's private source photographs
 * and store its result Asset. In Supabase mode that needs a session-less server credential. It is a DEDICATED,
 * server-only secret key, distinct from the M2D.3B worker's key so it can be scoped and rotated on its own. Its
 * variable is named only in ./relay-key.ts; its VALUE is used only here (source tests prove both), only while
 * PRISM_LOCAL_AGENTS_ENABLED=1, and never sent anywhere: the workstation receives photographs and Prism ids, never a
 * key, a Storage URL or a signed URL.
 *
 * FAIL CLOSED: without it (in Supabase mode) remote jobs are unavailable and Remote Local Agent says "not configured";
 * nothing falls back to the worker key, a user session or a weaker path. It is used only for: the frozen source
 * Assets of a job leased to an authenticated device of that project (under the project's path prefix), and the shared
 * M2D.2 ingestion of that job's one result. See docs/security-model.md (residual risk) and docs/local-agent-protocol.md.
 */

export { AGENT_RELAY_KEY_ENV };

let cached: { key: string; sink: OutputSink } | null = null;

export function agentRelaySink(
  env: Record<string, string | undefined>,
  mode: "memory" | "supabase",
): OutputSink | null {
  if (mode === "memory") return new LocalDiskSink();
  // a rotated value builds a new sink (the cache is keyed by the value); a removed one fails closed at once
  const secret = readRelayKey(env);
  if (!secret) return null;
  if (cached?.key === secret) return cached.sink;
  try {
    const sink = secretKeySink({
      url: env.NEXT_PUBLIC_SUPABASE_URL,
      publishable: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
      secret,
      what: "agent relay",
    });
    cached = { key: secret, sink };
    return sink;
  } catch (e) {
    // never the key itself; the message names only the variable
    if (e instanceof SinkConfigError) console.error(`[local-agent] ${AGENT_RELAY_KEY_ENV}: ${e.message}`);
    return null;
  }
}
