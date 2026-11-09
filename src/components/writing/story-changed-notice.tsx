import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui";
import { markSceneBreakdownReviewed } from "@/server/writing-actions";

/**
 * Phase 5B-S2: shown on a Shot (and its Scene) after an accepted screenplay change touched the Scene's text. Nothing
 * downstream was deleted or rewritten; the creator reviews the breakdown and marks it reviewed.
 */
export function StoryChangedNotice({
  slug,
  episodeSlug,
  sceneId,
  sceneLabel,
}: {
  slug: string;
  episodeSlug: string;
  sceneId: string;
  sceneLabel: string;
}) {
  return (
    <div
      className="mx-6 mt-3 flex flex-wrap items-center justify-between gap-3 rounded-[3px] border border-warn/40 bg-warn/5 px-3 py-2 text-[12px]"
      data-testid="story-changed"
    >
      <span className="text-warn">
        Story changed after production breakdown ({sceneLabel}). Check this Shot still matches the screenplay.
      </span>
      <span className="flex items-center gap-2">
        <Link
          className="text-accent"
          href={`/projects/${slug}/episodes/${episodeSlug}/write?scene=${sceneId}`}
        >
          See the screenplay
        </Link>
        <ActionForm action={markSceneBreakdownReviewed} quiet>
          <input type="hidden" name="projectSlug" value={slug} />
          <input type="hidden" name="sceneId" value={sceneId} />
          <Button type="submit" size="sm">
            Mark breakdown reviewed
          </Button>
        </ActionForm>
      </span>
    </div>
  );
}
