"use client";

import { useRef, useState } from "react";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui";
import type { StudioState } from "@/server/reference-studio";
import { saveCharacterAppearance } from "@/server/visual-bible-actions";

const WHAT_TO_SAY =
  "Age, origin or ethnicity, face shape, eyes, nose, mouth, skin, hair (length, colour, style), build and height, and anything distinctive (a scar, glasses, a mole).";

/**
 * A Character's written appearance, in the Studio. For a fictional Character with no photo it is everything the first
 * picture is made from, so it opens large with what to say; once the Character has photos it is a short note under
 * them (the pictures win where the two differ). Saving it changes the Character; "make the front view" then fills in
 * a Front portrait from words alone (nothing is spent until Generate).
 */
export function DescribeCharacter({
  slug,
  subject,
  hasPhotos,
  onMakeFront,
}: {
  slug: string;
  subject: NonNullable<StudioState["selected"]>;
  /** The Character has photos of their own (the description is then secondary). */
  hasPhotos: boolean;
  /** Fills in the brief: a Front portrait from the written description alone. */
  onMakeFront: () => void;
}) {
  const [text, setText] = useState(subject.appearance);
  const makeAfterSave = useRef(false);
  const changed = text.trim() !== subject.appearance.trim();
  const him = subject.name;

  const body = (
    <ActionForm
      action={saveCharacterAppearance}
      successMessage="Description saved"
      className="space-y-1.5"
      onResult={(r) => {
        if (r.ok && makeAfterSave.current) onMakeFront();
        makeAfterSave.current = false;
      }}
    >
      <input type="hidden" name="projectSlug" value={slug} />
      <input type="hidden" name="characterId" value={subject.id} />
      {subject.about ? (
        <p className="text-[11px] text-muted" data-testid="studio-describe-about">
          From the Bible: {subject.about}
        </p>
      ) : null}
      <textarea
        name="appearance"
        rows={hasPhotos ? 3 : 5}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={WHAT_TO_SAY}
        data-testid="studio-describe-text"
      />
      <p className="text-[10.5px] text-faint">{WHAT_TO_SAY}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={!changed || !text.trim()} data-testid="studio-describe-save">
          Save
        </Button>
        {!hasPhotos ? (
          <Button
            type={changed ? "submit" : "button"}
            variant="primary"
            disabled={!text.trim()}
            onClick={() => {
              if (changed) makeAfterSave.current = true;
              else onMakeFront();
            }}
            data-testid="studio-describe-make"
          >
            {changed ? "Save and make the front view" : "Make the front view from this"}
          </Button>
        ) : null}
      </div>
    </ActionForm>
  );

  if (hasPhotos)
    return (
      <details className="text-[12px]" data-testid="studio-describe">
        <summary className="text-muted hover:text-fg">Written description of {him}</summary>
        <div className="mt-1.5">{body}</div>
      </details>
    );
  return (
    <div
      className="rounded-[3px] border border-accent/40 bg-accent/5 p-2.5 text-[12px]"
      data-testid="studio-describe"
    >
      <h2 className="text-[12.5px] font-medium">Describe {him}</h2>
      <p className="mt-0.5 mb-1.5 text-[11.5px] text-muted">
        No photo of {him}? If {him} is fictional, describe how they look. The first picture, the front view,
        is made from this alone; every other view is then made from that picture.
      </p>
      {body}
    </div>
  );
}
