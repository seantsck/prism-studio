import { agentError, handleLease } from "@/server/local-agent/http";
import { localAgentsEnabled, remoteJobDeps } from "@/server/local-agent";

export const dynamic = "force-dynamic";

/**
 * Local Agent protocol v1 (docs/local-agent-protocol.md §17). Signed lease request: the device's own live lease, or the
 * oldest queued Remote Local Agent job of ITS project (compare-and-set; exactly one agent wins). No job content beyond
 * the frozen source descriptors; never a Storage URL or credential.
 */
export async function POST(req: Request) {
  if (!localAgentsEnabled()) return agentError("not_enabled");
  return handleLease(req, await remoteJobDeps());
}
