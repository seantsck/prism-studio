import { agentError, handleProgress } from "@/server/local-agent/http";
import { localAgentsEnabled, remoteJobDeps } from "@/server/local-agent";

export const dynamic = "force-dynamic";

/** Local Agent protocol v1 (docs/local-agent-protocol.md §19). Signed keepalive/progress of a held lease: renews the lease; freezes the final result metadata once. */
export async function POST(req: Request, ctx: { params: Promise<{ jobId: string; leaseId: string }> }) {
  if (!localAgentsEnabled()) return agentError("not_enabled");
  return handleProgress(req, await remoteJobDeps(), await ctx.params);
}
