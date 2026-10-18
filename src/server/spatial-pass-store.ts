import type { Asset } from "@/domain/schemas";

/**
 * All-or-nothing persistence of a spatial control-pass bundle's private assets.
 *
 * A bundle spans several stored objects (depth, object ids, one mask per Character), the same number of Asset rows,
 * and one immutable bundle row. There is no multi-store transaction, so this runs a compensating cleanup:
 *   put object → write Asset row   (for each asset, in order)
 *   then record the bundle row
 * If ANY step throws, or the bundle turns out to already exist, everything this attempt wrote is removed
 * (rows first, then objects). Cleanup is best-effort and idempotent: a row or object that is already gone is not an
 * error, and a cleanup failure NEVER replaces the original error the caller must see.
 */
export interface PassWrite {
  asset: Asset;
  bytes: Uint8Array;
  objectPath: string;
  mime: string;
}

export interface PassStoreDeps {
  putObject(path: string, bytes: Uint8Array, mime: string): Promise<void>;
  upsertAsset(asset: Asset): Promise<void>;
  removeAsset(assetId: string): Promise<void>;
  removeObject(asset: Asset): Promise<void>;
}

/** Removes everything the given assets wrote. Never throws. Safe to call any number of times. */
export async function removePassAssets(deps: PassStoreDeps, assets: readonly Asset[]): Promise<void> {
  for (const asset of assets) {
    try {
      await deps.removeAsset(asset.id);
    } catch {
      /* the row may never have been written, or is already gone */
    }
    try {
      await deps.removeObject(asset);
    } catch {
      /* an object that is already gone (or an orphan that is never referenced) is harmless */
    }
  }
}

export async function persistPassBundle<T extends { existing: boolean }>(
  deps: PassStoreDeps,
  writes: readonly PassWrite[],
  recordBundle: () => Promise<T>,
): Promise<T> {
  const attempted = writes.map((w) => w.asset);
  try {
    for (const w of writes) {
      await deps.putObject(w.objectPath, w.bytes, w.mime);
      await deps.upsertAsset(w.asset);
    }
    const out = await recordBundle();
    if (out.existing) await removePassAssets(deps, attempted); // lost a race with an identical capture: ours are surplus
    return out;
  } catch (err) {
    await removePassAssets(deps, attempted); // never throws, so the original error below is what the caller sees
    throw err;
  }
}
