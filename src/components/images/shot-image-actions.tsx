import { ActionForm } from "@/components/action-form";
import { Button, Field } from "@/components/ui";
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
    }));
  const preferred = models.find((m) => m.available && !m.paid) ?? models.find((m) => m.available) ?? null;
  const assets = new Map(data.assets.map((a) => [a.id, a]));
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
      ) : (
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
