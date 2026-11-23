import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui";
import { setViewLocked } from "@/server/visual-bible-actions";

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
