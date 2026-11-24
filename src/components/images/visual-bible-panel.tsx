import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Panel } from "@/components/ui";
import { referenceOrigin, referenceOriginLabel } from "@/domain/generation/reference-integrity";
import type { ProjectData } from "@/domain/schemas";
import { SUGGESTED_EXPRESSIONS, visualBibleReadiness, visualRoleOf } from "@/domain/visual-bible";
import { assetUrl } from "@/lib/utils";
import { ZoomImage } from "@/components/zoom-image";
import { ViewLock } from "@/components/characters/picture-actions";
import type { EditSource, ImageModelOption } from "@/server/subject-images";
import {
  addViewsToReferenceSet,
  addExpressionReference,
  clearVisualBibleDesignation,
  setCharacterCutout,
} from "@/server/visual-bible-actions";

/**
 * Phase 5B-I4: the Character Visual Bible. Shows what the Character has and what Prism suggests next. Guidance only:
 * nothing here is a gate, nothing is generated or replaced automatically. Nothing is made here at all: the reference
 * views are made and added in "4. Six views" on the Character's page (shown here as the Reference set), Look sheets and
 * expressions in the Reference Studio. Designations point at existing images (nothing is copied).
 */
export function VisualBiblePanel(props: {
  data: ProjectData;
  characterId: string;
  slug: string;
  sources: EditSource[];
  models: ImageModelOption[];
  /** the six views of the reference set: what is in it, and what was made and waits to be added (step 4) */
  views?: Array<{
    id: string;
    label: string;
    state: "in_set" | "making" | "made" | "missing";
    url: string | null;
    /** a made view: the take to add */
    attemptId?: string | null;
    /** its picture */
    assetId?: string | null;
    /** its picture is locked in place */
    locked?: boolean;
  }>;
}) {
  const { data, characterId, slug } = props;
  const character = data.characters.find((c) => c.id === characterId);
  if (!character) return null;
  const vb = visualBibleReadiness(data, characterId);
  const assets = new Map(data.assets.map((a) => [a.id, a]));
  const url = (id: string | null) => (id ? (assetUrl(assets.get(id)) ?? null) : null);
  const looks = data.looks.filter((l) => l.characterId === characterId);
  const cutoutRef = data.identityRefs.find(
    (r) => r.characterId === characterId && visualRoleOf(r) === "cutout",
  );
  const canonicalOrigin = referenceOrigin(vb.canonicalAssetId ? assets.get(vb.canonicalAssetId) : null);
  const transparentSources = props.sources.filter(
    (s) => (assets.get(s.assetId)?.metadata as { hasAlpha?: unknown } | undefined)?.hasAlpha === true,
  );
  const hidden = (
    <>
      <input type="hidden" name="projectSlug" value={slug} />
      <input type="hidden" name="characterId" value={characterId} />
    </>
  );
  const sourceSelect = (name: string, list: EditSource[], testId: string) => (
    <select name={name} data-testid={testId} aria-label="Image">
      {list.map((s) => (
        <option key={s.assetId} value={s.assetId}>
          {s.label}
        </option>
      ))}
    </select>
  );
  const studio = `/projects/${slug}/studio?subject=character:${characterId}`;
  // the view a readiness item is filled by, and that view's state on this page
  const ITEM_VIEW: Record<string, string> = {
    canonical: "front",
    front: "front",
    three_quarter: "three_quarter",
    profile: "profile",
    full_body: "full_body",
  };
  const viewStateOf = (key: string) => props.views?.find((v) => v.id === ITEM_VIEW[key])?.state ?? null;
  const madeViews = (props.views ?? []).filter((v) => v.state === "made" && v.attemptId);
  // Nothing is generated here: the reference views are made in "4. Six views" on this page, Look sheets and
  // expressions in the Reference Studio.

  return (
    <Panel
      title="Visual Bible"
      actions={
        <span className="flex items-center gap-2">
          <Link
            href={studio}
            className="text-[11.5px] text-accent hover:underline"
            data-testid="vb-open-studio"
          >
            Open in Reference Studio
          </Link>
          <Badge tone={vb.done === vb.total ? "pass" : "neutral"}>
            {vb.done} / {vb.total} ready
          </Badge>
        </span>
      }
    >
      <div className="grid gap-4 p-3 md:grid-cols-[220px_1fr]" data-testid="visual-bible">
        <figure>
          {url(vb.canonicalAssetId) ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={url(vb.canonicalAssetId)!}
              alt={`${character.name} canonical identity`}
              className="w-full rounded"
              data-testid="vb-canonical-image"
            />
          ) : (
            <div className="flex aspect-[3/4] items-center justify-center rounded border border-dashed border-line text-xs text-muted">
              No canonical identity yet
            </div>
          )}
          <figcaption className="mt-1 text-sm font-medium">
            {character.name}
            {canonicalOrigin ? (
              // a generated reference is never presented as a photograph of the Character
              <span
                className="ml-2 text-[11px] font-normal text-muted"
                data-testid="vb-canonical-origin"
                data-origin={canonicalOrigin}
              >
                {referenceOriginLabel(vb.canonicalAssetId ? assets.get(vb.canonicalAssetId) : null)}
              </span>
            ) : null}
          </figcaption>
        </figure>

        <div className="space-y-3">
          {props.views?.length ? (
            <div data-testid="vb-views">
              <div className="mb-1 flex items-baseline justify-between text-[12px]">
                <span className="font-medium">Reference set</span>
              </div>
              {madeViews.length ? (
                <ActionForm
                  action={addViewsToReferenceSet}
                  successMessage=""
                  className="mb-2 flex flex-wrap items-center gap-2"
                  data-testid="vb-add-made"
                >
                  {hidden}
                  {madeViews.map((v) => (
                    <input key={v.id} type="hidden" name="viewTake" value={`${v.id}:${v.attemptId}`} />
                  ))}
                  <Button type="submit" size="sm" variant="primary" data-testid="vb-add-made-button">
                    {madeViews.length === 1
                      ? `Add the ${madeViews[0]!.label.toLowerCase()} to the set`
                      : `Add the ${madeViews.length} made views to the set`}
                  </Button>
                  <span className="text-[11px] text-muted">
                    Made in 4. Six views and not added yet: adding them fills in the references below.
                  </span>
                </ActionForm>
              ) : null}
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                {props.views.map((v) => (
                  <figure
                    key={v.id}
                    className="text-[10.5px]"
                    data-testid="vb-view"
                    data-view={v.id}
                    data-state={v.state}
                  >
                    {v.url ? (
                      <ZoomImage
                        src={v.url}
                        alt={`${character.name}: ${v.label}`}
                        wrapperClassName="block h-32 w-full"
                        className={
                          v.state === "in_set"
                            ? "h-full w-full rounded border border-pass/50 bg-[#1b1b1e] object-contain"
                            : "h-full w-full rounded border border-dashed border-line bg-[#1b1b1e] object-contain opacity-70"
                        }
                        caption={`${character.name} · ${v.label}${v.state === "in_set" ? (v.locked ? " · locked in the set" : " · in the set") : " · made, not added yet"}`}
                      >
                        {v.state === "in_set" ? (
                          <ViewLock slug={slug} characterId={characterId} view={v.id} locked={!!v.locked} />
                        ) : null}
                      </ZoomImage>
                    ) : (
                      <div className="flex h-32 w-full items-center justify-center rounded border border-dashed border-line text-faint">
                        {v.state === "making" ? "being made…" : "none yet"}
                      </div>
                    )}
                    <figcaption className="mt-0.5 leading-tight">
                      <span className={v.state === "in_set" ? "text-pass" : ""}>
                        {v.state === "in_set" ? "✓ " : ""}
                        {v.label}
                      </span>
                      {v.state === "made" ? <div className="text-muted">made, not added yet</div> : null}
                    </figcaption>
                    {v.id === "front" && v.state === "in_set" ? (
                      <div className="text-[10.5px] text-pass" data-testid="canonical-mark">
                        canonical identity
                      </div>
                    ) : null}
                    {v.state === "in_set" ? (
                      <div className="mt-1">
                        <ViewLock slug={slug} characterId={characterId} view={v.id} locked={!!v.locked} />
                      </div>
                    ) : null}
                  </figure>
                ))}
              </div>
            </div>
          ) : null}
          <ul className="space-y-1 text-[13px]" data-testid="vb-readiness">
            {vb.items.map((i) => (
              <li
                key={i.key}
                className="flex flex-wrap items-center gap-2"
                data-testid={`vb-item-${i.key}`}
                data-done={i.done}
              >
                <span aria-hidden>{i.done ? "✓" : "○"}</span>
                <span>{i.label}</span>
                {!i.done && i.suggestion ? (
                  <span className="text-[11px] text-muted">
                    {viewStateOf(i.key) === "made"
                      ? "Made, not added to the set yet."
                      : viewStateOf(i.key) === "making"
                        ? "Being made in 4. Six views."
                        : i.suggestion}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-muted">
            The views you add to the set in 4. Six views fill in the references here; the front view is always
            the canonical identity (the picture that defines the face in every shot). Guidance only: skip
            anything you don&apos;t need. Nothing is made here, and nothing is replaced without you.
          </p>

          <div className="space-y-1" data-testid="vb-looks">
            <div className="text-[12px] font-medium">Looks</div>
            {looks.length === 0 ? <p className="text-[11px] text-muted">No Look yet.</p> : null}
            {vb.looks.map(({ look, storedReferences, suggestion }) => (
              <div
                key={look.id}
                className="flex flex-wrap items-center gap-2 text-[12px]"
                data-testid="vb-look"
              >
                <span>{look.name}</span>
                <Badge tone={storedReferences > 0 ? "pass" : "neutral"}>{storedReferences} ref</Badge>
                {suggestion ? <span className="text-[11px] text-muted">{suggestion}</span> : null}
              </div>
            ))}
          </div>

          <div className="space-y-1" data-testid="vb-expressions">
            <div className="text-[12px] font-medium">Expressions</div>
            <div className="flex flex-wrap gap-2">
              {vb.expressions.map((e) => (
                <figure key={e.refId} className="w-20 text-[10px]" data-testid="vb-expression">
                  {url(e.assetId) ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={url(e.assetId)!} alt={e.expression} className="w-full rounded" />
                  ) : null}
                  <figcaption>{e.expression}</figcaption>
                  <ActionForm action={clearVisualBibleDesignation} successMessage="Removed">
                    {hidden}
                    <input type="hidden" name="refId" value={e.refId} />
                    <Button type="submit" size="sm">
                      Remove
                    </Button>
                  </ActionForm>
                </figure>
              ))}
            </div>
            {props.sources.length > 0 ? (
              <ActionForm
                action={addExpressionReference}
                successMessage="Expression added"
                className="flex flex-wrap items-end gap-2"
              >
                {hidden}
                {sourceSelect("assetId", props.sources, "vb-expression-source")}
                <input
                  name="expression"
                  list={`vb-expr-${characterId}`}
                  placeholder="happy"
                  className="w-28"
                  data-testid="vb-expression-name"
                />
                <datalist id={`vb-expr-${characterId}`}>
                  {SUGGESTED_EXPRESSIONS.map((x) => (
                    <option key={x} value={x} />
                  ))}
                </datalist>
                <Button type="submit" size="sm" data-testid="vb-add-expression">
                  Add Expression
                </Button>
              </ActionForm>
            ) : null}
          </div>

          <div className="space-y-1" data-testid="vb-cutout">
            <div className="text-[12px] font-medium">Cutout</div>
            {cutoutRef && url(cutoutRef.assetId) ? (
              <div className="flex items-center gap-2">
                <div className="w-20 rounded bg-[length:12px_12px] bg-[conic-gradient(#ddd_25%,#fff_0_50%,#ddd_0_75%,#fff_0)]">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={url(cutoutRef.assetId)!}
                    alt={`${character.name} cutout`}
                    className="w-full"
                    data-testid="vb-cutout-image"
                  />
                </div>
                <ActionForm action={clearVisualBibleDesignation} successMessage="Cutout designation removed">
                  {hidden}
                  <input type="hidden" name="refId" value={cutoutRef.id} />
                  <Button type="submit" size="sm" data-testid="vb-clear-cutout">
                    Remove designation
                  </Button>
                </ActionForm>
              </div>
            ) : null}
            {transparentSources.length > 0 ? (
              <ActionForm
                action={setCharacterCutout}
                successMessage="Cutout set"
                className="flex flex-wrap items-end gap-2"
              >
                {hidden}
                {sourceSelect("assetId", transparentSources, "vb-cutout-source")}
                {cutoutRef ? (
                  <label className="flex items-center gap-1 text-[11px]">
                    <input type="checkbox" name="confirmReplace" value="1" />
                    Replace
                  </label>
                ) : null}
                <Button type="submit" size="sm" data-testid="vb-use-as-cutout">
                  Use as Cutout
                </Button>
              </ActionForm>
            ) : (
              <p className="text-[11px] text-muted">
                Make a cutout in the Reference Studio (Cut out the person), then choose it here.
              </p>
            )}
          </div>
        </div>
      </div>
    </Panel>
  );
}
