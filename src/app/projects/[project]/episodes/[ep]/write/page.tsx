import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { RefreshWhileActive } from "@/components/images/refresh-while-active";
import { Badge, Button, PageHeader, Panel } from "@/components/ui";
import { DiffView } from "@/components/writing/diff-view";
import { CopyButton, ScriptSelection } from "@/components/writing/script-selection";
import type { WritingProposal } from "@/data/writing-repository";
import { ORIGIN_LABEL, sceneRanges } from "@/domain/story/revisions";
import { sourceFingerprint } from "@/domain/story/source";
import { canonical, MODE_LABEL, WRITING_PRESETS, type WritingPreset } from "@/domain/story/writing";
import { requireProject } from "@/server/repo";
import { getStoryRegistry, getStoryRepo, getWritingRepo } from "@/server/story";
import {
  askPrism,
  authorizeWritingSession,
  decideWritingProposal,
  markSceneBreakdownReviewed,
  newWritingSession,
  restoreScriptRevision,
} from "@/server/writing-actions";

/**
 * Phase 5B-S2: the writing workspace. The screenplay (a Scene or the Episode) on the left, the Prism AI conversation on
 * the right. Every AI turn is a proposal with a diff; nothing changes until the creator Accepts a version.
 */
export const dynamic = "force-dynamic";

const PRESET_ORDER: WritingPreset[] = [
  "rewrite",
  "continue",
  "shorten",
  "expand",
  "dialogue",
  "tone",
  "tension",
  "funnier",
  "brainstorm",
];

export default async function WritePage({
  params,
  searchParams,
}: {
  params: Promise<{ project: string; ep: string }>;
  searchParams: Promise<{ session?: string; scene?: string }>;
}) {
  const { project: slug, ep } = await params;
  const q = await searchParams;
  const data = await requireProject(slug);
  const episode = data.episodes.find((e) => e.slug === ep);
  if (!episode) notFound();
  const pid = data.project.id;
  const base = `/projects/${slug}/episodes/${ep}/write`;

  const text = canonical(episode.scriptText);
  const fingerprint = sourceFingerprint(text);
  const ranges = sceneRanges(text, data, episode.id);
  const scenes = data.scenes.filter((s) => s.episodeId === episode.id).sort((a, b) => a.order - b.order);
  const scene = q.scene ? (scenes.find((s) => s.id === q.scene) ?? null) : null;
  const range = scene ? (ranges.get(scene.id) ?? null) : null;
  const view = range
    ? { text: text.slice(range.start, range.end), offset: range.start }
    : { text, offset: 0 };

  const writing = await getWritingRepo();
  const sessions = await writing.listSessions(pid, episode.id);
  const session = (q.session ? sessions.find((s) => s.id === q.session) : sessions[0]) ?? null;
  const turns = session ? await writing.listProposals(pid, session.id) : [];
  const revisions = await writing.listRevisions(pid, episode.id);
  const open = await writing.openSceneChanges(pid);
  const changed = new Set(open.map((c) => c.sceneId));
  const importedFrom = revisions.find((r) => r.origin === "import");
  const storyProposal = importedFrom?.storyProposalId
    ? await (await getStoryRepo({ startInlineWorker: false })).get(pid, importedFrom.storyProposalId)
    : null;

  const registry = getStoryRegistry();
  const models = registry.models();
  const firstAvailable = models.find((m) => m.available);
  const paidOffered = models.some((m) => m.paid && m.available);
  const active = turns.some((t) => t.status === "queued" || t.status === "running");
  const sessionLeft =
    session && session.budgetExpiresAt && session.budgetExpiresAt > new Date().toISOString()
      ? session.budgetUsd - session.reservedUsd
      : 0;
  const hidden = (
    <>
      <input type="hidden" name="projectSlug" value={slug} />
      <input type="hidden" name="episodeId" value={episode.id} />
      {session ? <input type="hidden" name="sessionId" value={session.id} /> : null}
    </>
  );
  const scopeLabel = (p: WritingProposal) =>
    p.scope.kind === "episode"
      ? "Episode"
      : `${p.scope.kind === "selection" ? "Selection" : "Scene"}${
          p.scope.sceneId
            ? ` · Scene ${scenes.find((s) => s.id === p.scope.sceneId)?.sceneNumber ?? "?"}`
            : ""
        } · lines ${p.scope.startLine}–${p.scope.endLine}`;

  return (
    <div>
      <RefreshWhileActive active={active} intervalMs={1000} />
      <PageHeader
        title={`Write — ${episode.title}`}
        subtitle="Prism proposes; you choose what becomes the screenplay. Nothing changes until you Accept a version."
        actions={
          <ActionForm action={newWritingSession} quiet>
            {hidden}
            <Button type="submit" size="sm">
              New conversation
            </Button>
          </ActionForm>
        }
      />
      <div className="grid gap-4 p-6 xl:grid-cols-2">
        {/* ───────────── left: the screenplay ───────────── */}
        <div className="min-w-0 space-y-4">
          <Panel title="Scenes">
            <div className="flex flex-wrap gap-1.5 text-[12px]">
              <Link
                href={`${base}${session ? `?session=${session.id}` : ""}`}
                className={`rounded-[3px] border px-2 py-0.5 ${scene ? "border-line2 text-muted" : "border-accent text-accent"}`}
              >
                Whole Episode
              </Link>
              {scenes.map((s) => (
                <Link
                  key={s.id}
                  href={`${base}?scene=${s.id}${session ? `&session=${session.id}` : ""}`}
                  className={`rounded-[3px] border px-2 py-0.5 ${scene?.id === s.id ? "border-accent text-accent" : "border-line2 text-muted"}`}
                >
                  {s.sceneNumber}. {s.slugline}
                  {changed.has(s.id) ? <span className="ml-1 text-warn">●</span> : null}
                </Link>
              ))}
            </div>
          </Panel>

          <Panel title={scene ? `Scene ${scene.sceneNumber} — ${scene.slugline}` : "Whole Episode"}>
            {scene && changed.has(scene.id) ? (
              <div className="mb-3 flex items-center justify-between gap-3 rounded-[3px] border border-warn/40 bg-warn/5 px-3 py-2 text-[12px]">
                <span className="text-warn">Story changed after production breakdown.</span>
                <ActionForm action={markSceneBreakdownReviewed} quiet>
                  <input type="hidden" name="projectSlug" value={slug} />
                  <input type="hidden" name="sceneId" value={scene.id} />
                  <Button type="submit" size="sm">
                    Mark breakdown reviewed
                  </Button>
                </ActionForm>
              </div>
            ) : null}
            {view.text ? (
              <ScriptSelection text={view.text} baseOffset={view.offset} formId="ask-form" />
            ) : (
              <p className="text-[12px] text-muted">
                This Episode has no screenplay yet. Ask Prism to continue from nothing, or write on the Script
                page.
              </p>
            )}
          </Panel>

          <Panel
            title={`Screenplay history — ${revisions.length ? `${revisions.length} revisions` : "no revisions yet"}`}
          >
            {importedFrom ? (
              <p className="mb-2 text-[12px] text-muted">
                Original imported source:{" "}
                {storyProposal ? (
                  <Link className="text-accent" href={`/projects/${slug}/story/${storyProposal.id}`}>
                    Story proposal v{storyProposal.version}
                    {storyProposal.sourceMeta.filename ? ` (${storyProposal.sourceMeta.filename})` : ""}
                  </Link>
                ) : (
                  "a Story proposal"
                )}
                . Creator-approved Prism AI revisions are listed separately below; their words did not come
                from the imported source.
              </p>
            ) : null}
            {revisions.length === 0 ? (
              <p className="text-[12px] text-muted">
                History starts with the first saved change; the current text becomes revision 1.
              </p>
            ) : (
              <ul className="space-y-1.5" data-testid="revision-history">
                {revisions.map((r, i) => (
                  <li key={r.id} className="rounded-[3px] border border-line px-2 py-1.5 text-[12px]">
                    <div className="flex items-center justify-between gap-2">
                      <span>
                        <span className="font-mono">#{r.number}</span> {ORIGIN_LABEL[r.origin]}
                        {r.origin === "ai_revision" && r.alternativeIndex != null
                          ? ` (version ${String.fromCharCode(65 + r.alternativeIndex)}${r.changedRange ? `, lines ${r.changedRange.startLine}–${r.changedRange.endLine}` : ""})`
                          : ""}
                        {i === 0 && sourceFingerprint(canonical(r.text)) === fingerprint ? (
                          <Badge tone="pass" className="ml-2">
                            Current
                          </Badge>
                        ) : null}
                      </span>
                      <span className="text-faint">{new Date(r.createdAt).toLocaleString("en-US")}</span>
                    </div>
                    <details className="mt-1">
                      <summary className="cursor-pointer text-muted">View text</summary>
                      <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[11.5px]">
                        {r.text}
                      </pre>
                      {sourceFingerprint(canonical(r.text)) !== fingerprint ? (
                        <ActionForm action={restoreScriptRevision} className="mt-1">
                          <input type="hidden" name="projectSlug" value={slug} />
                          <input type="hidden" name="episodeId" value={episode.id} />
                          <input type="hidden" name="revisionId" value={r.id} />
                          <Button type="submit" size="sm">
                            Restore revision {r.number}
                          </Button>
                        </ActionForm>
                      ) : null}
                    </details>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        {/* ───────────── right: the conversation ───────────── */}
        <div className="min-w-0 space-y-4">
          <Panel title="Prism AI">
            {turns.length === 0 ? (
              <p className="text-[12px] text-muted">
                Select a passage (or pick a Scene) and tell Prism what you want — for example “Make Yumeko
                more guarded without changing what happens.” Prism answers with proposals you can compare,
                accept or reject.
              </p>
            ) : (
              <ol className="space-y-4" data-testid="writing-conversation">
                {turns.map((p) => (
                  <Turn
                    key={p.id}
                    p={p}
                    scopeLabel={scopeLabel(p)}
                    current={p.baseFingerprint === fingerprint}
                    hidden={hidden}
                    slug={slug}
                  />
                ))}
              </ol>
            )}
          </Panel>

          <Panel title="Ask Prism">
            <ActionForm action={askPrism} id="ask-form" className="space-y-2" resetOnSuccess quiet>
              {hidden}
              {scene ? <input type="hidden" name="sceneId" value={scene.id} /> : null}
              <textarea
                name="instruction"
                aria-label="Instruction for Prism"
                rows={3}
                placeholder="Make Yumeko more guarded and emotionally restrained without changing what happens in the scene."
                className="w-full"
              />
              <div className="flex flex-wrap items-center gap-3 text-[12px]">
                <span className="text-muted">Work on:</span>
                <label className="flex items-center gap-1">
                  <input id="scope-selection" type="radio" name="scopeKind" value="selection" /> Selection
                </label>
                {scene ? (
                  <label className="flex items-center gap-1">
                    <input type="radio" name="scopeKind" value="scene" defaultChecked /> This Scene
                  </label>
                ) : null}
                <label className="flex items-center gap-1">
                  <input type="radio" name="scopeKind" value="episode" defaultChecked={!scene} /> Whole
                  Episode
                </label>
                <label className="flex items-center gap-1">
                  Versions
                  <select name="alternatives" defaultValue="1" aria-label="Versions">
                    <option value="1">1</option>
                    <option value="2">2</option>
                    <option value="3">3</option>
                    <option value="5">5</option>
                  </select>
                </label>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <Button type="submit" name="preset" value="ask" variant="primary">
                  Ask Prism
                </Button>
                {PRESET_ORDER.map((k) => (
                  <Button key={k} type="submit" name="preset" value={k} size="sm">
                    {WRITING_PRESETS[k].label}
                  </Button>
                ))}
              </div>
              <details className="text-[12px]">
                <summary className="cursor-pointer text-muted">Advanced</summary>
                <div className="mt-2 space-y-2">
                  <label className="flex items-center gap-2">
                    Model
                    <select
                      name="model"
                      defaultValue={
                        firstAvailable ? `${firstAvailable.provider}/${firstAvailable.modelId}` : ""
                      }
                    >
                      {models.map((m) => (
                        <option
                          key={`${m.provider}/${m.modelId}`}
                          value={`${m.provider}/${m.modelId}`}
                          disabled={!m.available}
                        >
                          {m.label} — {m.provider}/{m.modelId}
                          {m.pricing
                            ? ` ($${m.pricing.inputPerMillionUsd}/$${m.pricing.outputPerMillionUsd} per 1M)`
                            : ""}
                          {m.available ? "" : ` (${m.reason})`}
                        </option>
                      ))}
                    </select>
                  </label>
                  {paidOffered ? (
                    <label className="flex items-center gap-2">
                      Confirm total ($)
                      <input
                        name="confirmedTotalUsd"
                        inputMode="decimal"
                        className="w-28"
                        placeholder="0.0000"
                      />
                    </label>
                  ) : null}
                </div>
              </details>
            </ActionForm>
          </Panel>

          {paidOffered && session ? (
            <Panel title="Spending">
              <p className="mb-2 text-[12px] text-muted">
                {sessionLeft > 0
                  ? `This conversation may spend up to $${sessionLeft.toFixed(4)} more without asking each time (until ${new Date(session.budgetExpiresAt!).toLocaleTimeString("en-US")}).`
                  : "Each paid request shows its estimate first. To skip typing it for small rewrites, allow a capped amount for this conversation."}{" "}
                Per request at most ${registry.spend.maxUsd.toFixed(2)}; per conversation at most $
                {registry.spend.sessionMaxUsd.toFixed(2)}.
              </p>
              <ActionForm
                action={authorizeWritingSession}
                className="flex flex-wrap items-center gap-2 text-[12px]"
              >
                {hidden}
                <label className="flex items-center gap-1">
                  Allow up to $
                  <input name="amountUsd" inputMode="decimal" className="w-20" defaultValue="0.25" />
                </label>
                <label className="flex items-center gap-1">
                  for
                  <select name="hours" defaultValue="2">
                    <option value="1">1 hour</option>
                    <option value="2">2 hours</option>
                    <option value="4">4 hours</option>
                  </select>
                </label>
                <Button type="submit" size="sm">
                  Allow
                </Button>
              </ActionForm>
            </Panel>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Turn({
  p,
  scopeLabel,
  current,
  hidden,
  slug,
}: {
  p: WritingProposal;
  scopeLabel: string;
  current: boolean;
  hidden: React.ReactNode;
  slug: string;
}) {
  const working = p.status === "queued" || p.status === "running";
  const decidable = p.status === "ready" && current;
  return (
    <li className="space-y-2" data-testid={`turn-${p.turn}`}>
      <div className="ml-8 rounded-[3px] border border-line2 bg-panel2 px-3 py-2 text-[12.5px]">
        <div>{p.instruction}</div>
        <div className="mt-1 flex flex-wrap gap-1.5">
          <Badge>{MODE_LABEL[p.mode]}</Badge>
          <Badge>{scopeLabel}</Badge>
          {p.parentId ? <Badge tone="info">follow-up</Badge> : null}
        </div>
      </div>
      <div className="mr-8 rounded-[3px] border border-line px-3 py-2 text-[12.5px]">
        {working ? <p className="text-muted">Prism is writing…</p> : null}
        {p.status === "failed" ? (
          <p className="text-fail">{p.error?.message ?? "Prism could not answer."}</p>
        ) : null}
        {p.result ? <p className="mb-2">{p.result.message}</p> : null}
        <div className="mb-2 flex flex-wrap gap-1.5">
          {p.status === "accepted" ? (
            <Badge tone="pass">
              Accepted version {String.fromCharCode(65 + (p.acceptedAlternative ?? 0))}
            </Badge>
          ) : null}
          {p.status === "rejected" ? <Badge tone="fail">Rejected</Badge> : null}
          {p.status === "ready" && !current ? (
            <Badge tone="warn">The screenplay changed since — ask again to apply</Badge>
          ) : null}
          {p.result && p.mode !== "brainstorm" && p.status === "ready" ? (
            <Badge tone="accent">AI suggestion — not canon</Badge>
          ) : null}
        </div>

        {p.mode === "brainstorm" && p.result ? (
          <ol className="space-y-2" data-testid="brainstorm-ideas">
            {p.result.ideas.map((idea, i) => (
              <li key={i} className="rounded-[3px] border border-line px-2 py-1.5">
                <div className="font-medium">
                  {i + 1}. {idea.title}
                </div>
                <div className="text-muted">{idea.detail}</div>
                {current ? (
                  <ActionForm action={askPrism} quiet className="mt-1">
                    {hidden}
                    <input type="hidden" name="parentId" value={p.id} />
                    <input type="hidden" name="preset" value="rewrite" />
                    <input type="hidden" name="instruction" value={`${idea.title}: ${idea.detail}`} />
                    <Button type="submit" size="sm">
                      Write this idea
                    </Button>
                  </ActionForm>
                ) : null}
              </li>
            ))}
          </ol>
        ) : null}

        {p.mode !== "brainstorm" && p.result
          ? p.result.alternatives.map((a, i) => (
              <div
                key={i}
                className="mb-3 space-y-1.5 rounded-[3px] border border-line p-2"
                data-testid={`version-${a.label}`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium">Version {a.label}</span>
                  {p.savedAlternatives.includes(i) ? <Badge tone="info">Saved alternate</Badge> : null}
                  {p.acceptedAlternative === i ? <Badge tone="pass">Canon</Badge> : null}
                </div>
                {a.explanation ? <p className="text-muted">{a.explanation}</p> : null}
                {a.newCharacterFacts.length ? (
                  <p className="text-[11.5px] text-warn">
                    Implies (kept in this revision only — not saved to the Character):{" "}
                    {a.newCharacterFacts.join(" · ")}
                  </p>
                ) : null}
                {p.mode === "continue" ? (
                  <p className="text-[11px] text-muted">Continuation after line {p.scope.endLine}:</p>
                ) : null}
                <DiffView original={p.mode === "continue" ? "" : p.targetText} proposed={a.text} />
                <details>
                  <summary className="cursor-pointer text-[11.5px] text-muted">
                    Original / Proposed side by side
                  </summary>
                  <div className="mt-1 grid gap-2 md:grid-cols-2">
                    <pre className="whitespace-pre-wrap rounded-[3px] border border-line p-2 font-mono text-[11.5px]">
                      {p.targetText}
                    </pre>
                    <pre className="whitespace-pre-wrap rounded-[3px] border border-line p-2 font-mono text-[11.5px]">
                      {a.text}
                    </pre>
                  </div>
                </details>
                <div className="flex flex-wrap items-center gap-1.5">
                  {decidable ? (
                    <ActionForm action={decideWritingProposal} quiet className="flex gap-1.5">
                      <input type="hidden" name="projectSlug" value={slug} />
                      <input type="hidden" name="proposalId" value={p.id} />
                      <input type="hidden" name="alternative" value={i} />
                      <Button type="submit" name="intent" value="accept" variant="primary" size="sm">
                        Accept version {a.label}
                      </Button>
                      <Button type="submit" name="intent" value="save" size="sm">
                        Save as alternate
                      </Button>
                    </ActionForm>
                  ) : null}
                  <CopyButton text={a.text} />
                </div>
                {current && p.status !== "accepted" ? (
                  <ActionForm action={askPrism} quiet resetOnSuccess className="flex gap-1.5">
                    {hidden}
                    <input type="hidden" name="parentId" value={p.id} />
                    <input type="hidden" name="parentAlternative" value={i} />
                    <input
                      name="instruction"
                      aria-label={`Revise version ${a.label}`}
                      placeholder={`Revise again: “Version ${a.label}, but warmer at the end.”`}
                      className="min-w-0 flex-1"
                    />
                    <Button type="submit" size="sm">
                      Revise again
                    </Button>
                  </ActionForm>
                ) : null}
              </div>
            ))
          : null}

        {decidable ? (
          <ActionForm action={decideWritingProposal} quiet>
            <input type="hidden" name="projectSlug" value={slug} />
            <input type="hidden" name="proposalId" value={p.id} />
            <Button type="submit" name="intent" value="reject" variant="danger" size="sm">
              Reject
            </Button>
          </ActionForm>
        ) : null}

        <details className="mt-2 text-[11px] text-faint">
          <summary className="cursor-pointer">Advanced</summary>
          <div className="mt-1 space-y-0.5 font-mono">
            <div>
              {p.provider}/{p.model} · prompt {p.promptVersion} · {p.schemaVersion}
            </div>
            <div>
              estimate ${p.estimate.usd.toFixed(4)} ({p.estimate.inputTokens} in / ≤
              {p.estimate.maxOutputTokens} out) · spend {p.spendAuthorization}
              {p.actualUsd != null ? ` · actual $${p.actualUsd.toFixed(6)}` : ""} · calls {p.providerCalls}
            </div>
            <div>base {p.baseFingerprint.slice(0, 12)}…</div>
          </div>
        </details>
      </div>
    </li>
  );
}
