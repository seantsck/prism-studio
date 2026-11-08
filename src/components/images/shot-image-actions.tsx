import { ActionForm } from "@/components/action-form";
import { Badge, Button, Field } from "@/components/ui";
import { buildShotContext } from "@/domain/context";
import { assembleGenerationPackage, shotChangedSinceAttempt } from "@/domain/generation-package";
import { shotEditableAssetIds } from "@/domain/generation/image-edit";
import {
  fitProductionFrameToModel,
  modelsFittingEssentials,
  productionFrameInputs,
  type ProductionFrameReference,
} from "@/domain/generation/production-frame-inputs";
import { isProductionFrameAttempt } from "@/domain/generation/schemas";
import type { ProjectData } from "@/domain/schemas";
import { evaluateShotForModel } from "@/generation/submission";
import { assetUrl } from "@/lib/utils";
import {
  currentProductionFrameAttemptId,
  generatedFramePromotion,
} from "@/domain/generated-production-frame";
import { loadAttemptMedia } from "@/server/attempt-media";
import { reviewCandidate } from "@/server/candidate-actions";
import { getGenerationRepo, getRegistry } from "@/server/generation";
import { createDeliveryConform } from "@/server/media-actions";
import { chooseGeneratedFrameAsProductionFrame } from "@/server/production-frame-actions";
import { saveAsStoryboardFrame, startShotImage } from "@/server/shot-image-actions";

/**
 * Shot Prep → Production Frame: the happy path (Phase 5B-I1b, made reference-driven in 5B-I6).
 *
 *   Production Frame Inputs   what Prism assembled from the Visual Bibles and the Shot (a reading of the SAME package
 *                             every candidate freezes; nothing is attached by hand)
 *   Generate Production Frame one model's candidates through the existing candidate-set workflow (same gates, spend
 *                             confirmation, worker and Storage); the human chooses the model, it is never switched
 *   Candidates                review together: Use as Production Frame (the existing immutable promotion), Use as
 *                             Storyboard, Reject; Generate Alternatives never replaces the current Production Frame
 *
 * Model, provider, exact references, omissions, prompt and cost sit under Advanced.
 */
/** The usual reasons a still is rejected (the candidate review requires at least one). */
const REJECT_REASONS: Array<[string, string]> = [
  ["character_identity", "identity"],
  ["wardrobe", "wardrobe"],
  ["location_set", "location"],
  ["composition", "composition"],
  ["lighting", "lighting"],
  ["visual_artifacts", "artifacts"],
  ["other", "other"],
];

const TIER_LABEL: Record<ProductionFrameReference["tier"], string> = {
  essential: "essential",
  frozen: "Continuity Lock",
  optional: "optional",
  explicit: "Shot reference",
};

export async function ShotImageActions({
  data,
  shotId,
  slug,
}: {
  data: ProjectData;
  shotId: string;
  slug: string;
}) {
  const registry = getRegistry();
  const all = registry
    .models()
    .filter((m) => m.capabilities.image && m.capabilities.modalities.includes("text_to_image"));
  const models = all.map((m) => ({
    model: m,
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

  // Phase 5B-I6: the inputs, read from the same frozen package a candidate would freeze
  const ctx = buildShotContext(data, shotId);
  const pkg = assembleGenerationPackage(ctx);
  const inputs = productionFrameInputs(pkg);
  const fit = preferred ? fitProductionFrameToModel(pkg, preferred.model) : null;
  const evaluation = preferred
    ? evaluateShotForModel({
        data,
        shotId,
        registry,
        provider: preferred.model.provider,
        modelId: preferred.model.modelId,
        purpose: "production_frame",
      })
    : null;
  const perCandidateUsd = evaluation?.estimate?.amount ?? null;
  const fitting = fit?.refusal
    ? modelsFittingEssentials(
        pkg,
        models.filter((m) => m.available).map((m) => m.model),
      )
    : [];
  const currentPfAssetId = ctx.selectedProductionFrame?.assetId ?? null;
  // the current Production Frame's SOURCE attempt (its image may be that attempt's conform, not the original)
  const currentAttemptId = currentProductionFrameAttemptId(ctx);

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
    .slice(0, 8);
  // Phase 5B-I6: each candidate's promotion status, exactly as the candidate page computes it (a 2.39:1 Shot needs its
  // production conform first: offered here, never a silent crop)
  const generation = await getGenerationRepo();
  const promotionOf = new Map(
    await Promise.all(
      recent.map(async (a) => {
        const view = await generation.getAttemptView(a.id);
        const original = a.outputAssetId ? (assets.get(a.outputAssetId) ?? null) : null;
        if (!view) return [a.id, null] as const;
        const media = await loadAttemptMedia(data, view);
        return [
          a.id,
          generatedFramePromotion(ctx, {
            attempt: view.attempt,
            original,
            delivery: media.delivery?.asset ?? null,
          }),
        ] as const;
      }),
    ),
  );
  const hidden = (
    <>
      <input type="hidden" name="projectSlug" value={slug} />
      <input type="hidden" name="shotId" value={shotId} />
    </>
  );
  const tick = (key: keyof typeof inputs.ready, label: string) => (
    <span data-testid={`pf-ready-${key}`} data-done={inputs.ready[key]} className="mr-3">
      {label} {inputs.ready[key] ? "✓" : "○"}
    </span>
  );
  const block = (title: string, lines: string[], testId: string) =>
    lines.length ? (
      <div data-testid={testId}>
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted">{title}</div>
        <ul className="text-[12.5px]">
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </div>
    ) : null;

  return (
    <div className="mb-3 space-y-2 border border-line p-2.5" data-testid="shot-image-actions">
      <section className="space-y-2" data-testid="pf-inputs">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-[13px] font-medium">Production Frame Inputs</h3>
          <div className="text-[11.5px]" data-testid="pf-ready">
            {tick("characters", "Characters")}
            {tick("location", "Location")}
            {tick("direction", "Direction")}
            {tick("story", "Story")}
          </div>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {block(
            "Characters",
            inputs.characters.flatMap((c) => c.lines),
            "pf-inputs-characters",
          )}
          {block("Location", inputs.location, "pf-inputs-location")}
          {block("Direction", inputs.direction, "pf-inputs-direction")}
          {block("Story", inputs.story, "pf-inputs-story")}
        </div>
        <p className="text-[11px] text-muted">
          Prism sends these automatically from the Character and Location Visual Bibles. Nothing needs
          attaching.
        </p>
        {fit?.refusal ? (
          <p className="text-[12px] text-warn" data-testid="pf-inputs-refusal">
            {fit.refusal}
            {fitting.length ? (
              <span className="block text-[11px] text-muted" data-testid="pf-inputs-recommend">
                Models that fit every essential reference: {fitting.map((m) => m.displayName).join(", ")}. You
                choose the model under Advanced.
              </span>
            ) : null}
          </p>
        ) : null}
        {fit && !fit.refusal && fit.omitted.length ? (
          <p className="text-[11.5px] text-muted" data-testid="pf-inputs-omitted">
            {fit.label} takes {fit.maxReferences} references. Not sent:{" "}
            {fit.omitted.map((r) => r.label).join("; ")}.
          </p>
        ) : null}
      </section>

      {preferred ? (
        <ActionForm
          action={startShotImage}
          successMessage="Production Frame candidates queued"
          className="space-y-2"
        >
          {hidden}
          <div className="flex flex-wrap items-end gap-1.5">
            <Button
              type="submit"
              name="kind"
              value="production_frame"
              variant="primary"
              size="sm"
              data-testid="shot-generate-image"
            >
              Generate Production Frame
            </Button>
            <Button
              type="submit"
              name="kind"
              value="alternate_composition"
              size="sm"
              data-testid="shot-alternate-composition"
            >
              {currentPfAssetId || recent.length ? "Generate Alternatives" : "Alternate Composition"}
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
            <label className="flex items-center gap-1 text-[11px]">
              Candidates
              <select name="count" defaultValue="1" data-testid="pf-candidate-count">
                {[1, 2, 3, 4].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            {anyTransparency ? <TransparentToggle testId="shot-image-transparent" /> : null}
          </div>
          <Field
            label="Additional direction (optional)"
            hint="A small creative override, e.g. 'tighter, from a lower angle'. Identity, wardrobe, Location and continuity never change."
          >
            <input name="direction" maxLength={500} data-testid="pf-direction" />
          </Field>
          <details data-testid="pf-inputs-advanced">
            <summary className="cursor-pointer text-[11px] text-muted">Advanced</summary>
            <div className="mt-2 space-y-2">
              <div className="grid gap-2 sm:grid-cols-2">
                <Field
                  label="Model"
                  hint="Prism suggests a free model first; you choose. It is never switched."
                >
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
                <Field
                  label="Confirm total (USD)"
                  hint="Required only for a paid model: per candidate × candidates."
                >
                  <input name="confirmedTotalUsd" inputMode="decimal" />
                </Field>
              </div>
              <p className="text-[11px] text-muted" data-testid="pf-inputs-cost">
                {preferred.label} ({preferred.model.provider}):{" "}
                {perCandidateUsd == null
                  ? "estimate unavailable"
                  : perCandidateUsd === 0
                    ? "free"
                    : `about $${perCandidateUsd.toFixed(2)} per candidate`}
                . The total is per candidate × candidates; paid models need the confirmed total.
              </p>
              <ol className="space-y-0.5 text-[11.5px]" data-testid="pf-inputs-references">
                {inputs.references.map((r) => {
                  const omitted = fit?.omitted.some((o) => o.assetId === r.assetId);
                  return (
                    <li
                      key={r.assetId}
                      data-testid="pf-inputs-ref"
                      data-tier={r.tier}
                      data-omitted={!!omitted}
                    >
                      {r.label}{" "}
                      <Badge tone={r.tier === "essential" ? "pass" : "neutral"}>{TIER_LABEL[r.tier]}</Badge>
                      {omitted ? <span className="text-muted"> — not sent to {fit?.label}</span> : null}
                    </li>
                  );
                })}
              </ol>
              {fit ? (
                <pre
                  className="max-h-48 overflow-auto whitespace-pre-wrap border border-line p-2 text-[11px]"
                  data-testid="pf-inputs-prompt"
                >
                  {fit.prompt}
                </pre>
              ) : null}
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
        <div className="space-y-1">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted">Candidates</div>
          <ul className="grid gap-2 sm:grid-cols-3" data-testid="shot-generated-stills">
            {recent.map((a) => {
              const asset = a.outputAssetId ? assets.get(a.outputAssetId) : undefined;
              const isCurrent = currentAttemptId === a.id;
              const stale = shotChangedSinceAttempt(a, pkg)?.changed === true;
              const rejected = a.reviewStatus === "rejected";
              const direction = (a.modelSettings as { creatorDirection?: { kind: string; text: string } })
                .creatorDirection;
              return (
                <li
                  key={a.id}
                  className="border border-line p-1.5"
                  data-testid="shot-generated-still"
                  data-attempt={a.id}
                  data-current={isCurrent}
                >
                  {asset ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={assetUrl(asset) ?? undefined} alt="" className="w-full" />
                  ) : null}
                  <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-muted">
                    #{a.attemptNumber} · {a.model}
                    {isCurrent ? (
                      <span data-testid="shot-still-current">
                        <Badge tone="pass">Production Frame</Badge>
                      </span>
                    ) : null}
                    {stale ? (
                      <span data-testid="shot-still-stale">
                        <Badge tone="warn">inputs changed</Badge>
                      </span>
                    ) : null}
                    {rejected ? <Badge tone="neutral">rejected</Badge> : null}
                  </div>
                  {direction ? (
                    <div className="text-[11px] text-muted" data-testid="shot-still-direction">
                      {direction.kind === "alternate_composition" ? "Alternate composition" : "Direction"}
                      {direction.text ? `: ${direction.text}` : ""}
                    </div>
                  ) : null}
                  {(a.modelSettings as { editSourceAssetId?: string }).editSourceAssetId ? (
                    <div className="text-[11px] text-muted" data-testid="shot-image-lineage">
                      Source:{" "}
                      {labelOf.get((a.modelSettings as { editSourceAssetId: string }).editSourceAssetId) ??
                        "an earlier image"}{" "}
                      → edit attempt #{a.attemptNumber} → this new image
                    </div>
                  ) : null}
                  <div className="mt-1 flex flex-wrap gap-1">
                    {!isCurrent && promotionOf.get(a.id)?.available === false
                      ? (() => {
                          const p = promotionOf.get(a.id) as { code: string; reason: string };
                          return p.code === "needs_conform" ? (
                            <ActionForm
                              action={createDeliveryConform}
                              quiet={false}
                              successMessage="Production conform created"
                            >
                              <input type="hidden" name="projectSlug" value={slug} />
                              <input type="hidden" name="attemptId" value={a.id} />
                              <Button type="submit" size="sm" data-testid="shot-create-conform">
                                Create production conform
                              </Button>
                            </ActionForm>
                          ) : (
                            <span className="text-[11px] text-muted" data-testid="shot-still-unavailable">
                              {p.reason}
                            </span>
                          );
                        })()
                      : null}
                    {isCurrent || promotionOf.get(a.id)?.available === false ? null : (
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
                    )}
                    <ActionForm action={saveAsStoryboardFrame} successMessage="Added as a Storyboard frame">
                      {hidden}
                      <input type="hidden" name="attemptId" value={a.id} />
                      <Button type="submit" size="sm" data-testid="shot-use-as-storyboard">
                        Use as Storyboard Frame
                      </Button>
                    </ActionForm>
                    {isCurrent || rejected ? null : (
                      <details data-testid="shot-still-reject">
                        <summary className="cursor-pointer text-[11px]">Reject</summary>
                        <ActionForm
                          action={reviewCandidate}
                          successMessage="Candidate rejected"
                          className="mt-1 space-y-1"
                        >
                          <input type="hidden" name="projectSlug" value={slug} />
                          <input type="hidden" name="attemptId" value={a.id} />
                          <input type="hidden" name="decision" value="reject" />
                          <div className="flex flex-wrap gap-1.5 text-[11px]">
                            {REJECT_REASONS.map(([tag, label]) => (
                              <label key={tag} className="flex items-center gap-0.5">
                                <input type="checkbox" name="negative" value={tag} />
                                {label}
                              </label>
                            ))}
                          </div>
                          <Button type="submit" size="sm" data-testid="shot-still-reject-submit">
                            Reject candidate
                          </Button>
                        </ActionForm>
                      </details>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
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
