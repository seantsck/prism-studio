import { Badge, Field } from "@/components/ui";
import {
  LOCATION_VIEW_KIND_LABEL,
  LOCATION_VIEW_KINDS,
  LOCATION_VIEW_SOURCE_LABEL,
  type LocationView,
} from "@/domain/location-view";
import type { Asset, Location } from "@/domain/schemas";
import { assetUrl } from "@/lib/utils";

const stamp = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;

/**
 * The view-spec fields every "create a Location View" form submits (`lv_*`). Words only: zone and entrance are chosen
 * from the Location's own lists; nothing here is a coordinate or a 3D camera.
 */
export function LocationViewSpecFields({
  location,
  defaultName,
  compact = false,
  testIdPrefix,
}: {
  location: Pick<Location, "zones" | "entrances">;
  defaultName?: string;
  /** the short form (Save as Location View): name, kind, zone, entrance, viewpoint, orientation, notes */
  compact?: boolean;
  testIdPrefix: string;
}) {
  const tid = (k: string) => `${testIdPrefix}-${k}`;
  return (
    <>
      <Field label="Name">
        <input
          data-testid={tid("name")}
          name="lv_name"
          required
          maxLength={120}
          defaultValue={defaultName ?? ""}
          placeholder="Doorway"
        />
      </Field>
      <Field label="Kind">
        <select data-testid={tid("kind")} name="lv_kind" defaultValue="establishing">
          {LOCATION_VIEW_KINDS.map((k) => (
            <option key={k} value={k}>
              {LOCATION_VIEW_KIND_LABEL[k]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Zone" hint="optional">
        <select data-testid={tid("zone")} name="lv_zoneId" defaultValue="">
          <option value="">—</option>
          {location.zones.map((z) => (
            <option key={z.id} value={z.id}>
              {z.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Entrance" hint="optional">
        <select data-testid={tid("entrance")} name="lv_entranceId" defaultValue="">
          <option value="">—</option>
          {location.entrances.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Viewpoint / direction" className="col-span-2">
        <input
          data-testid={tid("viewpoint")}
          name="lv_viewpointDescription"
          maxLength={2000}
          placeholder="from the entrance toward the window table"
        />
      </Field>
      <Field label="Orientation" hint="optional">
        <input name="lv_orientation" maxLength={2000} placeholder="east-facing" />
      </Field>
      {compact ? null : (
        <>
          <Field label="Camera position" hint="optional">
            <input name="lv_cameraPosition" maxLength={2000} />
          </Field>
          <Field label="Camera height" hint="optional">
            <input name="lv_cameraHeight" maxLength={2000} />
          </Field>
          <Field label="Camera angle" hint="optional">
            <input name="lv_cameraAngle" maxLength={2000} />
          </Field>
          <Field label="Shot size" hint="optional">
            <input name="lv_shotSize" maxLength={2000} />
          </Field>
          <Field label="Framing" hint="optional">
            <input name="lv_framing" maxLength={2000} />
          </Field>
          <Field label="Lens" hint="optional">
            <input name="lv_lens" maxLength={2000} />
          </Field>
          <Field label="Geography notes" hint="optional" className="col-span-2">
            <input name="lv_geographyNotes" maxLength={2000} />
          </Field>
        </>
      )}
      <Field label="Continuity notes" hint="optional" className="col-span-2">
        <input name="lv_continuityNotes" maxLength={2000} />
      </Field>
    </>
  );
}

/** One canonical view: its image (private asset route only), name, kind and the facts that say what it shows. */
export function LocationViewCard({
  view,
  asset,
  children,
  selected = false,
}: {
  view: LocationView;
  asset: Asset | null | undefined;
  children?: React.ReactNode;
  selected?: boolean;
}) {
  const url = assetUrl(asset);
  const s = view.viewSpec;
  return (
    <div
      data-testid="location-view-card"
      data-view-id={view.id}
      data-view-name={view.name}
      data-source={view.source}
      className="flex gap-3 border border-line p-2"
    >
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          data-testid="location-view-image"
          src={url}
          alt={`Location View "${view.name}"`}
          className="h-16 shrink-0 border border-line object-cover"
          style={{ aspectRatio: `${view.width} / ${view.height}` }}
        />
      ) : null}
      <div className="min-w-0 flex-1 space-y-0.5 text-[12px]">
        <div className="flex flex-wrap items-center gap-1.5">
          <span data-testid="location-view-name" className="font-medium">
            {view.name}
          </span>
          <Badge tone="info">{LOCATION_VIEW_KIND_LABEL[view.kind]}</Badge>
          {selected ? <Badge tone="accent">selected</Badge> : null}
        </div>
        <div className="text-[11px] text-muted">
          {[
            s.zone && `zone: ${s.zone.name}`,
            s.entrance && `entrance: ${s.entrance.name}`,
            s.orientation && `orientation: ${s.orientation}`,
          ]
            .filter(Boolean)
            .join(" · ") || "no zone or orientation recorded"}
        </div>
        {s.viewpointDescription ? <div className="text-[11px]">{s.viewpointDescription}</div> : null}
        {s.continuityNotes ? <div className="text-[11px] text-muted">{s.continuityNotes}</div> : null}
        <div className="font-mono text-[10.5px] text-faint">
          {LOCATION_VIEW_SOURCE_LABEL[view.source]} · {view.width}×{view.height} · {stamp(view.createdAt)}
        </div>
      </div>
      {children ? <div className="shrink-0 self-center">{children}</div> : null}
    </div>
  );
}
