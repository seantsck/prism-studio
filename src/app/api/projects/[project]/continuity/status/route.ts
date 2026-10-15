import { isAnalysisActive } from "@/domain/continuity/analysis/job-state";
import { getCurrentUser } from "@/server/auth";
import { getGenerationRepo } from "@/server/generation";
import { getMediaQaRepo } from "@/server/media-qa";
import { getRepo } from "@/server/repo";

const SLUG = /^[a-z0-9][a-z0-9-]{0,80}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Narrow status endpoint for the continuity page's live progress: Prism's OWN analysis job state only. The
 * browser never talks to an analyzer and never receives a provider credential or payload.
 *   ?attempt=<uuid>
 */
export async function GET(req: Request, ctx: { params: Promise<{ project: string }> }) {
  const { project } = await ctx.params;
  if (!SLUG.test(project)) return new Response("Not found", { status: 404 });
  if (!(await getCurrentUser())) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const attempt = new URL(req.url).searchParams.get("attempt");
  if (!attempt || !UUID.test(attempt)) return new Response("Not found", { status: 404 });

  const found = (await (await getRepo()).listProjects()).find((p) => p.slug === project);
  if (!found) return new Response("Not found", { status: 404 });
  const view = await (await getGenerationRepo()).getAttemptView(attempt);
  if (!view || view.attempt.projectId !== found.id) return new Response("Not found", { status: 404 });

  const jobs = await (await getMediaQaRepo()).listAttemptAnalysisJobs(attempt);
  const rows = jobs.map((j) => ({
    id: j.id,
    status: j.status,
    batchesDone: j.batchesDone,
    batchesTotal: j.batchesTotal,
    updatedAt: j.updatedAt,
  }));
  return Response.json(
    {
      signature: rows.map((r) => `${r.id}:${r.status}:${r.batchesDone}`).join("|"),
      active: jobs.filter((j) => isAnalysisActive(j.status)).length,
      jobs: rows,
    },
    { headers: { "cache-control": "private, no-store" } },
  );
}
