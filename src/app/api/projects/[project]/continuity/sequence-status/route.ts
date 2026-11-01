import { isAnalysisActive } from "@/domain/continuity/analysis/job-state";
import { getCurrentUser } from "@/server/auth";
import { getEpisodeEditRepo } from "@/server/episode-edits";
import { getMediaQaRepo } from "@/server/media-qa";
import { getRepo } from "@/server/repo";

const SLUG = /^[a-z0-9][a-z0-9-]{0,80}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Narrow status endpoint for the Continuity Supervisor's live progress: Prism's OWN transition job state for one edit,
 * owner only. No provider payload, snapshot or credential ever reaches the browser. Reads only.
 *   ?edit=<uuid>
 */
export async function GET(req: Request, ctx: { params: Promise<{ project: string }> }) {
  const { project } = await ctx.params;
  if (!SLUG.test(project)) return new Response("Not found", { status: 404 });
  if (!(await getCurrentUser())) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const editId = new URL(req.url).searchParams.get("edit");
  if (!editId || !UUID.test(editId)) return new Response("Not found", { status: 404 });

  const found = (await (await getRepo()).listProjects()).find((p) => p.slug === project);
  if (!found) return new Response("Not found", { status: 404 });
  const edit = await (await getEpisodeEditRepo()).get(found.id, editId);
  if (!edit) return new Response("Not found", { status: 404 });

  const jobs = await (
    await getMediaQaRepo({ startInlineWorker: false })
  ).listEditTransitionAnalysisJobs(found.id, editId);
  const rows = jobs.map((j) => ({ id: j.id, status: j.status }));
  return Response.json(
    {
      signature: rows.map((r) => `${r.id}:${r.status}`).join("|"),
      active: jobs.filter((j) => isAnalysisActive(j.status)).length,
      jobs: rows,
    },
    { headers: { "cache-control": "private, no-store" } },
  );
}
