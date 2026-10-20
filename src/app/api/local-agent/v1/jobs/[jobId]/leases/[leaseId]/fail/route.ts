import { agentError, handleFail } from "@/server/local-agent/http";
import { localAgentsEnabled, remoteJobDeps } from "@/server/local-agent";

export const dynamic = "force-dynamic";

/** Local Agent protocol v1 (docs/local-agent-protocol.md §21). Signed failure report of a held lease: the agent's normalized code; the server chooses the job error. */
export async function POST(req: Request, ctx: { params: Promise<{ jobId: string; leaseId: string }> }) {
  if (!localAgentsEnabled()) return agentError("not_enabled");
  return handleFail(req, await remoteJobDeps(), await ctx.params);
}
