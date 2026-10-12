import { Badge, Button, Field, PageHeader, Panel } from "@/components/ui";
import { saveLocation, setLocationLocked } from "@/server/actions";
import { requireProject } from "@/server/repo";
import { ActionForm } from "@/components/action-form";

export default async function LocationsPage({ params }: { params: Promise<{ project: string }> }) {
  const { project: slug } = await params;
  const data = await requireProject(slug);
  const hidden = <input type="hidden" name="projectSlug" value={slug} />;
  const named = (xs: Array<{ name: string; description: string }>) =>
    xs.map((x) => (x.description ? `${x.name}: ${x.description}` : x.name)).join("\n");

  return (
    <div>
      <PageHeader
        title="Locations & sets"
        subtitle="Zones and entrances give shots a spatial vocabulary. A future 3D Set plugs into `set3d` without changing this model."
      />
      <div className="space-y-3 p-6">
        {[...data.locations, null].map((l) => (
          <details
            key={l?.id ?? "new"}
            className={l ? "border border-line bg-panel" : "border border-dashed border-line2"}
          >
            <summary className="flex items-center justify-between px-4 py-2.5">
              <span className={l ? "font-medium" : "text-muted"}>{l ? l.name : "+ New location"}</span>
              {l ? (
                <span className="flex items-center gap-1.5">
                  <Badge>{l.zones.length} zones</Badge>
                  <Badge>{l.entrances.length} entrances</Badge>
                  <Badge tone={l.locked ? "pass" : "warn"}>{l.locked ? "locked" : "open"}</Badge>
                </span>
              ) : null}
            </summary>
            <div className="border-t border-line p-4">
              <ActionForm action={saveLocation} className="grid max-w-4xl grid-cols-2 gap-3">
                {hidden}
                {l ? <input type="hidden" name="id" value={l.id} /> : null}
                <Field label="Name" className="col-span-2">
                  <input name="name" defaultValue={l?.name ?? ""} required disabled={l?.locked} />
                </Field>
                <Field label="Description" className="col-span-2">
                  <textarea
                    name="description"
                    rows={2}
                    defaultValue={l?.description ?? ""}
                    disabled={l?.locked}
                  />
                </Field>
                <Field label="Geography" className="col-span-2">
                  <textarea
                    name="geography"
                    rows={2}
                    defaultValue={l?.geography ?? ""}
                    disabled={l?.locked}
                  />
                </Field>
                <Field label="Zones" hint="name: description — one per line">
                  <textarea name="zones" rows={4} defaultValue={named(l?.zones ?? [])} disabled={l?.locked} />
                </Field>
                <Field label="Entrances / exits" hint="name: description — one per line">
                  <textarea
                    name="entrances"
                    rows={4}
                    defaultValue={named(l?.entrances ?? [])}
                    disabled={l?.locked}
                  />
                </Field>
                <Field label="Lighting">
                  <textarea name="lighting" rows={2} defaultValue={l?.lighting ?? ""} disabled={l?.locked} />
                </Field>
                <Field label="Recurring props" hint="One per line">
                  <textarea
                    name="recurringProps"
                    rows={2}
                    defaultValue={(l?.recurringProps ?? []).join("\n")}
                    disabled={l?.locked}
                  />
                </Field>
                {!l?.locked ? (
                  <div className="col-span-2">
                    <Button type="submit" variant="primary">
                      {l ? "Save location" : "Create location"}
                    </Button>
                  </div>
                ) : null}
              </ActionForm>
              {l ? (
                <ActionForm action={setLocationLocked} className="mt-3">
                  {hidden}
                  <input type="hidden" name="id" value={l.id} />
                  <input type="hidden" name="locked" value={String(!l.locked)} />
                  <Button type="submit">{l.locked ? "Unlock location" : "Lock location"}</Button>
                </ActionForm>
              ) : null}
              {l ? (
                <Panel title="3D set (reserved)" className="mt-4 max-w-4xl">
                  <p className="text-muted">
                    {l.set3d?.modelAssetId
                      ? "3D model attached."
                      : "No 3D set yet. Phase 4 attaches persistent geometry, camera rigs and blocking markers here."}
                  </p>
                </Panel>
              ) : null}
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}
