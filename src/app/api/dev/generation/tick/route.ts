import { persistenceMode } from "@/lib/supabase/config";
import { tickInlineWorker } from "@/server/generation";

/**
 * Development/test hook: advance the in-process (memory-mode) generation worker by one step.
 * Disabled in production and in supabase mode, where jobs belong to the separate worker process
 * (`npm run worker:generation`). Takes no input and returns only counts.
 */
export async function POST() {
  const allowed =
    persistenceMode() === "memory" &&
    (process.env.NODE_ENV !== "production" || process.env.PRISM_STUDIO_DEV_GENERATION_TICK === "1");
  if (!allowed) return new Response("Not found", { status: 404 });
  const processed = await tickInlineWorker(5);
  return Response.json({ processed });
}
