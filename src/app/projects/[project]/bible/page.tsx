import { Button, Field, PageHeader, Panel } from "@/components/ui";
import { saveBible } from "@/server/actions";
import { requireProject } from "@/server/repo";

export default async function BiblePage({ params }: { params: Promise<{ project: string }> }) {
  const { project: slug } = await params;
  const { bible } = await requireProject(slug);
  const join = (xs: string[]) => xs.join("\n");

  return (
    <div>
      <PageHeader
        title="Production Bible"
        subtitle="Structured canon. Guardrails are injected verbatim into every generation package."
      />
      <form action={saveBible} className="grid gap-4 p-6 xl:grid-cols-2">
        <input type="hidden" name="projectSlug" value={slug} />
        <Panel title="Identity" className="xl:col-span-2">
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Premise" className="md:col-span-2">
              <textarea name="premise" rows={3} defaultValue={bible.premise} />
            </Field>
            <Field label="Genre">
              <input name="genre" defaultValue={bible.genre} />
            </Field>
            <Field label="Tone">
              <input name="tone" defaultValue={bible.tone} />
            </Field>
          </div>
        </Panel>

        <Panel title="Look & cinematography">
          <div className="space-y-3">
            <Field label="Visual style">
              <textarea name="visualStyle" rows={3} defaultValue={bible.visualStyle} />
            </Field>
            <Field label="Cinematography rules" hint="One per line">
              <textarea name="cinematographyRules" rows={4} defaultValue={join(bible.cinematographyRules)} />
            </Field>
            <Field label="Color language">
              <textarea name="colorLanguage" rows={2} defaultValue={bible.colorLanguage} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Aspect ratio">
                <input name="aspectRatio" defaultValue={bible.aspectRatio} />
              </Field>
              <Field label="Default frame rate">
                <input
                  name="defaultFrameRate"
                  type="number"
                  step="0.001"
                  defaultValue={bible.defaultFrameRate}
                />
              </Field>
            </div>
          </div>
        </Panel>

        <Panel title="Language & audio">
          <div className="space-y-3">
            <Field label="Dialogue language strategy">
              <textarea
                name="dialogueLanguageStrategy"
                rows={2}
                defaultValue={bible.dialogueLanguageStrategy}
              />
            </Field>
            <Field label="Subtitle strategy">
              <textarea name="subtitleStrategy" rows={2} defaultValue={bible.subtitleStrategy} />
            </Field>
            <Field label="Audio philosophy">
              <textarea name="audioPhilosophy" rows={3} defaultValue={bible.audioPhilosophy} />
            </Field>
          </div>
        </Panel>

        <Panel title="Canon facts">
          <Field label="One per line">
            <textarea name="canonFacts" rows={6} defaultValue={join(bible.canonFacts)} />
          </Field>
        </Panel>

        <Panel title="Continuity rules">
          <Field label="One per line">
            <textarea name="continuityRules" rows={6} defaultValue={join(bible.continuityRules)} />
          </Field>
        </Panel>

        <Panel title="Forbidden changes / generator guardrails" className="xl:col-span-2">
          <Field label="One per line — included in every generation package">
            <textarea name="guardrails" rows={8} defaultValue={join(bible.guardrails)} />
          </Field>
        </Panel>

        <div className="xl:col-span-2">
          <Button type="submit" variant="primary">
            Save bible
          </Button>
        </div>
      </form>
    </div>
  );
}
