import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { RefreshWhileActive } from "@/components/images/refresh-while-active";
import { Badge, Button, Field, PageHeader, Panel } from "@/components/ui";
import type { StoryProposalRecord } from "@/data/story-repository";
import { proposalCounts, type ProductionProposal } from "@/domain/story/proposal";
import { EDITABLE, edited, itemId, type ItemKind, type ProposalReview } from "@/domain/story/review";
import { describeSources, excerpt } from "@/domain/story/source";
import { requireProject } from "@/server/repo";
import { getStoryRegistry, getStoryRepo } from "@/server/story";
import { regenerateProposal, submitProposalReview } from "@/server/story-actions";
import { reviewOf } from "@/server/story-review";

export const dynamic = "force-dynamic";

const FIELD_LABEL: Record<string, string> = {
  title: "Title",
  logline: "Logline",
  synopsis: "Synopsis",
  name: "Name",
  role: "Role",
  description: "Description",
  personality: "Personality",
  visualNotes: "Visual identity notes",
  timeStateNotes: "Time / state",
  heading: "Heading",
  timeOfDay: "Time of day",
  summary: "Summary",
  purpose: "Purpose",
  visualIntent: "Visual intent",
};

/**
 * Phase 5B-S1: a Production Proposal, for review. Creator language, never raw JSON: Story, Characters, Locations,
 * Scenes, Shots — each item with why Prism proposed it (its source lines and an excerpt), its confidence, a possible
 * match with what the project already has, and editable fields. Nothing changes the project until Apply selected.
 */
export default async function ProposalPage({
  params,
}: {
  params: Promise<{ project: string; proposalId: string }>;
}) {
  const { project: slug, proposalId } = await params;
  const data = await requireProject(slug);
  const repo = await getStoryRepo();
  const record = await repo.get(data.project.id, proposalId);
  if (!record) notFound();
  const parent = record.parentId ? await repo.get(data.project.id, record.parentId) : null;
  const review = await reviewOf(record, data, parent);
  const active = record.status === "queued" || record.status === "running";
  const p = record.proposal;
  const applied = record.status === "applied";
  const source =
    record.sourceMeta.filename ??
    (record.sourceKind === "episode_script" ? "an Episode script" : "pasted text");

  return (
    <div>
      <RefreshWhileActive active={active} />
      <PageHeader
        title={`Proposal v${record.version}`}
        subtitle={`From ${source}${record.scope.kind === "section" ? ` · ${record.scope.section} revised from v${parent?.version ?? "?"}` : ""}`}
        actions={
          <span data-testid="story-status" data-status={record.status}>
            <Badge
              tone={
                record.status === "failed" ? "fail" : record.status === "ready" || applied ? "pass" : "warn"
              }
            >
              {active ? "Prism AI is analysing…" : record.status}
            </Badge>
          </span>
        }
      />
      <div className="space-y-4 p-6">
        <p className="text-[12px]">
          <Link href={`/projects/${slug}/story`} className="text-muted hover:underline">
            ← Import Story
          </Link>
        </p>
        {record.status === "failed" ? (
          <p className="text-[13px] text-fail" data-testid="story-error">
            {record.error?.message ?? "The analysis failed."}
          </p>
        ) : null}
        {p && review ? (
          <>
            <ProposalSummary p={p} />
            {applied ? <Applied slug={slug} record={record} /> : null}
            <ActionForm
              action={submitProposalReview}
              successMessage="Done"
              className="space-y-4"
              data-testid="story-review-form"
            >
              <input type="hidden" name="projectSlug" value={slug} />
              <input type="hidden" name="proposalId" value={record.id} />
              <fieldset disabled={applied} className="space-y-4">
                <Panel title="Story">
                  <div className="grid gap-2 p-3 md:grid-cols-2" data-testid="story-section-story">
                    {EDITABLE.story.map((f) => (
                      <Field
                        key={f}
                        label={FIELD_LABEL[f] ?? f}
                        className={f === "synopsis" ? "md:col-span-2" : ""}
                      >
                        {f === "title" ? (
                          <input
                            name={`story:${f}`}
                            defaultValue={edited("story", p.story, review.story)[f as "title"]}
                          />
                        ) : (
                          <textarea
                            name={`story:${f}`}
                            rows={f === "synopsis" ? 3 : 2}
                            defaultValue={edited("story", p.story, review.story)[f as "logline"]}
                          />
                        )}
                      </Field>
                    ))}
                    <p className="text-[11px] text-muted md:col-span-2">
                      {[
                        p.story.tone !== "unspecified" ? `Tone: ${p.story.tone}` : "",
                        p.story.genre ? `Genre: ${p.story.genre}` : "",
                        p.story.languages.length ? `Languages: ${p.story.languages.join(", ")}` : "",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </div>
                </Panel>
                <Items
                  kind="character"
                  title="Characters"
                  items={p.characters}
                  p={p}
                  review={review}
                  record={record}
                  data={data}
                />
                <Items
                  kind="location"
                  title="Locations"
                  items={p.locations}
                  p={p}
                  review={review}
                  record={record}
                  data={data}
                />
                <Items
                  kind="scene"
                  title="Scenes"
                  items={[...p.scenes].sort((a, b) => a.order - b.order)}
                  p={p}
                  review={review}
                  record={record}
                  data={data}
                />
                <Items
                  kind="shot"
                  title="Suggested Shots"
                  items={p.shots}
                  p={p}
                  review={review}
                  record={record}
                  data={data}
                />
                <Panel title="Apply">
                  <div className="flex flex-wrap items-end gap-3 p-3">
                    <Field label="Scenes and Shots go into">
                      <select
                        name="target"
                        defaultValue={
                          review.target.kind === "existing_episode" ? review.target.episodeId : "new"
                        }
                        data-testid="story-target"
                      >
                        <option value="new">A new Episode (its script is this source)</option>
                        {data.episodes.map((e) => (
                          <option key={e.id} value={e.id}>
                            The end of Episode {e.number} — {e.title}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Button type="submit" name="intent" value="save" size="sm" data-testid="story-save">
                      Save review
                    </Button>
                    <Button type="submit" name="intent" value="select_all" size="sm">
                      Select all
                    </Button>
                    <Button type="submit" name="intent" value="select_none" size="sm">
                      Deselect all
                    </Button>
                    <Button
                      type="submit"
                      name="intent"
                      value="apply"
                      variant="primary"
                      data-testid="story-apply"
                    >
                      Apply selected
                    </Button>
                  </div>
                  <p className="px-3 pb-3 text-[11px] text-muted">
                    Only selected, not rejected items are created. Possible matches use your choice; nothing
                    existing is overwritten (Merge only fills empty fields). No image, Look or Production
                    Frame is created.
                  </p>
                </Panel>
              </fieldset>
            </ActionForm>
          </>
        ) : null}
        {!active && !applied ? <Regenerate slug={slug} record={record} /> : null}
        <details className="text-[11.5px] text-muted" data-testid="story-provenance">
          <summary className="cursor-pointer">Advanced</summary>
          <dl className="mt-1 grid grid-cols-[160px_1fr] gap-x-3">
            <dt>Provider / model</dt>
            <dd>
              {record.provider} / {record.model}
            </dd>
            <dt>Schema / prompt</dt>
            <dd>
              {record.schemaVersion} · {record.promptVersion}
            </dd>
            <dt>Source fingerprint</dt>
            <dd className="font-mono">{record.sourceFingerprint.slice(0, 16)}…</dd>
            <dt>Source</dt>
            <dd>
              {source} · {record.sourceMeta.lineCount} lines
              {record.sourceMeta.pages ? ` · ${record.sourceMeta.pages.length} pages` : ""}
            </dd>
            <dt>Estimate / actual</dt>
            <dd>
              ${record.estimate.usd.toFixed(4)} /{" "}
              {record.actualUsd == null ? "—" : `$${record.actualUsd.toFixed(4)}`} · {record.providerCalls}{" "}
              provider call{record.providerCalls === 1 ? "" : "s"}
            </dd>
            <dt>Created</dt>
            <dd>{record.createdAt.slice(0, 16).replace("T", " ")} UTC</dd>
          </dl>
        </details>
      </div>
    </div>
  );
}

function ProposalSummary({ p }: { p: ProductionProposal }) {
  const c = proposalCounts(p);
  return (
    <div className="flex flex-wrap gap-2 text-[13px]" data-testid="story-counts">
      <Badge tone="info">{c.characters} Characters</Badge>
      <Badge tone="info">{c.locations} Locations</Badge>
      <Badge tone="info">{c.scenes} Scenes</Badge>
      <Badge tone="info">{c.shots} suggested Shots</Badge>
    </div>
  );
}

function Applied({ slug, record }: { slug: string; record: StoryProposalRecord }) {
  const s = record.appliedSummary as {
    episodeSlug?: string | null;
    shotIds?: string[];
    charactersCreated?: number;
    locationsCreated?: number;
    scenes?: number;
    shots?: number;
  } | null;
  return (
    <div className="border border-pass/40 bg-pass/10 p-3 text-[13px]" data-testid="story-applied">
      Applied {record.appliedAt?.slice(0, 16).replace("T", " ")} UTC: {s?.charactersCreated ?? 0} Characters,{" "}
      {s?.locationsCreated ?? 0} Locations, {s?.scenes ?? 0} Scenes, {s?.shots ?? 0} Shots created.
      {s?.episodeSlug ? (
        <span className="ml-2">
          <Link
            href={`/projects/${slug}/episodes/${s.episodeSlug}/shots`}
            className="underline"
            data-testid="story-applied-episode"
          >
            Open the Episode
          </Link>
          {s.shotIds?.[0] ? (
            <>
              {" · "}
              <Link
                href={`/projects/${slug}/episodes/${s.episodeSlug}/shots/${s.shotIds[0]}`}
                className="underline"
                data-testid="story-applied-shot"
              >
                Open the first Shot
              </Link>
            </>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

type AnyItem = { key: string } & Record<string, unknown>;

function Items(props: {
  kind: ItemKind;
  title: string;
  items: ReadonlyArray<object>;
  p: ProductionProposal;
  review: ProposalReview;
  record: StoryProposalRecord;
  data: Awaited<ReturnType<typeof requireProject>>;
}) {
  const { kind, p, review, record, data } = props;
  const charName = (k: string) => p.characters.find((c) => c.key === k)?.name ?? k;
  const locName = (k: string | null) =>
    k ? (p.locations.find((l) => l.key === k)?.name ?? k) : "unspecified";
  const sceneLabel = (k: string) => {
    const s = p.scenes.find((x) => x.key === k);
    return s ? `Scene ${s.order}` : k;
  };
  const existingName = (id: string) =>
    (kind === "character" ? data.characters : data.locations).find((x) => x.id === id)?.name ??
    "a removed record";
  return (
    <Panel title={`${props.title} (${props.items.length})`}>
      <ul className="divide-y divide-line" data-testid={`story-section-${kind}`}>
        {(props.items as AnyItem[]).map((raw) => {
          const id = itemId(kind, raw.key);
          const r = review.items[id];
          const item = edited(kind, raw, r?.edits ?? {}) as AnyItem;
          const name =
            kind === "scene"
              ? `Scene ${String(item.order)} — ${String(item.heading)}`
              : kind === "shot"
                ? `${sceneLabel(String(item.sceneKey))} · ${String(item.purpose)}`
                : String(item.name);
          const sources = (item.sources as Array<{ startLine: number; endLine: number }>) ?? [];
          const detail =
            kind === "character"
              ? String(item.role) !== "unspecified"
                ? String(item.role)
                : ""
              : kind === "location"
                ? `${String(item.intExt)}${item.recurringSet ? " · recurring set" : ""}`
                : kind === "scene"
                  ? `${locName(item.locationKey as string | null)} · ${String(item.timeOfDay)} · ${(item.characterKeys as string[]).map(charName).join(", ") || "no named Characters"}`
                  : `${(item.characterKeys as string[]).map(charName).join(", ") || "no Characters"} · ${locName(item.locationKey as string | null)}`;
          return (
            <li key={id} className="space-y-1 p-3 text-[13px]" data-testid="story-item" data-item={id}>
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1.5 font-medium">
                  <input
                    type="checkbox"
                    name={`include:${id}`}
                    value="1"
                    defaultChecked={!!r?.selected}
                    data-testid="story-include"
                  />
                  <span data-testid="story-item-name">{name}</span>
                </label>
                {detail ? <span className="text-[11.5px] text-muted">{detail}</span> : null}
                {"confidence" in item && item.confidence !== "high" ? (
                  <Badge tone="warn">{String(item.confidence)} confidence</Badge>
                ) : null}
                <label className="ml-auto flex items-center gap-1 text-[11px] text-muted">
                  <input
                    type="checkbox"
                    name={`reject:${id}`}
                    value="1"
                    defaultChecked={!!r?.rejected}
                    data-testid="story-reject"
                  />
                  Reject
                </label>
              </div>
              {item.ambiguity ? (
                <p className="text-[11.5px] text-warn">Ambiguity: {String(item.ambiguity)}</p>
              ) : null}
              {r?.match ? (
                <div className="flex flex-wrap items-center gap-2 text-[12px]" data-testid="story-match">
                  <span>
                    Possible match: existing {kind === "character" ? "Character" : "Location"}{" "}
                    <strong>{existingName(r.match.existingId)}</strong>
                  </span>
                  <select
                    name={`match:${id}`}
                    defaultValue={r.match.decision ?? ""}
                    data-testid="story-match-decision"
                  >
                    <option value="">Choose…</option>
                    <option value="use_existing">Use existing</option>
                    <option value="create_new">Create new</option>
                    <option value="merge">Merge (fill empty fields)</option>
                  </select>
                </div>
              ) : null}
              <p className="text-[11px] text-muted" data-testid="story-source">
                Why: {describeSources(sources, record.sourceMeta.pages)}
                {sources[0] ? ` — “${excerpt(record.inputText, sources[0], 160)}”` : ""}
              </p>
              <details>
                <summary className="cursor-pointer text-[11px] text-muted">Edit</summary>
                <div className="mt-1 grid gap-2 md:grid-cols-2">
                  {EDITABLE[kind].map((f) => (
                    <Field key={f} label={FIELD_LABEL[f] ?? f}>
                      <input
                        name={`edit:${id}:${f}`}
                        defaultValue={String(item[f] ?? "")}
                        data-testid={`story-edit-${f}`}
                      />
                    </Field>
                  ))}
                </div>
              </details>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

function Regenerate({ slug, record }: { slug: string; record: StoryProposalRecord }) {
  const models = getStoryRegistry().models();
  const current = `${record.provider}/${record.model}`;
  return (
    <Panel title="Regenerate">
      <ActionForm
        action={regenerateProposal}
        className="flex flex-wrap items-end gap-2 p-3"
        data-testid="story-regenerate"
      >
        <input type="hidden" name="projectSlug" value={slug} />
        <input type="hidden" name="proposalId" value={record.id} />
        <Field label="What">
          <select name="section" defaultValue="">
            <option value="">The whole proposal</option>
            {record.proposal
              ? ["story", "characters", "locations", "scenes", "shots"].map((s) => (
                  <option key={s} value={s}>
                    Only {s}
                  </option>
                ))
              : null}
          </select>
        </Field>
        <Field label="Note (optional)">
          <input
            name="note"
            maxLength={500}
            placeholder="e.g. treat the hotel exterior and lobby separately"
          />
        </Field>
        <Field label="Model">
          <select name="model" defaultValue={current}>
            {models.map((m) => (
              <option
                key={`${m.provider}/${m.modelId}`}
                value={`${m.provider}/${m.modelId}`}
                disabled={!m.available}
              >
                {m.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Confirm total (USD)" hint="Paid models only.">
          <input name="confirmedTotalUsd" inputMode="decimal" className="w-24" />
        </Field>
        <Button type="submit" size="sm">
          Regenerate (new version)
        </Button>
      </ActionForm>
    </Panel>
  );
}
