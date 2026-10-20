import { agentError, handleSource } from "@/server/local-agent/http";
import { localAgentsEnabled, remoteJobDeps } from "@/server/local-agent";

export const dynamic = "force-dynamic";

/**
 * Local Agent protocol v1 (docs/local-agent-protocol.md §18). Signed download of ONE frozen source photograph of a
 * lease the device holds: read server-side from private storage, re-verified, served as raw bytes with no-store.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ jobId: string; leaseId: string; ordinal: string }> },
) {
  if (!localAgentsEnabled()) return agentError("not_enabled");
  return handleSource(req, await remoteJobDeps(), await ctx.params);
}
