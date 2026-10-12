import { getCurrentUser } from "@/server/auth";
import { getRepo } from "@/server/repo";
import { storageForAsset } from "@/server/storage";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Only these are rendered inline; everything else downloads as an attachment. */
const INLINE = /^(image\/(png|jpeg|webp|gif|avif)|audio\/|video\/(mp4|webm|quicktime)|application\/pdf)/;

/**
 * Serves an asset to its owner. Authorisation is the repository read: the signed-in user's own RLS-bound
 * session must be able to see the asset row, otherwise this is a 404 (never a hint that it exists).
 * Supabase-stored assets redirect to a short-lived signed URL; local-disk assets are streamed.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID.test(id)) return new Response("Not found", { status: 404 });
  if (!(await getCurrentUser())) return Response.json({ error: "unauthenticated" }, { status: 401 });

  const asset = await (await getRepo()).findAsset(id);
  if (!asset?.objectPath) return new Response("Not found", { status: 404 });
  const storage = await storageForAsset(asset);
  if (!storage) return new Response("Not found", { status: 404 });

  const signed = await storage.signedUrl(asset.objectPath, 300);
  if (signed) {
    return new Response(null, {
      status: 307,
      headers: { location: signed, "cache-control": "private, no-store" },
    });
  }

  const bytes = await storage.get(asset.objectPath);
  if (!bytes) return new Response("Not found", { status: 404 });
  const mime = asset.mime ?? "application/octet-stream";
  const headers: Record<string, string> = {
    "content-type": mime,
    "x-content-type-options": "nosniff",
    "cache-control": "private, max-age=300",
    "accept-ranges": "bytes",
    "content-disposition": `${INLINE.test(mime) ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(asset.originalFilename || asset.name)}`,
  };

  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") ?? "");
  if (range) {
    const total = bytes.length;
    const start = range[1] === "" ? Math.max(0, total - Number(range[2])) : Number(range[1]);
    const end = range[1] === "" || range[2] === "" ? total - 1 : Math.min(Number(range[2]), total - 1);
    if (start >= total || start > end) {
      return new Response(null, { status: 416, headers: { "content-range": `bytes */${total}` } });
    }
    return new Response(Buffer.from(bytes.slice(start, end + 1)), {
      status: 206,
      headers: {
        ...headers,
        "content-range": `bytes ${start}-${end}/${total}`,
        "content-length": String(end - start + 1),
      },
    });
  }
  return new Response(Buffer.from(bytes), {
    headers: { ...headers, "content-length": String(bytes.length) },
  });
}
