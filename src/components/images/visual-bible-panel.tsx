import { ActionForm } from "@/components/action-form";
import { Badge, Button, Field, Panel } from "@/components/ui";
import type { ProjectData } from "@/domain/schemas";
import { SUGGESTED_EXPRESSIONS, visualBibleReadiness, visualRoleOf } from "@/domain/visual-bible";
import { assetUrl } from "@/lib/utils";
import type { EditSource, ImageModelOption } from "@/server/subject-images";
import { startSubjectImage } from "@/server/subject-image-actions";
import {
  addExpressionReference,
  clearVisualBibleDesignation,
  setCanonicalIdentity,
  setCharacterCutout,
} from "@/server/visual-bible-actions";

/**
 * Phase 5B-I4: the Character Visual Bible. Shows what the Character has and what Prism suggests next. Guidance only:
 * nothing here is a gate, nothing is generated or replaced automatically. Generate presets feed the existing I1/I2
 * image pipeline; designations point at existing images (nothing is copied).
 */
const PRESET_LABEL: Record<string, string> = {
  portrait: "Generate Portrait",
  three_quarter: "Generate 3/4 View",
  profile: "Generate Profile",
  full_body: "Generate Full Body",
  expression_variant: "Generate Expression",
  look_sheet: "Generate Look Reference",
};

export function VisualBiblePanel(props: {
  data: ProjectData;
  characterId: string;
  slug: string;
  sources: EditSource[];
  models: ImageModelOption[];
}) {
  const { data, characterId, slug } = props;
  const character = data.characters.find((c) => c.id === characterId);
  if (!character) return null;
  const vb = visualBibleReadiness(data, characterId);
  const assets = new Map(data.assets.map((a) => [a.id, a]));
  const url = (id: string | null) => (id ? (assetUrl(assets.get(id)) ?? null) : null);
  const usable = props.models.filter((m) => m.available);
  const preferred = usable.find((m) => !m.paid) ?? usable[0] ?? null;
  const looks = data.looks.filter((l) => l.characterId === characterId);
  const canonicalRef = data.identityRefs.find(
    (r) => r.characterId === characterId && visualRoleOf(r) === "canonical",
  );
  const cutoutRef = data.identityRefs.find(
    (r) => r.characterId === characterId && visualRoleOf(r) === "cutout",
  );
  const transparentSources = props.sources.filter(
    (s) => (assets.get(s.assetId)?.metadata as { hasAlpha?: unknown } | undefined)?.hasAlpha === true,
  );
  const hidden = (
    <>
      <input type="hidden" name="projectSlug" value={slug} />
      <input type="hidden" name="characterId" value={characterId} />
    </>
  );
  const subjectHidden = (
    <>
      <input type="hidden" name="projectSlug" value={slug} />
      <input type="hidden" name="subjectKind" value="character" />
      <input type="hidden" name="subjectId" value={characterId} />
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
  const generate = (intent: string, lookId?: string) =>
    preferred ? (
      <ActionForm action={startSubjectImage} successMessage="Image queued" className="inline">
        {subjectHidden}
        <input type="hidden" name="intent" value={intent} />
        <input type="hidden" name="model" value={`${preferred.provider}/${preferred.modelId}`} />
        {lookId ? <input type="hidden" name="lookId" value={lookId} /> : null}
        <Button type="submit" size="sm" data-testid={`vb-generate-${intent}`}>
          {PRESET_LABEL[intent] ?? "Generate"}
        </Button>
      </ActionForm>
    ) : null;

  return (
    <Panel
      title="Visual Bible"
      actions={
        <Badge tone={vb.done === vb.total ? "pass" : "neutral"}>
          {vb.done} / {vb.total} ready
        </Badge>
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
          <figcaption className="mt-1 text-sm font-medium">{character.name}</figcaption>
        </figure>

        <div className="space-y-3">
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
                  <span className="text-[11px] text-muted">{i.suggestion}</span>
                ) : null}
                {!i.done && i.generateIntent
                  ? generate(i.generateIntent, i.generateIntent === "look_sheet" ? looks[0]?.id : undefined)
                  : null}
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-muted">
            Guidance only: skip anything you don&apos;t need. Nothing is generated or replaced without you.
          </p>

          {props.sources.length > 0 ? (
            <ActionForm
              action={setCanonicalIdentity}
              successMessage="Canonical identity set"
              className="flex flex-wrap items-end gap-2"
            >
              {hidden}
              <Field label="Canonical identity">
                {sourceSelect("assetId", props.sources, "vb-canonical-source")}
              </Field>
              {canonicalRef ? (
                <label className="flex items-center gap-1 text-[11px]">
                  <input type="checkbox" name="confirmReplace" value="1" data-testid="vb-canonical-confirm" />
                  Replace the current canonical identity
                </label>
              ) : null}
              <Button type="submit" size="sm" data-testid="vb-use-as-canonical">
                Use as Canonical
              </Button>
            </ActionForm>
          ) : null}

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
                {generate("look_sheet", look.id)}
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
                Remove the background from an image below to make a cutout.
              </p>
            )}
          </div>

          {preferred ? (
            <details className="text-[11px] text-muted">
              <summary className="cursor-pointer">Advanced</summary>
              Generate presets use {preferred.label}
              {preferred.paid ? " (paid)" : " (free)"}; choose another model in the Images panel below.
            </details>
          ) : null}
        </div>
      </div>
    </Panel>
  );
}
