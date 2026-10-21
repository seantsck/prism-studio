import { randomUUID } from "node:crypto";
import type {
  CreateProductionFrameResult,
  ProductionFrameRepository,
} from "@/data/production-frame-repository";
import type { ShotContext } from "@/domain/context";
import { draftProductionFrame } from "@/domain/production-frame";
import type { Asset } from "@/domain/schemas";
import { UserFacingError } from "./action-result";

/**
 * Persists a Production Frame for an image that was JUST stored (an upload), leaving no durable broken state:
 *
 *   refused by the image rules (wrong shape/type)  → the stored object is removed; nothing was written
 *   the database write fails (any reason)          → the stored object is removed; the transaction rolled back, so
 *                                                    neither the Asset row nor a frame nor a selection exists
 *   an identical frame already existed             → that frame is re-selected; the redundant object is removed
 *   success                                        → the new private Asset, the frame and the selection were stored
 *                                                    together, in one transaction
 *
 * Cleanup is best effort and idempotent (`discard` never throws): an object left behind is unreferenced and harmless.
 * No public URL and no signed URL is created or kept.
 */
export interface UploadDeps {
  repo: ProductionFrameRepository;
  /** removes the stored object (never throws) */
  discard: (asset: Asset) => Promise<void>;
  now?: () => string;
  newId?: () => string;
}

export async function persistUploadedFrame(
  deps: UploadDeps,
  ctx: ShotContext,
  asset: Asset,
  userId: string | null,
): Promise<CreateProductionFrameResult> {
  const now = (deps.now ?? (() => new Date().toISOString()))();
  const drafted = draftProductionFrame(ctx, {
    id: (deps.newId ?? randomUUID)(),
    now,
    userId,
    source: "upload",
    asset,
  });
  if (!drafted.ok) {
    await deps.discard(asset);
    throw new UserFacingError(drafted.problem.message);
  }
  try {
    const result = await deps.repo.create({
      draft: drafted.draft,
      newAsset: asset,
      select: true,
      userId,
      now,
    });
    // an identical frame already existed: the new object was never referenced
    if (!result.created) await deps.discard(asset);
    return result;
  } catch (err) {
    await deps.discard(asset);
    throw err;
  }
}
