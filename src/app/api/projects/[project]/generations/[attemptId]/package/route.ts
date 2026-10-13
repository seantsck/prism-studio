import { briefToText, renderGenerationBrief, type GenerationPackage } from "@/domain/generation-package";
import { getCurrentUser } from "@/server/auth";
import { getGenerationRepo } from "@/server/generation";

const SLUG = /^[a-z0-9][a-z0-9-]{0,80}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The FROZEN package an attempt was generated from (not today's shot). Historical briefs stay readable
 * forever because the snapshot is copied by value into the attempt at submission.
 *   ?format=json (default) | ?format=brief
 */
export async function GET(req: Request, ctx: { params: Promise<{ project: string; attemptId: string }> }) {
  const { project, attemptId } = await ctx.params;
  if (!SLUG.test(project) || !UUID.test(attemptId)) return new Response("Not found", { status: 404 });
  if (!(await getCurrentUser())) return Response.json({ error: "unauthenticated" }, { status: 401 });

  const view = await (await getGenerationRepo()).getAttemptView(attemptId);
  if (!view) return new Response("Not found", { status: 404 });
  const pkg = view.attempt.packageSnapshot as unknown as GenerationPackage;
  const name = `attempt-${view.attempt.attemptNumber}-${attemptId.slice(0, 8)}`;
  const brief = new URL(req.url).searchParams.get("format") === "brief";

  if (brief) {
    let text: string;
    try {
      text = briefToText(renderGenerationBrief(pkg));
    } catch {
      text = "This attempt's package predates the current brief format. Download the JSON snapshot instead.";
    }
    return new Response(text, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": `attachment; filename="${name}-brief.txt"`,
        "cache-control": "private, no-store",
      },
    });
  }
  return new Response(JSON.stringify(view.attempt.packageSnapshot, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${name}-package.json"`,
      "cache-control": "private, no-store",
    },
  });
}
