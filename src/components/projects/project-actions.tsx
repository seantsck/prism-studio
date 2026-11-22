"use client";

import { useState } from "react";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui";
import { archiveProject, deleteProject, deleteProjectNow, restoreProject } from "@/server/actions";

/**
 * Archive / Restore, and Delete, for one project in the Projects list. Delete opens a confirmation, then moves the
 * project to the Trash (30 days, restorable); deleting it for good from the Trash needs its exact title typed.
 */
export function ProjectActions({
  slug,
  title,
  archived,
  archiveAvailable,
  libraryNames = [],
}: {
  slug: string;
  title: string;
  archived: boolean;
  archiveAvailable: boolean;
  /** Characters of this project saved in the library (they leave it if the project is deleted). */
  libraryNames?: string[];
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="flex flex-col items-end gap-1" data-testid="project-actions">
      <div className="flex gap-1">
        <ActionForm action={archiveProject} successMessage={archived ? "Restored" : "Archived"} quiet>
          <input type="hidden" name="projectSlug" value={slug} />
          <input type="hidden" name="archived" value={archived ? "0" : "1"} />
          <Button
            type="submit"
            size="sm"
            disabled={!archiveAvailable}
            title={
              archiveAvailable
                ? archived
                  ? "Put it back in your projects"
                  : "Hide it from your projects. Everything in it is kept, and you can restore it."
                : "Archiving needs a one-time database update first."
            }
            data-testid={archived ? "project-restore" : "project-archive"}
          >
            {archived ? "Restore" : "Archive"}
          </Button>
        </ActionForm>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="text-fail"
          aria-expanded={confirming}
          onClick={() => setConfirming((c) => !c)}
          data-testid="project-delete-open"
        >
          Delete…
        </Button>
      </div>
      {confirming ? (
        <ActionForm
          action={deleteProject}
          successMessage=""
          className="w-72 space-y-1.5 rounded-[3px] border border-fail/50 bg-bg p-2 text-[12px]"
          data-testid="project-delete-confirm"
        >
          <input type="hidden" name="projectSlug" value={slug} />
          <input type="hidden" name="confirm" value="1" />
          <p>
            Move <span className="font-medium">{title}</span> to the Trash? It leaves your projects with
            everything in it, and you can restore it for 30 days. After that it is deleted for good.
          </p>
          {libraryNames.length ? (
            <p className="text-warn" data-testid="project-delete-library">
              {libraryNames.join(", ")} {libraryNames.length === 1 ? "leaves" : "leave"} your library while it
              is in the Trash (copies already added to other projects stay). Archive it instead to keep{" "}
              {libraryNames.length === 1 ? "it" : "them"} in the library.
            </p>
          ) : null}
          <div className="flex gap-1">
            <Button type="submit" size="sm" className="text-fail" data-testid="project-delete">
              Move to Trash
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </ActionForm>
      ) : null}
    </div>
  );
}

/** A project in the Trash: Restore, or Delete now (confirmed by typing its exact title). */
export function TrashedProjectActions({ id, title }: { id: string; title: string }) {
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const matches = typed.trim() === title.trim();
  return (
    <div className="flex flex-col items-end gap-1" data-testid="trashed-project-actions">
      <div className="flex gap-1">
        <ActionForm action={restoreProject} successMessage="Restored" quiet>
          <input type="hidden" name="projectId" value={id} />
          <Button type="submit" size="sm" data-testid="project-trash-restore">
            Restore
          </Button>
        </ActionForm>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="text-fail"
          aria-expanded={confirming}
          onClick={() => {
            setConfirming((c) => !c);
            setTyped("");
          }}
          data-testid="project-trash-delete-open"
        >
          Delete now…
        </Button>
      </div>
      {confirming ? (
        <ActionForm
          action={deleteProjectNow}
          successMessage=""
          className="w-72 space-y-1.5 rounded-[3px] border border-fail/50 bg-bg p-2 text-[12px]"
          data-testid="project-trash-delete-confirm"
        >
          <input type="hidden" name="projectId" value={id} />
          <p>
            This deletes <span className="font-medium">{title}</span> and everything in it for good: episodes,
            scripts, characters, places, Shots, pictures and takes. It can&apos;t be undone.
          </p>
          <label className="block text-muted">
            Type the title to confirm
            <input
              name="confirmTitle"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              className="mt-0.5 w-full"
              data-testid="project-trash-delete-title"
            />
          </label>
          <div className="flex gap-1">
            <Button
              type="submit"
              size="sm"
              disabled={!matches}
              className="text-fail"
              data-testid="project-trash-delete"
            >
              Delete for good
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </ActionForm>
      ) : null}
    </div>
  );
}
