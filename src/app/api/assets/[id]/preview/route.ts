import { getCurrentUser } from "@/server/auth";
import { previewOf } from "@/server/picture-preview";
import { getRepo } from "@/server/repo";
import { storageForAsset } from "@/server/storage";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A small preview of a picture, for its owner (the same authorisation as /api/assets/[id]: the signed-in user's own
 * RLS-bound read of the asset row). A stored asset never changes, so the browser keeps the preview: a page shown again
 * downloads nothing. Not a picture, or unreadable: the original, as /api/assets/[id] serves it.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID.test(id)) return new Response("Not found", { status: 404 });
  if (!(await getCurrentUser())) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const asset = await (await getRepo()).findAsset(id);
  if (!asset?.objectPath) return new Response("Not found", { status: 404 });
  const storage = await storageForAsset(asset);
  if (!storage) return new Response("Not found", { status: 404 });
  const bytes = await previewOf(storage, asset);
  if (!bytes)
    return new Response(null, {
      status: 307,
      headers: {
        location: new URL(`/api/assets/${id}`, req.url).toString(),
        "cache-control": "private, no-store",
      },
    });
  return new Response(Buffer.from(bytes), {
    headers: {
      "content-type": "image/webp",
      "content-length": String(bytes.length),
      "x-content-type-options": "nosniff",
      // the asset (and so its preview) never changes: kept by this browser only, for a year
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
}
