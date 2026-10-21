import type { ShotContext } from "@/domain/context";
import type { GenerationRepository } from "@/data/generation-repository";
import type { MediaQaRepository } from "@/data/media-qa-repository";
import type { ProductionFrameRepository } from "@/data/production-frame-repository";
import {
  draftGeneratedProductionFrame,
  type GeneratedFrameBlockCode,
} from "@/domain/generated-production-frame";
import type { ProductionFrame } from "@/domain/production-frame";
import type { Asset } from "@/domain/schemas";
import { randomUUID } from "node:crypto";

/**
 * Phase 2G.2 "Use as Production Frame" for a generated still image. No Next.js, no server-only imports: the server
 * action, the Supabase suite and the unit tests all call this one function, so memory and Postgres cannot disagree.
 *
 * It REUSES the attempt's existing private Asset (no byte copy) and the existing 2G.1 repository `create` (immutable
 * history + the one selection pointer + duplicate promotion returns the existing frame). It never writes
 * `shot.generation.startFrameAssetId`, never changes the Shot's modality, never reads or writes
 * `generation_attempts.approved`, and never mutates the attempt.
 */
export class GeneratedFrameRefused extends Error {
  constructor(
    readonly code: GeneratedFrameBlockCode | "no_attempt",
    message: string,
  ) {
    super(message);
    this.name = "GeneratedFrameRefused";
  }
}

export interface PromoteGeneratedDeps {
  frames: ProductionFrameRepository;
  generation: Pick<GenerationRepository, "getAttemptView">;
  qa: Pick<MediaQaRepository, "getDelivery" | "listAttemptDerivations">;
}

export async function promoteGeneratedFrame(
  deps: PromoteGeneratedDeps,
  ctx: ShotContext,
  args: { attemptId: string; userId: string | null; now?: string },
): Promise<{ frame: ProductionFrame; created: boolean; image: "delivery_conform" | "provider_original" }> {
  const view = await deps.generation.getAttemptView(args.attemptId);
  // RLS already hides other users' attempts in Supabase mode; the project check also covers memory mode
  if (!view || view.attempt.projectId !== ctx.project.id)
    throw new GeneratedFrameRefused("no_attempt", "That generation no longer exists in this project.");
  const images = view.outputs.filter((o) => o.asset.type === "image");
  const original =
    (images.find((o) => o.output.role === "primary") ?? images[0] ?? view.outputs[0])?.asset ?? null;

  let delivery: Asset | null = null;
  const selected = await deps.qa.getDelivery(view.attempt.id);
  if (selected) {
    delivery =
      selected.assetId === original?.id
        ? original
        : ((await deps.qa.listAttemptDerivations(view.attempt.id)).find(
            (d) => d.asset.id === selected.assetId,
          )?.asset ?? null);
  }

  const now = args.now ?? new Date().toISOString();
  const drafted = draftGeneratedProductionFrame(
    ctx,
    { attempt: view.attempt, original, delivery },
    { id: randomUUID(), now, userId: args.userId },
  );
  if (!drafted.ok) throw new GeneratedFrameRefused(drafted.code, drafted.reason);
  const result = await deps.frames.create({
    draft: drafted.draft,
    newAsset: null, // the existing private Asset is reused: no duplicate bytes, no duplicate Asset
    select: true,
    userId: args.userId,
    now,
  });
  return { frame: result.frame, created: result.created, image: drafted.image };
}
