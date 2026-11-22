"use client";

import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui";
import { archiveStudioImage, deleteArchivedImage, restoreStudioImage } from "@/server/archive-actions";
import type { StudioArchivedImage } from "@/server/reference-studio";

type Subject = { kind: "character" | "location"; id: string; name: string };

function Hidden({ slug, subject, assetId }: { slug: string; subject: Subject; assetId: string }) {
  return (
    <>
      <input type="hidden" name="projectSlug" value={slug} />
      <input type="hidden" name="subjectKind" value={subject.kind} />
      <input type="hidden" name="subjectId" value={subject.id} />
      <input type="hidden" name="assetId" value={assetId} />
    </>
  );
}

/**
 * Archive one picture: out of the Studio's lists and never sent, until it is restored. A picture that has a job (a view
 * of the reference set, a Look's picture, a Shot) is refused with what to change first.
 */
export function ArchiveButton({
  slug,
  subject,
  assetId,
  what = "picture",
  label = "Archive",
}: {
  slug: string;
  subject: Subject;
  assetId: string;
  what?: string;
  label?: string;
}) {
  return (
    <ActionForm action={archiveStudioImage} successMessage="Archived" className="inline-flex flex-col">
      <Hidden slug={slug} subject={subject} assetId={assetId} />
      <Button
        type="submit"
        title={`Hide this ${what}. It is kept, never sent, and can be restored or deleted from Archived.`}
        data-testid="studio-archive"
      >
        {label}
      </Button>
    </ActionForm>
  );
}

/** This subject's archive: restore any picture, or delete one for good when nothing depends on it. */
export function ArchivedPanel({
  slug,
  subject,
  archived,
}: {
  slug: string;
  subject: Subject;
  archived: StudioArchivedImage[];
}) {
  if (archived.length === 0) return null;
  return (
    <details className="mt-3 text-[12px]" data-testid="studio-archived">
      <summary className="cursor-pointer text-muted hover:text-fg">Archived ({archived.length})</summary>
      <p className="mt-1 text-[11.5px] text-muted">
        Hidden from {subject.name}&apos;s pictures and never sent. Restore puts a picture back where it was.
      </p>
      <ul className="mt-2 space-y-2">
        {archived.map((a) => (
          <li
            key={a.assetId}
            className="flex gap-2 rounded-[3px] border border-line bg-bg p-2"
            data-testid="studio-archived-item"
            data-asset={a.assetId}
          >
            <div className="h-[72px] w-[58px] shrink-0 overflow-hidden rounded-[3px] border border-line2 bg-[#232326]">
              {a.url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={a.url} alt="" className="h-full w-full object-cover" />
              ) : null}
            </div>
            <div className="min-w-0 flex-1 space-y-1">
              <div className="font-medium">{a.label}</div>
              <div className="flex flex-wrap items-start gap-2">
                <ActionForm action={restoreStudioImage} successMessage="Restored">
                  <Hidden slug={slug} subject={subject} assetId={a.assetId} />
                  <Button type="submit" data-testid="studio-restore">
                    Restore
                  </Button>
                </ActionForm>
                {a.deletable ? (
                  <ActionForm action={deleteArchivedImage} successMessage="Deleted" className="flex flex-col">
                    <Hidden slug={slug} subject={subject} assetId={a.assetId} />
                    <label className="flex items-center gap-1 text-[11px] text-muted">
                      <input
                        type="checkbox"
                        name="confirm"
                        value="1"
                        required
                        data-testid="studio-delete-confirm"
                      />
                      Delete it for good (this can&apos;t be undone)
                    </label>
                    <Button
                      type="submit"
                      variant="ghost"
                      className="mt-1 text-fail"
                      data-testid="studio-delete"
                    >
                      Delete permanently
                    </Button>
                  </ActionForm>
                ) : null}
              </div>
              {a.keptBecause ? (
                <p className="text-[11px] text-faint" data-testid="studio-kept-because">
                  Can&apos;t be deleted. {a.keptBecause}
                </p>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </details>
  );
}
