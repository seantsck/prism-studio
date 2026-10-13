import { generationSignature } from "@/domain/generation/signature";
import { getCurrentUser } from "@/server/auth";
import { getGenerationRepo } from "@/server/generation";
import { getRepo } from "@/server/repo";

const SLUG = /^[a-z0-9][a-z0-9-]{0,80}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Narrow status endpoint for the browser's live updates. Reads ONLY generation state (never the whole
 * project, never a provider). Authorised by the same RLS-bound reads as everything else.
 *   ?shotId=<uuid>   attempts of one shot
 *   (none)           the project's recent generations
 */
export async function GET(req: Request, ctx: { params: Promise<{ project: string }> }) {
  const { project } = await ctx.params;
  if (!SLUG.test(project)) return new Response("Not found", { status: 404 });
  if (!(await getCurrentUser())) return Response.json({ error: "unauthenticated" }, { status: 401 });

  const shotId = new URL(req.url).searchParams.get("shotId");
  if (shotId && !UUID.test(shotId)) return new Response("Not found", { status: 404 });

  const projects = await (await getRepo()).listProjects();
  const found = projects.find((p) => p.slug === project);
  if (!found) return new Response("Not found", { status: 404 });
  const gen = await getGenerationRepo();

  if (shotId) {
    // A shot id of another (own) project must not answer under this project's URL.
    const views = (await gen.listShotAttempts(shotId)).filter((v) => v.attempt.projectId === found.id);
    const rows = views.map((v) => ({
      attemptId: v.attempt.id,
      jobStatus: v.job?.status ?? null,
      attemptStatus: v.attempt.status,
      review: v.attempt.reviewStatus,
      updatedAt: v.job?.updatedAt ?? null,
    }));
    return Response.json(
      {
        signature: generationSignature(rows),
        active: rows.filter((r) => r.jobStatus && !["succeeded", "failed", "cancelled"].includes(r.jobStatus))
          .length,
      },
      { headers: { "cache-control": "private, no-store" } },
    );
  }

  const rows = (await gen.listProjectGenerations(found.id, { limit: 200 })).map((r) => ({
    attemptId: r.attempt.id,
    jobStatus: r.job?.status ?? null,
    attemptStatus: r.attempt.status,
    review: r.attempt.reviewStatus,
    updatedAt: r.job?.updatedAt ?? null,
  }));
  return Response.json(
    {
      signature: generationSignature(rows),
      active: rows.filter((r) => r.jobStatus && !["succeeded", "failed", "cancelled"].includes(r.jobStatus))
        .length,
    },
    { headers: { "cache-control": "private, no-store" } },
  );
}
