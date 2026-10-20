import { agentError, handleHeartbeat } from "@/server/local-agent/http";
import { agentServiceDeps, localAgentsEnabled } from "@/server/local-agent";

export const dynamic = "force-dynamic";

/**
 * Local Agent protocol v1 (docs/local-agent-protocol.md). Signed heartbeat: capability report + liveness (Ed25519 signature, strictly increasing counter).
 * Called by a paired workstation, never by the browser; it carries no cookie authority and grants none.
 */
export async function POST(req: Request) {
  if (!localAgentsEnabled()) return agentError("not_enabled");
  return handleHeartbeat(req, await agentServiceDeps());
}
