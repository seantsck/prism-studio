import { briefToText, renderGenerationBrief } from "@/domain/generation-package";
import { getCurrentUser } from "@/server/auth";
import { buildGenerationPackage } from "@/server/generation-package";

const SLUG = /^[a-z0-9][a-z0-9-]{0,80}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Export a shot's generation package.
 *   ?format=json   the full normalized package (default)
 *   ?format=brief  the human-readable generation brief as plain text
 * Authorised by the repository read (RLS); an unknown or foreign shot is a plain 404.
 */
export async function GET(req: Request, ctx: { params: Promise<{ project: string; shotId: string }> }) {
  const { project, shotId } = await ctx.params;
  if (!SLUG.test(project) || !UUID.test(shotId)) return new Response("Not found", { status: 404 });
  if (!(await getCurrentUser())) return Response.json({ error: "unauthenticated" }, { status: 401 });

  let pkg;
  try {
    pkg = await buildGenerationPackage(project, shotId);
  } catch {
    return new Response("Not found", { status: 404 });
  }
  const format = new URL(req.url).searchParams.get("format") === "brief" ? "brief" : "json";
  const name = `shot-${pkg.shot.code}`.replace(/[^A-Za-z0-9._-]/g, "_");
  if (format === "brief") {
    return new Response(briefToText(renderGenerationBrief(pkg)), {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": `attachment; filename="${name}-brief.txt"`,
        "cache-control": "private, no-store",
      },
    });
  }
  return new Response(JSON.stringify(pkg, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${name}-package.json"`,
      "cache-control": "private, no-store",
    },
  });
}
