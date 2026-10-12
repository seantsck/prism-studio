import { getRepo } from "@/server/repo";
import { storage } from "@/server/storage";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const asset = await getRepo().findAsset(id);
  if (!asset?.storagePath) return new Response("Not found", { status: 404 });
  const bytes = await storage.get(asset.storagePath);
  if (!bytes) return new Response("Not found", { status: 404 });
  return new Response(Buffer.from(bytes), {
    headers: {
      "content-type": asset.mime ?? "application/octet-stream",
      "cache-control": "private, max-age=3600",
    },
  });
}
