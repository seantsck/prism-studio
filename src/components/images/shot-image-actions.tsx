import { ActionForm } from "@/components/action-form";
import { Button, Field } from "@/components/ui";
import { shotEditableAssetIds } from "@/domain/generation/image-edit";
import { isProductionFrameAttempt } from "@/domain/generation/schemas";
import type { ProjectData } from "@/domain/schemas";
import { assetUrl } from "@/lib/utils";
import { getRegistry } from "@/server/generation";
import { chooseGeneratedFrameAsProductionFrame } from "@/server/production-frame-actions";
import { saveAsStoryboardFrame, startShotImage } from "@/server/shot-image-actions";

/**
 * Phase 5B-I1b: the Shot's simple image actions (Shot Prep → Production Frame). One click makes a still through the
 * existing Production Frame candidate workflow; the model lives under Advanced; the human chooses it. Recent generated
 * stills of this Shot can be used as the Production Frame (the existing promotion) or as a new Storyboard frame.
 */
export function ShotImageActions({
  data,
  shotId,
  slug,
}: {
  data: ProjectData;
  shotId: string;
  slug: string;
}) {
  const registry = getRegistry();
  const models = registry
    .models()
    .filter((m) => m.capabilities.image && m.capabilities.modalities.includes("text_to_image"))
    .map((m) => ({
      value: `${m.provider}/${m.modelId}`,
      label: m.displayName,
      available: registry.availabilityOf(m).available,
      paid: registry.billsMoney(m),
      transparency: m.capabilities.image?.transparency === true,
      editing: m.capabilities.modalities.includes("image_to_image") && m.capabilities.image?.editing === true,
    }));
  const editors = models.filter((m) => m.available && m.editing);
  const preferredEditor = editors.find((m) => !m.paid) ?? editors[0] ?? null;
  const anyTransparency = models.some((m) => m.available && m.transparency);
  const preferred = models.find((m) => m.available && !m.paid) ?? models.find((m) => m.available) ?? null;
  const assets = new Map(data.assets.map((a) => [a.id, a]));
  // Phase 5B-I2: Edit Image starts from one of THIS Shot's stills (the server checks the same set)
  const editable = [...shotEditableAssetIds(data, shotId)].map((id) => {
    const fromAttempt = data.attempts.find((a) => a.shotId === shotId && a.outputAssetId === id);
    const frame = data.frames.find((f) => f.shotId === shotId && f.assetId === id);
    const pf = (data.productionFrames ?? []).find((f) => f.shotId === shotId && f.assetId === id);
    const label = pf
      ? `Production Frame v${pf.version}`
      : frame
        ? `Storyboard v${frame.version}`
        : fromAttempt
          ? `Generated #${fromAttempt.attemptNumber} (${fromAttempt.model})`
          : (assets.get(id)?.name ?? "image");
    return { id, label };
  });
  const labelOf = new Map(editable.map((e) => [e.id, e.label]));
  const recent = data.attempts
    .filter(
      (a) =>
        a.shotId === shotId && isProductionFrameAttempt(a) && a.status === "succeeded" && a.outputAssetId,
    )
    .sort((a, b) => b.attemptNumber - a.attemptNumber)
    .slice(0, 6);
  const hidden = (
    <>
      <input type="hidden" name="projectSlug" value={slug} />
      <input type="hidden" name="shotId" value={shotId} />
    </>
  );
  return (
    <div className="mb-3 space-y-2 border border-line p-2.5" data-testid="shot-image-actions">
      {preferred ? (
        <ActionForm action={startShotImage} successMessage="Image queued" className="space-y-2">
          {hidden}
          <div className="flex flex-wrap gap-1.5">
            <Button
              type="submit"
              name="kind"
              value="production_frame"
              variant="primary"
              size="sm"
              data-testid="shot-generate-image"
            >
              Generate Image
            </Button>
            <Button
              type="submit"
              name="kind"
              value="alternate_composition"
              size="sm"
              data-testid="shot-alternate-composition"
            >
              Alternate Composition
            </Button>
            <Button
              type="submit"
              name="kind"
              value="storyboard"
              size="sm"
              data-testid="shot-generate-storyboard"
            >
              Generate Storyboard
            </Button>
            {anyTransparency ? <TransparentToggle testId="shot-image-transparent" /> : null}
          </div>
          <details>
            <summary className="cursor-pointer text-[11px] text-muted">Advanced</summary>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <Field label="Model" hint="Prism suggests a free model first; you choose.">
                <select name="model" defaultValue={preferred.value} data-testid="shot-image-model">
                  {models.map((m) => (
                    <option key={m.value} value={m.value} disabled={!m.available}>
                      {m.label}
                      {m.paid ? " (paid)" : ""}
                      {m.available ? "" : " — unavailable"}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Confirm total (USD)" hint="Required only for a paid model.">
                <input name="confirmedTotalUsd" inputMode="decimal" />
              </Field>
            </div>
          </details>
        </ActionForm>
      ) : null}
      {preferredEditor && editable.length > 0 ? (
        <details className="border border-line p-2" data-testid="shot-image-edit">
          <summary className="cursor-pointer text-[12px]">Edit Image</summary>
          <ActionForm action={startShotImage} successMessage="Edit queued" className="mt-2 space-y-2">
            {hidden}
            <input type="hidden" name="kind" value="edit" />
            <p className="text-[11px] text-muted">
              The edit is a new Production Frame candidate. The source image is never changed.
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              <Field label="Source image">
                <select name="sourceAssetId" data-testid="shot-image-edit-source">
                  {editable.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Model" hint="Only models that can edit an image.">
                <select name="model" defaultValue={preferredEditor.value} data-testid="shot-image-edit-model">
                  {editors.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                      {m.paid ? " (paid)" : ""}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="Edit instruction">
              <textarea name="instruction" rows={2} required data-testid="shot-image-edit-instruction" />
            </Field>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" size="sm" variant="primary" data-testid="shot-image-edit-submit">
                Edit Image
              </Button>
              {editors.some((m) => m.transparency) ? (
                <TransparentToggle testId="shot-image-edit-transparent" />
              ) : null}
            </div>
            <details>
              <summary className="cursor-pointer text-[11px] text-muted">Advanced</summary>
              <Field label="Confirm total (USD)" hint="Required only for a paid model.">
                <input name="confirmedTotalUsd" inputMode="decimal" />
              </Field>
            </details>
          </ActionForm>
        </details>
      ) : null}
      {preferred ? null : (
        <p className="text-[12px] text-muted" data-testid="shot-image-unavailable">
          No image model is available on this server.
        </p>
      )}
      {recent.length ? (
        <ul className="grid gap-2 sm:grid-cols-3" data-testid="shot-generated-stills">
          {recent.map((a) => {
            const asset = a.outputAssetId ? assets.get(a.outputAssetId) : undefined;
            return (
              <li key={a.id} className="border border-line p-1.5" data-testid="shot-generated-still">
                {asset ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={assetUrl(asset) ?? undefined} alt="" className="w-full" />
                ) : null}
                <div className="mt-1 text-[11px] text-muted">
                  #{a.attemptNumber} · {a.model}
                </div>
                {(a.modelSettings as { editSourceAssetId?: string }).editSourceAssetId ? (
                  <div className="text-[11px] text-muted" data-testid="shot-image-lineage">
                    Source:{" "}
                    {labelOf.get((a.modelSettings as { editSourceAssetId: string }).editSourceAssetId) ??
                      "an earlier image"}{" "}
                    → edit attempt #{a.attemptNumber} → this new image
                  </div>
                ) : null}
                <div className="mt-1 flex flex-wrap gap-1">
                  <ActionForm
                    action={chooseGeneratedFrameAsProductionFrame}
                    successMessage="Production Frame set"
                  >
                    {hidden}
                    <input type="hidden" name="attemptId" value={a.id} />
                    <Button type="submit" size="sm" data-testid="shot-use-as-production-frame">
                      Use as Production Frame
                    </Button>
                  </ActionForm>
                  <ActionForm action={saveAsStoryboardFrame} successMessage="Added as a Storyboard frame">
                    {hidden}
                    <input type="hidden" name="attemptId" value={a.id} />
                    <Button type="submit" size="sm" data-testid="shot-use-as-storyboard">
                      Use as Storyboard Frame
                    </Button>
                  </ActionForm>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

function TransparentToggle({ testId }: { testId: string }) {
  return (
    <label className="flex items-center gap-1 text-[11px]">
      <input type="checkbox" name="transparent" value="1" data-testid={testId} />
      Transparent background
    </label>
  );
}
