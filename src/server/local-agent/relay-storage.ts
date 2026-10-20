import "server-only";
import { LocalDiskSink, secretKeySink, SinkConfigError, type OutputSink } from "@/generation/sink";

/**
 * The Prism SERVER's Storage authority for remote Local Agent jobs (Phase 2F M2D.3C2).
 *
 * A remote agent request carries no browser session, yet the server must read the job's private source photographs
 * and store its result Asset. In Supabase mode that needs a session-less server credential. It is a DEDICATED,
 * server-only secret key, distinct from the M2D.3B worker's key so it can be scoped and rotated on its own:
 *
 *   PRISM_STUDIO_AGENT_RELAY_SUPABASE_SECRET_KEY   read ONLY here (a source-level test proves no other module reads it),
 *                                                  only while PRISM_LOCAL_AGENTS_ENABLED=1, and never sent anywhere:
 *                                                  the workstation receives photographs and Prism ids, never a key,
 *                                                  a Storage URL or a signed URL.
 *
 * FAIL CLOSED: without it (in Supabase mode) remote jobs are unavailable and Remote Local Agent says "not configured";
 * nothing falls back to the worker key, a user session or a weaker path. It is used only for: the frozen source
 * Assets of a job leased to an authenticated device of that project (under the project's path prefix), and the shared
 * M2D.2 ingestion of that job's one result. See docs/security-model.md (residual risk) and docs/local-agent-protocol.md.
 */

export const AGENT_RELAY_KEY_ENV = "PRISM_STUDIO_AGENT_RELAY_SUPABASE_SECRET_KEY";

let cached: { key: string; sink: OutputSink } | null = null;

export function agentRelaySink(
  env: Record<string, string | undefined>,
  mode: "memory" | "supabase",
): OutputSink | null {
  if (mode === "memory") return new LocalDiskSink();
  const secret = env.PRISM_STUDIO_AGENT_RELAY_SUPABASE_SECRET_KEY?.trim();
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
