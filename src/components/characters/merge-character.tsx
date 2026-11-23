"use client";

import { useState } from "react";
import { ActionForm } from "@/components/action-form";
import { Button, Panel } from "@/components/ui";
import { mergeCharacter } from "@/server/character-merge-actions";

export interface MergeTarget {
  id: string;
  name: string;
  role: string;
  /** where the story uses it ("1 Shot: 1A; 1 line of dialogue"), empty when nowhere */
  usedIn: string;
  /** what merging into it does, per side that wins; or why it cannot be done */
  preview: { merged: string[]; kept: string[] } | { refused: string };
}

/**
 * "Merge into…": when this Character is the same person as another one of the project (say, one written from the
 * script and one made on its own), merge it into that one. The one chosen is kept, with its place in the story; this
 * one's pictures, Looks and sheet join it, and this one goes to the Trash (restorable).
 */
export function MergeCharacter({
  slug,
  characterId,
  name,
  targets,
}: {
  slug: string;
  characterId: string;
  name: string;
  targets: MergeTarget[];
}) {
  // the most likely match first: a character whose name shares a word with this one
  const words = new Set(name.toLowerCase().split(/\s+/).filter(Boolean));
  const likely = targets.find((t) =>
    t.name
      .toLowerCase()
      .split(/\s+/)
      .some((w) => words.has(w)),
  );
  const [into, setInto] = useState(likely?.id ?? targets[0]?.id ?? "");
  const [prefer, setPrefer] = useState<"merged" | "kept">("merged");
  const [keepName, setKeepName] = useState<"merged" | "kept">("merged");
  const target = targets.find((t) => t.id === into);
  const preview = target && !("refused" in target.preview) ? target.preview : null;
  if (targets.length === 0) return null;
  const finalName = keepName === "merged" || !target ? name : target.name;
  return (
    <div className="xl:col-span-2" id="merge-character">
      <Panel title="Same person as another character?">
        <details data-testid="merge-character" open={!!likely}>
          <summary className="cursor-pointer text-[12.5px]">
            Merge {name} into another character
            {likely ? (
              <span className="ml-2 text-accent">{likely.name} looks like the same person</span>
            ) : null}
          </summary>
          <div className="mt-3 space-y-3 text-[12.5px]">
            <p className="text-muted">
              The character you choose is kept, with its place in the story (its shots, scenes and lines).{" "}
              {name}&apos;s pictures, reference set, Looks and sheet join it, and {name} goes to the Trash,
              where it can be restored. Nothing is deleted.
            </p>
            <label className="flex items-center gap-2">
              <span className="shrink-0 text-muted">Merge into</span>
              <select
                value={into}
                onChange={(e) => setInto(e.target.value)}
                className="min-w-0 flex-1"
                data-testid="merge-into"
              >
                {targets.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                    {t.role ? ` (${t.role})` : ""}
                    {t.usedIn ? ` · in the story: ${t.usedIn}` : ""}
                  </option>
                ))}
              </select>
            </label>
            {target && "refused" in target.preview ? (
              <p className="text-warn" data-testid="merge-refused">
                {target.preview.refused}
              </p>
            ) : target ? (
              <ActionForm
                action={mergeCharacter}
                successMessage=""
                className="space-y-3"
                confirmMessage={`Merge ${name} into ${target.name}? ${target.name} is kept and named "${finalName}"; ${name} goes to the Trash (restorable).`}
              >
                <input type="hidden" name="projectSlug" value={slug} />
                <input type="hidden" name="characterId" value={characterId} />
                <input type="hidden" name="intoCharacterId" value={target.id} />
                <input type="hidden" name="name" value={finalName} />
                <input type="hidden" name="prefer" value={prefer} />
                <fieldset className="space-y-1">
                  <legend className="font-medium">Name after merging</legend>
                  {(["merged", "kept"] as const).map((k) => (
                    <label key={k} className="flex items-center gap-2">
                      <input
                        type="radio"
                        checked={keepName === k}
                        onChange={() => setKeepName(k)}
                        data-testid={`merge-name-${k}`}
                      />
                      {k === "merged" ? name : target.name}
                    </label>
                  ))}
                </fieldset>
                <fieldset className="space-y-1">
                  <legend className="font-medium">
                    Where both have something (a picture for a view, a written field)
                  </legend>
                  {(["merged", "kept"] as const).map((k) => (
                    <label key={k} className="flex items-center gap-2">
                      <input
                        type="radio"
                        checked={prefer === k}
                        onChange={() => setPrefer(k)}
                        data-testid={`merge-prefer-${k}`}
                      />
                      Use {k === "merged" ? name : target.name}&apos;s
                    </label>
                  ))}
                </fieldset>
                <ul className="list-disc space-y-0.5 pl-5 text-muted" data-testid="merge-summary">
                  {(preview?.[prefer] ?? []).map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
                <Button type="submit" variant="primary" data-testid="merge-submit">
                  Merge into {target.name}
                </Button>
              </ActionForm>
            ) : null}
          </div>
        </details>
      </Panel>
    </div>
  );
}
