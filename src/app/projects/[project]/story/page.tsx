import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Field, PageHeader, Panel } from "@/components/ui";
import { proposalCounts } from "@/domain/story/proposal";
import { requireProject } from "@/server/repo";
import { analyzeStory } from "@/server/story-actions";
import { getStoryRegistry, getStoryRepo } from "@/server/story";

export const dynamic = "force-dynamic";

const STATUS_TONE = {
  queued: "neutral",
  running: "warn",
  ready: "pass",
  failed: "fail",
  applied: "pass",
} as const;

/**
 * Phase 5B-S1: Import Story. Paste a script, upload a screenplay / document, or analyse an Episode script that is
 * already in the project → Analyze with Prism AI → a Production Proposal to review. Nothing is applied until the creator
 * chooses Apply selected on the proposal.
 */
export default async function StoryPage({ params }: { params: Promise<{ project: string }> }) {
  const { project: slug } = await params;
  const data = await requireProject(slug);
  const registry = getStoryRegistry();
  const models = registry.models();
  const preferred = models.find((m) => m.available && !m.paid) ?? models.find((m) => m.available) ?? null;
  const proposals = await (await getStoryRepo()).list(data.project.id);
  const episodes = data.episodes.filter((e) => e.scriptText.trim());
  const documents = data.assets.filter((a) => a.type === "document" && a.tags.includes("story-source"));
  const hidden = <input type="hidden" name="projectSlug" value={slug} />;
  const advanced = (
    <details className="text-[12px]" data-testid="story-advanced">
      <summary className="cursor-pointer text-muted">Advanced</summary>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <Field
          label="Model"
          hint="Prism suggests a free model first; you choose. Paid models show their estimate first."
        >
          <select
            name="model"
            defaultValue={preferred ? `${preferred.provider}/${preferred.modelId}` : ""}
            data-testid="story-model"
          >
            {models.map((m) => (
              <option
                key={`${m.provider}/${m.modelId}`}
                value={`${m.provider}/${m.modelId}`}
                disabled={!m.available}
              >
                {m.label}
                {m.paid && m.pricing
                  ? ` (paid: $${m.pricing.inputPerMillionUsd}/$${m.pricing.outputPerMillionUsd} per 1M tokens)`
                  : ""}
                {m.available ? "" : ` — ${m.reason}`}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Confirm total (USD)"
          hint="Paid models only: Prism shows the estimate, then you confirm it here."
        >
          <input name="confirmedTotalUsd" inputMode="decimal" />
        </Field>
      </div>
    </details>
  );
  const analyze = (
    <Button type="submit" variant="primary" data-testid="story-analyze" disabled={!preferred}>
      Analyze with Prism AI
    </Button>
  );

  return (
    <div>
      <PageHeader
        title="Import Story"
        subtitle="Paste or upload a screenplay, treatment or outline. Prism proposes Characters, Locations, Scenes and Shots; you review and apply what you want."
      />
      <div className="grid gap-4 p-6 xl:grid-cols-[1fr_360px]">
        <div className="space-y-4">
          <Panel title="Paste script">
            <ActionForm action={analyzeStory} className="space-y-3 p-3" data-testid="story-paste-form">
              {hidden}
              <input type="hidden" name="sourceMode" value="paste" />
              <Field label="Working title (optional)">
                <input name="title" maxLength={200} data-testid="story-title" />
              </Field>
              <Field label="Screenplay, treatment or outline">
                <textarea
                  name="text"
                  rows={14}
                  required
                  className="font-mono text-[12px]"
                  data-testid="story-text"
                />
              </Field>
              {advanced}
              {analyze}
            </ActionForm>
          </Panel>
          <Panel title="Upload file">
            <ActionForm action={analyzeStory} className="space-y-3 p-3" data-testid="story-upload-form">
              {hidden}
              <input type="hidden" name="sourceMode" value="upload" />
              <Field
                label="PDF, DOCX, TXT or Fountain (up to 10 MB)"
                hint="The original file is kept as a project asset."
              >
                <input
                  type="file"
                  name="file"
                  accept=".pdf,.docx,.txt,.fountain,.md"
                  required
                  data-testid="story-file"
                />
              </Field>
              <Field label="Working title (optional)">
                <input name="title" maxLength={200} />
              </Field>
              {advanced}
              {analyze}
            </ActionForm>
          </Panel>
          {episodes.length || documents.length ? (
            <Panel title="Start from this project's material">
              <div className="space-y-3 p-3">
                {episodes.length ? (
                  <ActionForm
                    action={analyzeStory}
                    className="flex flex-wrap items-end gap-2"
                    data-testid="story-episode-form"
                  >
                    {hidden}
                    <input type="hidden" name="sourceMode" value="episode" />
                    <Field label="Episode script">
                      <select name="episodeId" data-testid="story-episode">
                        {episodes.map((e) => (
                          <option key={e.id} value={e.id}>
                            Episode {e.number} — {e.title}
                          </option>
                        ))}
                      </select>
                    </Field>
                    {advanced}
                    {analyze}
                  </ActionForm>
                ) : null}
                {documents.length ? (
                  <ActionForm action={analyzeStory} className="flex flex-wrap items-end gap-2">
                    {hidden}
                    <input type="hidden" name="sourceMode" value="asset" />
                    <Field label="An uploaded story document">
                      <select name="assetId">
                        {documents.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.originalFilename || a.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                    {advanced}
                    {analyze}
                  </ActionForm>
                ) : null}
              </div>
            </Panel>
          ) : null}
        </div>
        <Panel title="Proposals">
          <ul className="divide-y divide-line" data-testid="story-proposals">
            {proposals.length === 0 ? <li className="p-3 text-[12px] text-muted">No proposal yet.</li> : null}
            {proposals.map((p) => {
              const counts = p.proposal ? proposalCounts(p.proposal) : null;
              return (
                <li key={p.id} className="p-3 text-[12.5px]" data-testid="story-proposal-row">
                  <Link href={`/projects/${slug}/story/${p.id}`} className="font-medium hover:underline">
                    Proposal v{p.version}
                  </Link>{" "}
                  <Badge tone={STATUS_TONE[p.status]}>{p.status}</Badge>
                  <div className="text-[11px] text-muted">
                    {p.sourceMeta.filename ??
                      (p.sourceKind === "episode_script" ? "Episode script" : "Pasted text")}
                    {p.scope.kind === "section" ? ` · revised ${p.scope.section}` : ""}
                    {counts
                      ? ` · ${counts.characters} Characters · ${counts.locations} Locations · ${counts.scenes} Scenes · ${counts.shots} Shots`
                      : ""}
                  </div>
                </li>
              );
            })}
          </ul>
        </Panel>
      </div>
    </div>
  );
}
