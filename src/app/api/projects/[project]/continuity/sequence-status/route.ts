import { isAnalysisActive } from "@/domain/continuity/analysis/job-state";
import { sequenceStatusOf } from "@/domain/continuity/sequence-status";
import { getCurrentUser } from "@/server/auth";
import { getEpisodeEditRepo } from "@/server/episode-edits";
import { getMediaQaRepo } from "@/server/media-qa";
import { getRepo } from "@/server/repo";

const SLUG = /^[a-z0-9][a-z0-9-]{0,80}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Narrow status endpoint for the Continuity Supervisor: this edit's transition jobs and the Project's shared active
 * capacity, as Prism's OWN safe job state only (`sequenceStatusOf`), owner only. No provider payload, snapshot, reference
 * or credential ever reaches the browser. Reads only.
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

  const qa = await getMediaQaRepo({ startInlineWorker: false });
  return Response.json(
    sequenceStatusOf({
      editJobs: await qa.listEditTransitionAnalysisJobs(found.id, editId),
      projectActiveJobs: await qa.listActiveProjectAnalysisJobs(found.id),
      isActive: isAnalysisActive,
    }),
    { headers: { "cache-control": "private, no-store" } },
  );
}
