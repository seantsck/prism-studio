import { ActionForm } from "@/components/action-form";
import { Button, PageHeader, Panel } from "@/components/ui";
import { trashDaysLeft, trashOf } from "@/domain/trash";
import { previewUrl } from "@/lib/utils";
import { requireProjectFresh } from "@/server/repo";
import { purgeExpiredTrash } from "@/server/trash";
import {
  deleteFromTrash,
  deleteSubjectNow,
  emptyTrash,
  restoreFromTrash,
  restoreSubject,
} from "@/server/trash-actions";

export const dynamic = "force-dynamic";

/**
 * The project's Trash: everything deleted in the last 30 days, newest first, with what it was and how long it stays.
 * Restore puts an item back where it was; Delete now and Empty trash remove for good after a confirmation.
 */
export default async function TrashPage({ params }: { params: Promise<{ project: string }> }) {
  const { project: slug } = await params;
  let data = await requireProjectFresh(slug);
  if (await purgeExpiredTrash(data)) data = await requireProjectFresh(slug);
  const now = new Date().toISOString();
  const items = (data.trashedAssets ?? [])
    .map((a) => ({ asset: a, record: trashOf(a)! }))
    .sort((x, y) => y.record.at.localeCompare(x.record.at));
  const subjects = [
    ...(data.trashedCharacters ?? []).map((c) => ({
      kind: "character" as const,
      id: c.id,
      name: c.name,
      at: c.trashedAt!,
    })),
    ...(data.trashedLocations ?? []).map((l) => ({
      kind: "location" as const,
      id: l.id,
      name: l.name,
      at: l.trashedAt!,
    })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const subjectName = (key: string | null) => {
    if (!key) return "Assets";
    const [kind, id] = key.split(":");
    return kind === "character"
      ? ([...data.characters, ...(data.trashedCharacters ?? [])].find((c) => c.id === id)?.name ??
          "a character")
      : ([...data.locations, ...(data.trashedLocations ?? [])].find((l) => l.id === id)?.name ??
          "a location");
  };

  return (
    <div>
      <PageHeader
        title="Trash"
        subtitle="Deleted characters, locations, pictures, takes and files stay here for 30 days, then they are deleted for good. Restore puts one back where it was."
      />
      <div className="space-y-4 p-6">
        {subjects.length ? (
          <Panel title={`Characters and locations (${subjects.length})`}>
            <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3" data-testid="trash-subjects">
              {subjects.map((x) => {
                const left = trashDaysLeft(x.at, now);
                return (
                  <li
                    key={x.id}
                    className="flex items-center justify-between gap-2 rounded-[3px] border border-line bg-panel p-2 text-[12px]"
                    data-testid="trash-subject"
                    data-kind={x.kind}
                    data-name={x.name}
                  >
                    <div className="min-w-0">
                      <div className="truncate font-medium">{x.name}</div>
                      <div className="text-muted">
                        {x.kind === "character" ? "Character" : "Location"} ·{" "}
                        {left === 0 ? "deleted today" : `${left} day${left === 1 ? "" : "s"} left`}
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <ActionForm action={restoreSubject} successMessage="Restored">
                        <input type="hidden" name="projectSlug" value={slug} />
                        <input type="hidden" name="kind" value={x.kind} />
                        <input type="hidden" name="id" value={x.id} />
                        <Button type="submit" data-testid="trash-subject-restore">
                          Restore
                        </Button>
                      </ActionForm>
                      <ActionForm
                        action={deleteSubjectNow}
                        successMessage="Deleted"
                        confirmMessage={`Delete ${x.name} for good, with ${x.kind === "character" ? "their references, Looks, voices and generated pictures' history" : "its views, 3D set and generated pictures' history"}? This can't be undone.`}
                      >
                        <input type="hidden" name="projectSlug" value={slug} />
                        <input type="hidden" name="kind" value={x.kind} />
                        <input type="hidden" name="id" value={x.id} />
                        <input type="hidden" name="confirm" value="1" />
                        <Button
                          type="submit"
                          variant="ghost"
                          className="text-fail"
                          data-testid="trash-subject-delete-now"
                        >
                          Delete now
                        </Button>
                      </ActionForm>
                    </div>
                  </li>
                );
              })}
            </ul>
          </Panel>
        ) : null}
        <Panel
          title={`Pictures and files (${items.length})`}
          actions={
            items.length + subjects.length ? (
              <ActionForm
                action={emptyTrash}
                successMessage=""
                confirmMessage={`Delete all ${items.length + subjects.length} for good? This can't be undone.`}
              >
                <input type="hidden" name="projectSlug" value={slug} />
                <input type="hidden" name="confirm" value="1" />
                <Button type="submit" variant="ghost" className="text-fail" data-testid="trash-empty">
                  Empty trash
                </Button>
              </ActionForm>
            ) : null
          }
        >
          {items.length === 0 ? (
            <p className="text-[13px] text-muted" data-testid="trash-empty-note">
              {subjects.length ? "No pictures or files in the Trash." : "Nothing in the Trash."}
            </p>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="trash">
              {items.map(({ asset, record }) => {
                const left = trashDaysLeft(record.at, now);
                return (
                  <li
                    key={asset.id}
                    className="flex gap-3 rounded-[3px] border border-line bg-panel p-2"
                    data-testid="trash-item"
                    data-asset={asset.id}
                  >
                    <div className="h-20 w-16 shrink-0 overflow-hidden rounded-[3px] border border-line2 bg-[#232326]">
                      {asset.type === "image" && previewUrl(asset) ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={previewUrl(asset)!} alt="" className="h-full w-full object-cover" />
                      ) : null}
                    </div>
                    <div className="min-w-0 flex-1 space-y-1 text-[12px]">
                      <div className="truncate font-medium" title={asset.name}>
                        {asset.name || "Untitled"}
                      </div>
                      <div className="text-muted">
                        From {subjectName(record.subject)} ·{" "}
                        {left === 0 ? "deleted today" : `${left} day${left === 1 ? "" : "s"} left`}
                      </div>
                      <div className="flex flex-wrap gap-1 pt-0.5">
                        <ActionForm action={restoreFromTrash} successMessage="Restored">
                          <input type="hidden" name="projectSlug" value={slug} />
                          <input type="hidden" name="assetId" value={asset.id} />
                          <Button type="submit" data-testid="trash-restore">
                            Restore
                          </Button>
                        </ActionForm>
                        <ActionForm
                          action={deleteFromTrash}
                          successMessage="Deleted"
                          confirmMessage={`Delete "${asset.name}" for good? This can't be undone.`}
                        >
                          <input type="hidden" name="projectSlug" value={slug} />
                          <input type="hidden" name="assetId" value={asset.id} />
                          <input type="hidden" name="confirm" value="1" />
                          <Button
                            type="submit"
                            variant="ghost"
                            className="text-fail"
                            data-testid="trash-delete-now"
                          >
                            Delete now
                          </Button>
                        </ActionForm>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
