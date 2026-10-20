import { agentError, handleResult } from "@/server/local-agent/http";
import { localAgentsEnabled, remoteJobDeps } from "@/server/local-agent";

export const dynamic = "force-dynamic";

/**
 * Local Agent protocol v1 (docs/local-agent-protocol.md §20). Signed upload of the ONE validated SPZ result of a held
 * lease (at most Prism's 50 MB splat cap, exactly the declared length). Prism re-validates it and imports it through
 * the shared M2D.2 ingestion; the workstation never creates an Asset or touches Storage.
 */
export async function PUT(req: Request, ctx: { params: Promise<{ jobId: string; leaseId: string }> }) {
  if (!localAgentsEnabled()) return agentError("not_enabled");
  return handleResult(req, await remoteJobDeps(), await ctx.params);
}
