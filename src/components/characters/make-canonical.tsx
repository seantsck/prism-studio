import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui";
import { setCanonicalIdentity } from "@/server/visual-bible-actions";

/**
 * "Make canonical" under a picture of a Character: the canonical identity is the one picture that defines the face,
 * sent with every Shot the Character is in. Replacing the current one is asked first (the old picture stays).
 */
export function MakeCanonical({
  slug,
  characterId,
  assetId,
  isCanonical,
  hasCanonical,
}: {
  slug: string;
  characterId: string;
  assetId: string;
  isCanonical: boolean;
  hasCanonical: boolean;
}) {
  if (isCanonical)
    return (
      <span className="text-[11px] font-medium text-pass" data-testid="canonical-mark">
        ✓ Canonical
      </span>
    );
  return (
    <ActionForm
      action={setCanonicalIdentity}
      successMessage=""
      quiet
      className="inline"
      confirmMessage={
        hasCanonical
          ? "Make this picture the canonical identity? It replaces the current one, which stays in your pictures."
          : undefined
      }
      data-testid="make-canonical"
    >
      <input type="hidden" name="projectSlug" value={slug} />
      <input type="hidden" name="characterId" value={characterId} />
      <input type="hidden" name="assetId" value={assetId} />
      {hasCanonical ? <input type="hidden" name="confirmReplace" value="1" /> : null}
      <Button type="submit" size="sm" data-testid="make-canonical-button">
        Make canonical
      </Button>
    </ActionForm>
  );
}
