import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui";
import { setCanonicalIdentity, setViewLocked } from "@/server/visual-bible-actions";

/**
 * "Use as front view (canonical)" for any picture of a Character: the front view is the canonical identity, so this
 * puts the picture in the front view (asked first; the picture there now stays in the Character's pictures).
 */
export function UseAsFront({
  slug,
  characterId,
  assetId,
  attemptId,
  isFront,
}: {
  slug: string;
  characterId: string;
  assetId?: string | null;
  attemptId?: string | null;
  isFront: boolean;
}) {
  if (isFront)
    return (
      <span className="text-[11px] font-medium text-pass" data-testid="canonical-mark">
        ✓ Canonical (front)
      </span>
    );
  return (
    <ActionForm
      action={setCanonicalIdentity}
      successMessage=""
      quiet
      className="inline"
      confirmMessage="Use this picture as the front view? The front view is the canonical identity, sent with every shot. The front view now in the set stays in your pictures."
      data-testid="use-as-front"
    >
      <input type="hidden" name="projectSlug" value={slug} />
      <input type="hidden" name="characterId" value={characterId} />
      {attemptId ? (
        <input type="hidden" name="attemptId" value={attemptId} />
      ) : (
        <input type="hidden" name="assetId" value={assetId ?? ""} />
      )}
      <input type="hidden" name="confirmReplace" value="1" />
      <Button type="submit" size="sm" data-testid="use-as-front-button">
        Make canonical (front)
      </Button>
    </ActionForm>
  );
}

/** Lock / Unlock one view of the reference set: a locked view keeps its picture (not made again, not replaced). */
export function ViewLock({
  slug,
  characterId,
  view,
  locked,
}: {
  slug: string;
  characterId: string;
  view: string;
  locked: boolean;
}) {
  return (
    <ActionForm action={setViewLocked} successMessage="" quiet className="inline">
      <input type="hidden" name="projectSlug" value={slug} />
      <input type="hidden" name="characterId" value={characterId} />
      <input type="hidden" name="view" value={view} />
      <input type="hidden" name="locked" value={String(!locked)} />
      <Button
        type="submit"
        size="sm"
        title={
          locked
            ? "Unlock this view so it can be made again or replaced"
            : "Lock this picture in place: it is not made again or replaced"
        }
        data-testid="reference-view-lock"
        data-locked={locked ? "1" : "0"}
      >
        {locked ? "🔒 Unlock" : "Lock"}
      </Button>
    </ActionForm>
  );
}
