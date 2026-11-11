import { ActionForm } from "@/components/action-form";
import { Badge, Button, Field, Panel } from "@/components/ui";
import { LOCATION_VIEW_KIND_LABEL } from "@/domain/location-view";
import {
  LOCATION_VISUAL_ROLE_LABEL,
  SUGGESTED_LOCATION_VARIANTS,
  locationBibleReadiness,
} from "@/domain/location-visual-bible";
import type { ProjectData } from "@/domain/schemas";
import { assetUrl } from "@/lib/utils";
import {
  addLocationDesignation,
  clearLocationDesignation,
  setCanonicalLocation,
} from "@/server/location-visual-bible-actions";
import type { EditSource, ImageModelOption } from "@/server/subject-images";
import { startSubjectImage } from "@/server/subject-image-actions";

/**
 * Phase 5B-I5: the Location Visual Bible. Shows what the Location has and what Prism suggests next. Guidance only:
 * nothing here is a gate, nothing is generated or replaced automatically. Generate presets feed the existing image
 * pipeline; recurring camera views are the existing Location Views (made with "Use as Location View" on an image).
 */
const PRESET_LABEL: Record<string, string> = {
  location_concept: "Generate Canonical Appearance",
  establishing_view: "Generate Establishing View",
  alternate_angle: "Generate Alternate Angle",
  interior_view: "Generate Interior View",
  exterior_view: "Generate Exterior View",
  background: "Generate Background Plate",
  time_variant: "Generate Time-of-Day Variant",
};

export function LocationVisualBiblePanel(props: {
  data: ProjectData;
  locationId: string;
  slug: string;
  sources: EditSource[];
  models: ImageModelOption[];
}) {
  const { data, locationId, slug } = props;
  const location = data.locations.find((l) => l.id === locationId);
  if (!location) return null;
  const vb = locationBibleReadiness(data, locationId);
  const assets = new Map(data.assets.map((a) => [a.id, a]));
  const url = (id: string | null) => (id ? (assetUrl(assets.get(id)) ?? null) : null);
  const usable = props.models.filter((m) => m.available);
  const preferred = usable.find((m) => !m.paid) ?? usable[0] ?? null;
  const locked = location.locked;
  // the Location's own images: its references and generated images, plus its Location View images
  const sources: EditSource[] = [
    ...props.sources,
    ...vb.views
      .filter((v) => !props.sources.some((s) => s.assetId === v.assetId))
      .map((v) => ({ assetId: v.assetId, label: `View: ${v.view.name}`, url: url(v.assetId) })),
  ];
  const hidden = (
    <>
      <input type="hidden" name="projectSlug" value={slug} />
      <input type="hidden" name="locationId" value={locationId} />
    </>
  );
  const subjectHidden = (
    <>
      <input type="hidden" name="projectSlug" value={slug} />
      <input type="hidden" name="subjectKind" value="location" />
      <input type="hidden" name="subjectId" value={locationId} />
    </>
  );
  const sourceSelect = (testId: string) => (
    <select name="assetId" data-testid={testId} aria-label="Image">
      {sources.map((s) => (
        <option key={s.assetId} value={s.assetId}>
          {s.label}
        </option>
      ))}
    </select>
  );
  const generate = (intent: string) =>
    preferred ? (
      <ActionForm action={startSubjectImage} successMessage="Image queued" className="inline-flex gap-1">
        {subjectHidden}
        <input type="hidden" name="intent" value={intent} />
        <input type="hidden" name="model" value={`${preferred.provider}/${preferred.modelId}`} />
        {intent === "time_variant" ? (
          <input
            name="variant"
            list={`lvb-var-${locationId}`}
            placeholder="night"
            aria-label="Time of day or state"
            className="w-24"
            required
          />
        ) : null}
        <Button type="submit" size="sm" data-testid={`lvb-generate-${intent}`}>
          {PRESET_LABEL[intent] ?? "Generate"}
        </Button>
      </ActionForm>
    ) : null;
  const lockedNote = locked ? (
    <p className="text-[11px] text-muted" data-testid="lvb-locked">
      This Location is locked: unlock it to change its Visual Bible.
    </p>
  ) : null;

  return (
    <Panel
      title="Visual Bible"
      className="mt-4 max-w-4xl"
      actions={
        <Badge tone={vb.done === vb.total ? "pass" : "neutral"}>
          {vb.done} / {vb.total} ready
        </Badge>
      }
    >
      <div
        className="grid gap-4 p-3 md:grid-cols-[260px_1fr]"
        data-testid={`location-visual-bible-${locationId}`}
      >
        <figure>
          {url(vb.canonicalAssetId) ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={url(vb.canonicalAssetId)!}
              alt={`${location.name} canonical appearance`}
              className="w-full rounded"
              data-testid="lvb-canonical-image"
            />
          ) : (
            <div className="flex aspect-video items-center justify-center rounded border border-dashed border-line text-xs text-muted">
              No canonical appearance yet
            </div>
          )}
          <figcaption className="mt-1 text-sm font-medium">{location.name}</figcaption>
        </figure>

        <div className="space-y-3">
          <ul className="space-y-1 text-[13px]" data-testid="lvb-readiness">
            {vb.items.map((i) => (
              <li
                key={i.key}
                className="flex flex-wrap items-center gap-2"
                data-testid={`lvb-item-${i.key}`}
                data-done={i.done}
              >
                <span aria-hidden>{i.done ? "✓" : "○"}</span>
                <span>{i.label}</span>
                {!i.done && i.suggestion ? (
                  <span className="text-[11px] text-muted">{i.suggestion}</span>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-muted">
            Guidance only: skip anything you don&apos;t need. Nothing is generated or replaced without you.
          </p>

          <div className="flex flex-wrap gap-1" data-testid="lvb-presets">
            {[
              "location_concept",
              "establishing_view",
              "alternate_angle",
              "interior_view",
              "exterior_view",
              "background",
              "time_variant",
            ].map((intent) => (
              <span key={intent}>{generate(intent)}</span>
            ))}
            <datalist id={`lvb-var-${locationId}`}>
              {SUGGESTED_LOCATION_VARIANTS.map((x) => (
                <option key={x} value={x} />
              ))}
            </datalist>
          </div>

          {lockedNote}
          {!locked && sources.length > 0 ? (
            <ActionForm
              action={setCanonicalLocation}
              successMessage="Canonical appearance set"
              className="flex flex-wrap items-end gap-2"
            >
              {hidden}
              <Field label="Canonical appearance">{sourceSelect("lvb-canonical-source")}</Field>
              {vb.canonicalAssetId ? (
                <label className="flex items-center gap-1 text-[11px]">
                  <input
                    type="checkbox"
                    name="confirmReplace"
                    value="1"
                    data-testid="lvb-canonical-confirm"
                  />
                  Replace the current canonical appearance
                </label>
              ) : null}
              <Button type="submit" size="sm" data-testid="lvb-use-as-canonical">
                Use as Canonical
              </Button>
            </ActionForm>
          ) : null}

          <div className="space-y-1" data-testid="lvb-views">
            <div className="text-[12px] font-medium">Views</div>
            {vb.views.length === 0 ? (
              <p className="text-[11px] text-muted">
                No Location View yet. Generate an alternate angle, then &quot;Use as Location View&quot; on
                it.
              </p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {vb.views.map(({ view }) => (
                  <li key={view.id} className="w-28 text-[11px]" data-testid="lvb-view">
                    {url(view.assetId) ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={url(view.assetId)!} alt={view.name} className="w-full rounded" />
                    ) : null}
                    <div>{view.name}</div>
                    <div className="text-muted">{LOCATION_VIEW_KIND_LABEL[view.kind]}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="space-y-1" data-testid="lvb-designations">
            <div className="text-[12px] font-medium">Establishing views, plates and variants</div>
            <ul className="flex flex-wrap gap-2">
              {vb.entries.map((e) => (
                <li
                  key={`${e.role}-${e.assetId}`}
                  className="w-28 text-[11px]"
                  data-testid={`lvb-entry-${e.role}`}
                >
                  {url(e.assetId) ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={url(e.assetId)!} alt={e.label || e.role} className="w-full rounded" />
                  ) : null}
                  <div>
                    {LOCATION_VISUAL_ROLE_LABEL[e.role]}
                    {e.label ? ` · ${e.label}` : ""}
                  </div>
                  {!locked ? (
                    <ActionForm action={clearLocationDesignation} successMessage="Designation removed">
                      {hidden}
                      <input type="hidden" name="role" value={e.role} />
                      <input type="hidden" name="assetId" value={e.assetId} />
                      <Button type="submit" size="sm">
                        Remove
                      </Button>
                    </ActionForm>
                  ) : null}
                </li>
              ))}
            </ul>
            {!locked && sources.length > 0 ? (
              <ActionForm
                action={addLocationDesignation}
                successMessage="Added to the Visual Bible"
                className="flex flex-wrap items-end gap-2"
              >
                {hidden}
                {sourceSelect("lvb-designation-source")}
                <select name="role" aria-label="Use as" data-testid="lvb-designation-role">
                  <option value="establishing">Establishing view</option>
                  <option value="plate">Background plate</option>
                  <option value="variant">Variant</option>
                </select>
                <input
                  name="label"
                  list={`lvb-var-${locationId}`}
                  placeholder="exterior wide / night"
                  className="w-36"
                  aria-label="Label"
                  data-testid="lvb-designation-label"
                />
                <Button type="submit" size="sm" data-testid="lvb-add-designation">
                  Add to Visual Bible
                </Button>
              </ActionForm>
            ) : null}
          </div>

          {preferred ? (
            <details className="text-[11px] text-muted">
              <summary className="cursor-pointer">Advanced</summary>
              Generate presets use {preferred.label}
              {preferred.paid ? " (paid)" : " (free)"}; choose another model in the Images panel below. A Shot
              set here automatically receives its selected Location View, then the canonical appearance, then
              the establishing views, plates and the variants that match its time of day.
            </details>
          ) : null}
        </div>
      </div>
    </Panel>
  );
}
