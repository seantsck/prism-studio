"use client";

import { useState } from "react";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui";
import { archiveProject, deleteProject } from "@/server/actions";

/**
 * Archive / Restore, and Delete, for one project in the Projects list. Delete opens a confirmation that names what goes
 * and only enables once the project's exact title is typed (the server checks the same thing).
 */
export function ProjectActions({
  slug,
  title,
  archived,
  archiveAvailable,
}: {
  slug: string;
  title: string;
  archived: boolean;
  archiveAvailable: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const matches = typed.trim() === title.trim();
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
          onClick={() => {
            setConfirming((c) => !c);
            setTyped("");
          }}
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
          <p>
            This deletes <span className="font-medium">{title}</span> and everything in it: episodes, scripts,
            characters, places, Shots, pictures and takes. It can&apos;t be undone.
          </p>
          <label className="block text-muted">
            Type the title to confirm
            <input
              name="confirmTitle"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              className="mt-0.5 w-full"
              data-testid="project-delete-title"
            />
          </label>
          <div className="flex gap-1">
            <Button
              type="submit"
              size="sm"
              disabled={!matches}
              className="text-fail"
              data-testid="project-delete"
            >
              Delete project
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
