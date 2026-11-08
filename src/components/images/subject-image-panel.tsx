import { ActionForm } from "@/components/action-form";
import { Badge, Button, Field, Panel } from "@/components/ui";
import type { SubjectAttemptView } from "@/data/generation-repository";
import {
  CHARACTER_IMAGE_INTENTS,
  LOCATION_IMAGE_INTENTS,
  SUBJECT_IMAGE_INTENT_LABEL,
} from "@/domain/generation/subject-image";
import { IDENTITY_SLOTS } from "@/domain/schemas";
import { assetUrl } from "@/lib/utils";
import type { EditSource, ImageModelOption } from "@/server/subject-images";
import {
  startSubjectImage,
  saveAsCharacterReference,
  saveAsLocationReference,
  saveAsLocationView,
  saveAsLookReference,
} from "@/server/subject-image-actions";
import { RefreshWhileActive } from "./refresh-while-active";

const ACTIVE = new Set(["queued", "running"]);

/**
 * Phase 5B-I1: "Generate Image" for a Character or a Location. The normal path is one button; the model, aspect and
 * direction live under Advanced. Results are immutable: "Use as …" only points a reference at a generated image.
 */
export function SubjectImagePanel(props: {
  projectSlug: string;
  subject:
    | { kind: "character"; id: string; looks: Array<{ id: string; name: string }> }
    | { kind: "location"; id: string };
  attempts: SubjectAttemptView[];
  models: ImageModelOption[];
  /** Phase 5B-I2: images of this subject that Edit Image may start from (its references and generated images). */
  sources?: EditSource[];
}) {
  const { subject } = props;
  const intents = subject.kind === "character" ? CHARACTER_IMAGE_INTENTS : LOCATION_IMAGE_INTENTS;
  const usable = props.models.filter((m) => m.available);
  const preferred = usable.find((m) => !m.paid) ?? usable[0] ?? null;
  const active = props.attempts.some((a) => ACTIVE.has(a.attempt.status));
  const sources = props.sources ?? [];
  const editors = usable.filter((m) => m.editing);
  const preferredEditor = editors.find((m) => !m.paid) ?? editors[0] ?? null;
  const anyTransparency = usable.some((m) => m.transparency);
  const sourceLabel = new Map(sources.map((s) => [s.assetId, s.label]));
  const qualities = [...new Set(usable.flatMap((m) => m.qualities))];
  const hidden = (
    <>
      <input type="hidden" name="projectSlug" value={props.projectSlug} />
      <input type="hidden" name="subjectKind" value={subject.kind} />
      <input type="hidden" name="subjectId" value={subject.id} />
    </>
  );
  return (
    <Panel title="Images" actions={active ? <Badge tone="warn">Generating…</Badge> : undefined}>
      <div className="space-y-3 p-3" data-testid="subject-images" data-active={active ? "true" : "false"}>
        <RefreshWhileActive active={active} />
        {preferred ? (
          <ActionForm action={startSubjectImage} successMessage="Image queued" className="space-y-2">
            {hidden}
            <div className="flex flex-wrap items-end gap-2">
              <Field label="What to make">
                <select name="intent" data-testid="subject-image-intent" defaultValue={intents[0]}>
                  {intents.map((i) => (
                    <option key={i} value={i}>
                      {SUBJECT_IMAGE_INTENT_LABEL[i]}
                    </option>
                  ))}
                </select>
              </Field>
              {subject.kind === "character" && subject.looks.length > 0 ? (
                <Field label="Look">
                  <select name="lookId" defaultValue="">
                    <option value="">No Look</option>
                    {subject.looks.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                </Field>
              ) : null}
              <Button type="submit" variant="primary" data-testid="subject-image-generate">
                Generate Image
              </Button>
              {anyTransparency ? <TransparentToggle testId="subject-image-transparent" /> : null}
            </div>
            <details>
              <summary className="cursor-pointer text-xs text-muted">Advanced</summary>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <Field label="Model" hint="Prism suggests a free model first; you choose.">
                  <select
                    name="model"
                    data-testid="subject-image-model"
                    defaultValue={`${preferred.provider}/${preferred.modelId}`}
                  >
                    {props.models.map((m) => (
                      <option
                        key={`${m.provider}/${m.modelId}`}
                        value={`${m.provider}/${m.modelId}`}
                        disabled={!m.available}
                      >
                        {m.label}
                        {m.paid ? " (paid)" : ""}
                        {m.available ? "" : " — unavailable"}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Aspect ratio" hint="Blank uses the model's first option.">
                  <input name="aspectRatio" placeholder={preferred.aspectRatios[0] ?? ""} />
                </Field>
                <Field label="Direction" hint="Added to what Prism already knows from the Bible.">
                  <textarea name="direction" rows={2} />
                </Field>
                {qualities.length > 0 ? <QualityField qualities={qualities} /> : null}
              </div>
            </details>
          </ActionForm>
        ) : (
          <p className="text-sm text-muted" data-testid="subject-image-unavailable">
            No image model is available on this server.
          </p>
        )}

        {preferredEditor && sources.length > 0 ? (
          <details className="rounded border border-line p-2" data-testid="subject-image-edit">
            <summary className="cursor-pointer text-sm">Edit Image</summary>
            <ActionForm action={startSubjectImage} successMessage="Edit queued" className="mt-2 space-y-2">
              {hidden}
              <input type="hidden" name="intent" value={intents[0]} />
              <p className="text-[11px] text-muted">
                The edit makes a NEW image. The source image is never changed.
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                <Field label="Source image">
                  <select name="sourceAssetId" data-testid="subject-image-edit-source">
                    {sources.map((s) => (
                      <option key={s.assetId} value={s.assetId}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Model" hint="Only models that can edit an image.">
                  <select
                    name="model"
                    data-testid="subject-image-edit-model"
                    defaultValue={`${preferredEditor.provider}/${preferredEditor.modelId}`}
                  >
                    {editors.map((m) => (
                      <option key={`${m.provider}/${m.modelId}`} value={`${m.provider}/${m.modelId}`}>
                        {m.label}
                        {m.paid ? " (paid)" : ""}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <Field label="Edit instruction">
                <textarea
                  name="instruction"
                  rows={2}
                  required
                  data-testid="subject-image-edit-instruction"
                  placeholder="e.g. change the coat to dark green; keep the face and pose"
                />
              </Field>
              <div className="flex flex-wrap items-center gap-3">
                <Button type="submit" variant="primary" data-testid="subject-image-edit-submit">
                  Edit Image
                </Button>
                {editors.some((m) => m.transparency) ? (
                  <TransparentToggle testId="subject-image-edit-transparent" />
                ) : null}
              </div>
              <details>
                <summary className="cursor-pointer text-xs text-muted">Advanced</summary>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <Field label="Aspect ratio" hint="Blank uses the model's first option.">
                    <input name="aspectRatio" placeholder={preferredEditor.aspectRatios[0] ?? ""} />
                  </Field>
                  {qualities.length > 0 ? <QualityField qualities={qualities} /> : null}
                </div>
              </details>
            </ActionForm>
          </details>
        ) : null}

        <ul className="grid gap-3 sm:grid-cols-2" data-testid="subject-image-results">
          {props.attempts.map((v) => {
            const out = v.outputs.find((o) => o.output.role === "primary") ?? v.outputs[0];
            const settings = v.attempt.modelSettings as {
              intent?: string;
              editSourceAssetId?: string;
              providerOptions?: { background?: string };
            };
            const intent = String(settings.intent ?? "");
            const editedFrom = settings.editSourceAssetId ?? null;
            return (
              <li
                key={v.attempt.id}
                className="rounded border border-line p-2"
                data-testid="subject-image"
                data-status={v.attempt.status}
              >
                <div className="mb-1 flex items-center justify-between text-xs">
                  <span>
                    #{v.attempt.attemptNumber} ·{" "}
                    {SUBJECT_IMAGE_INTENT_LABEL[intent as keyof typeof SUBJECT_IMAGE_INTENT_LABEL] ?? "Image"}{" "}
                    · {v.attempt.model}
                  </span>
                  <Badge
                    tone={
                      v.attempt.status === "succeeded"
                        ? "pass"
                        : v.attempt.status === "failed"
                          ? "fail"
                          : "neutral"
                    }
                  >
                    {v.attempt.status}
                  </Badge>
                </div>
                {editedFrom ? (
                  <p className="mb-1 text-[11px] text-muted" data-testid="subject-image-lineage">
                    Source: {sourceLabel.get(editedFrom) ?? "an earlier image"} → edit attempt #
                    {v.attempt.attemptNumber} → {out ? "this new image" : "new image (pending)"}
                  </p>
                ) : null}
                {settings.providerOptions?.background === "transparent" ? (
                  <Badge tone="neutral">Transparent background</Badge>
                ) : null}
                {out ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={assetUrl(out.asset) ?? undefined}
                    alt=""
                    className="w-full rounded"
                    data-testid="subject-image-preview"
                  />
                ) : null}
                {out && v.attempt.status === "succeeded" ? (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {subject.kind === "character" ? (
                      <>
                        <ActionForm
                          action={saveAsCharacterReference}
                          successMessage="Character reference set"
                          className="flex gap-1"
                        >
                          <input type="hidden" name="projectSlug" value={props.projectSlug} />
                          <input type="hidden" name="characterId" value={subject.id} />
                          <input type="hidden" name="attemptId" value={v.attempt.id} />
                          <select name="slot" defaultValue="front" aria-label="Reference slot">
                            {IDENTITY_SLOTS.map((s) => (
                              <option key={s} value={s}>
                                {s.replace("_", " ")}
                              </option>
                            ))}
                          </select>
                          <Button type="submit" size="sm" data-testid="use-as-character-reference">
                            Use as Character Reference
                          </Button>
                        </ActionForm>
                        {subject.looks.length > 0 ? (
                          <ActionForm
                            action={saveAsLookReference}
                            successMessage="Added to the Look"
                            className="flex gap-1"
                          >
                            <input type="hidden" name="projectSlug" value={props.projectSlug} />
                            <input type="hidden" name="attemptId" value={v.attempt.id} />
                            <select name="lookId" aria-label="Look">
                              {subject.looks.map((l) => (
                                <option key={l.id} value={l.id}>
                                  {l.name}
                                </option>
                              ))}
                            </select>
                            <Button type="submit" size="sm" data-testid="use-as-look">
                              Use as Look
                            </Button>
                          </ActionForm>
                        ) : null}
                      </>
                    ) : (
                      <ActionForm
                        action={saveAsLocationReference}
                        successMessage="Added to the Location's references"
                      >
                        <input type="hidden" name="projectSlug" value={props.projectSlug} />
                        <input type="hidden" name="locationId" value={subject.id} />
                        <input type="hidden" name="attemptId" value={v.attempt.id} />
                        <Button type="submit" size="sm" data-testid="use-as-location-reference">
                          Use as Location Reference
                        </Button>
                      </ActionForm>
                    )}
                    {subject.kind === "location" ? (
                      <ActionForm
                        action={saveAsLocationView}
                        successMessage="Location View saved"
                        className="flex gap-1"
                      >
                        <input type="hidden" name="projectSlug" value={props.projectSlug} />
                        <input type="hidden" name="locationId" value={subject.id} />
                        <input type="hidden" name="attemptId" value={v.attempt.id} />
                        <input
                          name="lv_name"
                          aria-label="View name"
                          placeholder="View name"
                          defaultValue={`Generated view #${v.attempt.attemptNumber}`}
                          className="w-36"
                        />
                        <Button type="submit" size="sm" data-testid="use-as-location-view">
                          Use as Location View
                        </Button>
                      </ActionForm>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
    </Panel>
  );
}

/** Phase 5B-I2: the simple transparency option. Refused by the server for a model without native transparency. */
function TransparentToggle({ testId }: { testId: string }) {
  return (
    <label className="flex items-center gap-1 text-xs">
      <input type="checkbox" name="transparent" value="1" data-testid={testId} />
      Transparent background
    </label>
  );
}

function QualityField({ qualities }: { qualities: string[] }) {
  return (
    <Field label="Quality" hint="Blank uses Prism's default for the model.">
      <select name="quality" defaultValue="">
        <option value="">Default</option>
        {qualities.map((q) => (
          <option key={q} value={q}>
            {q}
          </option>
        ))}
      </select>
    </Field>
  );
}
