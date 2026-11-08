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
import type { ImageModelOption } from "@/server/subject-images";
import {
  startSubjectImage,
  saveAsCharacterReference,
  saveAsLocationReference,
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
}) {
  const { subject } = props;
  const intents = subject.kind === "character" ? CHARACTER_IMAGE_INTENTS : LOCATION_IMAGE_INTENTS;
  const usable = props.models.filter((m) => m.available);
  const preferred = usable.find((m) => !m.paid) ?? usable[0] ?? null;
  const active = props.attempts.some((a) => ACTIVE.has(a.attempt.status));
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
              </div>
            </details>
          </ActionForm>
        ) : (
          <p className="text-sm text-muted" data-testid="subject-image-unavailable">
            No image model is available on this server.
          </p>
        )}

        <ul className="grid gap-3 sm:grid-cols-2" data-testid="subject-image-results">
          {props.attempts.map((v) => {
            const out = v.outputs.find((o) => o.output.role === "primary") ?? v.outputs[0];
            const intent = String((v.attempt.modelSettings as { intent?: string }).intent ?? "");
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
