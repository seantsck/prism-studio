import Link from "next/link";
import { Badge, Button, Field, PageHeader, Panel } from "@/components/ui";
import { saveLocation, setLocationLocked } from "@/server/actions";
import { createLocationViewFromReference, uploadLocationView } from "@/server/location-view-actions";
import { requireProject } from "@/server/repo";
import { ActionForm } from "@/components/action-form";
import { LocationViewCard, LocationViewSpecFields } from "@/components/location-views/location-view-ui";
import { checkLocationViewImage } from "@/domain/location-view";

export default async function LocationsPage({ params }: { params: Promise<{ project: string }> }) {
  const { project: slug } = await params;
  const data = await requireProject(slug);
  const hidden = <input type="hidden" name="projectSlug" value={slug} />;
  const named = (xs: Array<{ name: string; description: string }>) =>
    xs.map((x) => (x.description ? `${x.name}: ${x.description}` : x.name)).join("\n");
  const assets = new Map(data.assets.map((a) => [a.id, a]));
  const viewsOf = (locationId: string) =>
    (data.locationViews ?? [])
      .filter((v) => v.locationId === locationId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

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
                <Panel title="Location Views" className="mt-4 max-w-4xl">
                  <div data-testid={`location-views-${l.id}`} className="space-y-3">
                    <p className="text-muted">
                      Canonical viewpoints of this place (Doorway, Window side, Reverse...). Each is one image
                      plus a description of the viewpoint, kept unchanged once saved; a revised view is a new
                      one. A Shot set here can choose a view, and Prism gives that same image to its image
                      generations.
                    </p>
                    {viewsOf(l.id).length > 0 ? (
                      <div className="space-y-1.5">
                        {viewsOf(l.id).map((v) => (
                          <LocationViewCard key={v.id} view={v} asset={assets.get(v.assetId)} />
                        ))}
                      </div>
                    ) : (
                      <p data-testid="location-views-empty" className="text-[12px] text-faint">
                        No Location Views yet.
                      </p>
                    )}
                    <details data-testid="lv-upload" className="border border-line">
                      <summary className="cursor-pointer select-none px-2.5 py-1.5 text-[12px] font-medium">
                        Upload Location View
                      </summary>
                      <ActionForm
                        action={uploadLocationView}
                        resetOnSuccess
                        successMessage="Location View saved"
                        className="grid grid-cols-2 items-end gap-2 border-t border-line p-2.5"
                      >
                        {hidden}
                        <input type="hidden" name="locationId" value={l.id} />
                        <Field
                          label="Image"
                          hint="PNG, JPEG or WebP; any shape (it is never cropped)"
                          className="col-span-2"
                        >
                          <input
                            data-testid="lv-upload-file"
                            type="file"
                            name="file"
                            accept="image/png,image/jpeg,image/webp"
                            required
                            className="!p-0.5"
                          />
                        </Field>
                        <LocationViewSpecFields location={l} testIdPrefix="lv-upload" />
                        <div className="col-span-2">
                          <Button data-testid="lv-upload-submit" size="sm" type="submit">
                            Create Location View
                          </Button>
                        </div>
                      </ActionForm>
                    </details>
                    {l.referenceAssetIds.some((id) => checkLocationViewImage(assets.get(id) ?? null).ok) ? (
                      <details data-testid="lv-from-reference" className="border border-line">
                        <summary className="cursor-pointer select-none px-2.5 py-1.5 text-[12px] font-medium">
                          Use existing Location reference
                        </summary>
                        <ActionForm
                          action={createLocationViewFromReference}
                          resetOnSuccess
                          successMessage="Location View saved"
                          className="grid grid-cols-2 items-end gap-2 border-t border-line p-2.5"
                        >
                          {hidden}
                          <input type="hidden" name="locationId" value={l.id} />
                          <Field label="Reference image" className="col-span-2">
                            <select data-testid="lv-reference-asset" name="assetId" required>
                              {l.referenceAssetIds
                                .filter((id) => checkLocationViewImage(assets.get(id) ?? null).ok)
                                .map((id) => (
                                  <option key={id} value={id}>
                                    {assets.get(id)?.name ?? id}
                                  </option>
                                ))}
                            </select>
                          </Field>
                          <LocationViewSpecFields location={l} testIdPrefix="lv-reference" />
                          <div className="col-span-2 text-[11px] text-muted">
                            The reference stays in this Location&apos;s references; the view reuses its image.
                          </div>
                          <div className="col-span-2">
                            <Button data-testid="lv-reference-submit" size="sm" type="submit">
                              Create Location View
                            </Button>
                          </div>
                        </ActionForm>
                      </details>
                    ) : null}
                  </div>
                </Panel>
              ) : null}
              {l ? (
                <Panel title="3D Set" className="mt-4 max-w-4xl">
                  <p className="text-muted">
                    A persistent virtual set for this location: block characters, place the production camera,
                    and render a master frame for any shot set here.
                  </p>
                  <Link
                    href={`/projects/${slug}/locations/${l.id}/3d`}
                    className="mt-2 inline-flex h-7 items-center rounded border border-accent bg-accent px-3 text-xs text-accentfg"
                    data-testid={`open-3d-set-${l.id}`}
                  >
                    Open 3D Set
                  </Link>
                </Panel>
              ) : null}
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}
