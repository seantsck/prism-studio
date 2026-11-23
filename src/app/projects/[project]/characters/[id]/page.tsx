import { notFound } from "next/navigation";
import { Badge, Button, Field, PageHeader, Panel } from "@/components/ui";
import { FramePlaceholder } from "@/components/shared";
import {
  CONTINUITY_LOCK_EXPLANATION,
  ContinuityLockCard,
} from "@/components/character-continuity/continuity-lock-ui";
import { referenceOrigin, referenceOriginLabel } from "@/domain/generation/reference-integrity";
import { IDENTITY_SLOTS } from "@/domain/schemas";
import { assetUrl } from "@/lib/utils";
import {
  saveCharacter,
  saveLook,
  saveVoiceProfile,
  setIdentityLocked,
  setLookLocked,
  setVoiceLocked,
  uploadIdentityRef,
  uploadLookReference,
} from "@/server/actions";
import { createCharacterContinuityLock } from "@/server/character-continuity-actions";
import { getRepo, requireProject } from "@/server/repo";
import { ActionForm } from "@/components/action-form";
import { SubjectImagePanel } from "@/components/images/subject-image-panel";
import { VisualBiblePanel } from "@/components/images/visual-bible-panel";
import { subjectImageState } from "@/server/subject-images";
import { ArchiveButton, ArchivedPanel, DeleteButton, DeleteSubjectButton } from "@/components/studio/archive";
import { LibraryToggle } from "@/components/characters/library";
import { UseInProject } from "@/components/library/use-in-project";
import { CharacterAi } from "@/components/characters/character-ai";
import { SheetField } from "@/components/characters/sheet-field";
import { PART_SIZE_HINT, PART_SIZE_LABEL, partSizeOf } from "@/domain/character-ai";
import { PART_SIZES } from "@/domain/schemas";
import { ReferenceViewsPanel, type ViewState } from "@/components/characters/reference-views";
import { referenceSetViewOf } from "@/domain/generation/reference-studio";
import { quoteReferenceViews } from "@/server/reference-views";
import { getGenerationConfig, getGenerationRepo } from "@/server/generation";
import { randomUUID } from "node:crypto";
import type { WritingProposal } from "@/data/writing-repository";
import { characterSheetThin, isCharacterRequest } from "@/domain/character-ai";
import { quoteCharacterFill } from "@/server/series-start";
import { getWritingRepo } from "@/server/story";
import { autoFillCharacter } from "@/server/sheet-autofill";
import { referenceStudioState } from "@/server/reference-studio";
import Link from "next/link";

const join = (xs: string[]) => xs.join("\n");

export default async function CharacterPage({
  params,
  searchParams,
}: {
  params: Promise<{ project: string; id: string }>;
  searchParams: Promise<{ new?: string }>;
}) {
  const { project: slug, id } = await params;
  const fresh = (await searchParams).new === "1";
  const data = await requireProject(slug);
  const found = data.characters.find((x) => x.id === id);
  if (!found) notFound();
  let c = found;
  const refs = data.identityRefs.filter((r) => r.characterId === c.id);
  const looks = data.looks.filter((l) => l.characterId === c.id);
  const voices = data.voiceProfiles.filter((v) => v.characterId === c.id);
  // Phase 2G.4: this Character's immutable Continuity Locks, grouped by the Look they froze (null = no Look)
  const locks = (data.characterContinuityLocks ?? [])
    .filter((l) => l.characterId === c.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const lockGroups = [...new Set(locks.map((l) => l.sourceLookId))].map((lookId) => ({
    lookId,
    title: lookId
      ? `Look "${looks.find((l) => l.id === lookId)?.name ?? locks.find((l) => l.sourceLookId === lookId)?.facts.look?.name ?? "removed"}"`
      : "No Look",
    locks: locks.filter((l) => l.sourceLookId === lookId),
  }));
  const assetsById = new Map(data.assets.map((a) => [a.id, a]));
  const identityLocked = refs.length > 0 && refs.every((r) => r.locked);
  const hidden = <input type="hidden" name="projectSlug" value={slug} />;
  // Phase 5B-I1: this Character's generated images (its own subject attempts; never Shot history)
  const images = await subjectImageState({ kind: "character", characterId: c.id }, data);
  // every picture of this Character (their photos, Look pictures, finished takes), each with Archive, and the archive
  const pictures = await referenceStudioState(data, `character:${c.id}`);
  const size = partSizeOf(c);
  const ownPhotos = pictures.images.filter((i) => i.origin === "uploaded").length;
  // each reference view: in the set, being made, made and waiting to be added, or still to make (and its price)
  const IN_FLIGHT = new Set([
    "queued",
    "submitting",
    "submitted",
    "processing",
    "ingesting",
    "cancel_requested",
  ]);
  const viewStates: Record<string, ViewState> = {};
  for (const v of pictures.referenceSet) viewStates[v.id] = v.assetId ? "in_set" : "missing";
  for (const t of pictures.takes) {
    const view = referenceSetViewOf(t.settings.intent);
    if (!view || viewStates[view] === "in_set") continue;
    if (IN_FLIGHT.has(t.status)) viewStates[view] = "making";
    else if (t.status === "succeeded" && !t.rejected && t.asset && viewStates[view] !== "making")
      viewStates[view] = "made";
  }
  // a view whose newest try failed says so (it can be ticked and made again)
  const lastTry: Record<string, { at: string; error: string | null }> = {};
  for (const t of pictures.takes) {
    const view = referenceSetViewOf(t.settings.intent);
    if (view && (!lastTry[view] || t.createdAt > lastTry[view]!.at))
      lastTry[view] = {
        at: t.createdAt,
        error: t.status === "failed" ? (t.error ?? "It could not be made.") : null,
      };
  }
  const viewFailures: Record<string, string> = {};
  for (const [view, t] of Object.entries(lastTry))
    if (t.error && viewStates[view] === "missing") viewFailures[view] = t.error;
  const viewsQuote = await quoteReferenceViews(
    data,
    c,
    new Set(
      Object.entries(viewStates)
        .filter(([, s]) => s !== "missing")
        .map(([id]) => id),
    ),
    null,
  );
  // how many of the project's generation slots are busy (any subject): views that don't fit wait their turn
  const activeInProject = (await (await getGenerationRepo()).listActiveProjectJobs(data.project.id)).length;
  const archiveSubject = { kind: "character" as const, id: c.id, name: c.name };
  const repo = await getRepo();
  const library = await repo.libraryEntries();
  // the newest "Fill in with Prism" request for this Character (kept with Episode 1), while newer than the sheet
  let aiLatest: WritingProposal | null = null;
  // the newest request of any state: to tell whether the creator edited the sheet after Prism last answered
  let aiLast: WritingProposal | null = null;
  const firstEpisode = [...data.episodes].sort((a, b) => a.number - b.number)[0];
  if (firstEpisode) {
    const writing = await getWritingRepo();
    for (const s of await writing.listSessions(data.project.id, firstEpisode.id))
      for (const p of await writing.listProposals(data.project.id, s.id))
        if (isCharacterRequest(p.instruction, c.id) && (!aiLatest || p.createdAt > aiLatest.createdAt))
          aiLatest = p;
  }
  aiLast = aiLatest;
  if (aiLatest && (aiLatest.status === "rejected" || aiLatest.status === "accepted")) aiLatest = null;
  // Prism's answer fills in the fields left empty at once; what was written stays for review
  const auto = await autoFillCharacter(data, c, aiLatest);
  c = auto.character;
  if (auto.proposalDone) aiLatest = null;
  const saved = library.entries.some((e) => e.characterId === c.id);
  // made on its own (the account's library, in no story): it has no role here, and joins projects from this page
  const inLibrary = data.project.purpose === "library";
  const projects = inLibrary
    ? (await repo.listProjects())
        .filter((p) => p.purpose !== "library")
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((p) => ({ slug: p.slug, title: p.title }))
    : [];

  return (
    <div>
      <PageHeader
        title={c.name}
        subtitle={inLibrary ? "In your library · not part of any project" : c.role}
        actions={
          <div className="flex items-center gap-3">
            <LibraryToggle slug={slug} characterId={c.id} saved={saved} available={library.available} />
            <Badge tone={identityLocked ? "pass" : "warn"}>
              {identityLocked ? "Identity locked" : "Identity open"}
            </Badge>
            <DeleteSubjectButton slug={slug} kind="character" id={c.id} name={c.name} />
          </div>
        }
      />
      <div className="grid gap-4 p-6 xl:grid-cols-2">
        <CharacterAi
          slug={slug}
          character={c}
          inStory={!inLibrary}
          latest={aiLatest}
          fillQuote={quoteCharacterFill(data, c.id, null, { size: "lead" })}
          sizeQuotes={{
            lead: quoteCharacterFill(data, c.id, null, { size: "lead" }),
            supporting: quoteCharacterFill(data, c.id, null, { size: "supporting" }),
            minor: quoteCharacterFill(data, c.id, null, { size: "minor" }),
          }}
          refineQuote={quoteCharacterFill(data, c.id, null, { refine: true })}
          prominent={characterSheetThin(c)}
          filled={auto.filled}
          editedSince={
            !aiLatest &&
            !!aiLast &&
            Date.parse(c.updatedAt) >
              Date.parse(aiLast.decidedAt ?? aiLast.completedAt ?? aiLast.createdAt) + 2_000
          }
        />
        <Panel title="Character">
          {/* keyed by the sheet's version: Prism's filled-in fields show here at once */}
          <ActionForm key={c.updatedAt} action={saveCharacter} className="space-y-3">
            {hidden}
            <input type="hidden" name="id" value={c.id} />
            <Field
              label="Size of part"
              hint={
                inLibrary
                  ? "Each project sets its own when the character is added; here it decides what Prism fills in."
                  : PART_SIZE_HINT[size]
              }
            >
              <select name="partSize" defaultValue={c.partSize ?? "lead"} data-testid="character-part-size">
                {PART_SIZES.map((p) => (
                  <option key={p} value={p}>
                    {PART_SIZE_LABEL[p]}
                  </option>
                ))}
              </select>
            </Field>
            {inLibrary ? (
              <>
                {/* the role is set per project, on each project's copy */}
                <input type="hidden" name="role" value={c.role} />
                <Field label="Name">
                  <input name="name" defaultValue={c.name} />
                </Field>
              </>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <Field label="Name">
                  <input name="name" defaultValue={c.name} />
                </Field>
                <SheetField k="role" size={size} extra="In this project, e.g. Lead — heiress.">
                  <input name="role" defaultValue={c.role} />
                </SheetField>
              </div>
            )}
            <SheetField k="description" size={size}>
              <textarea name="description" rows={2} defaultValue={c.description} />
            </SheetField>
            <SheetField k="personality" size={size}>
              <textarea name="personality" rows={2} defaultValue={c.personality} />
            </SheetField>
            <SheetField k="behaviorNotes" size={size}>
              <textarea name="behaviorNotes" rows={2} defaultValue={c.behaviorNotes} />
            </SheetField>
            <SheetField k="physicalDescription" size={size}>
              <textarea name="physicalDescription" rows={3} defaultValue={c.physicalDescription} />
            </SheetField>
            <SheetField k="signatureBehavior" size={size}>
              <input name="signatureBehavior" defaultValue={c.signatureBehavior} />
            </SheetField>
            {inLibrary ? (
              <input type="hidden" name="relationshipNotes" value={c.relationshipNotes} />
            ) : (
              <SheetField k="relationshipNotes" size={size}>
                <textarea name="relationshipNotes" rows={2} defaultValue={c.relationshipNotes} />
              </SheetField>
            )}
            <SheetField k="continuityRules" size={size} extra="One per line.">
              <textarea name="continuityRules" rows={3} defaultValue={join(c.continuityRules)} />
            </SheetField>
            <Button type="submit" variant="primary">
              Save character
            </Button>
          </ActionForm>
        </Panel>
        <ReferenceViewsPanel
          slug={slug}
          characterId={c.id}
          name={c.name}
          quote={viewsQuote}
          states={viewStates}
          failures={viewFailures}
          photos={ownPhotos}
          studioHref={`/projects/${slug}/studio?subject=character:${c.id}`}
          batchId={randomUUID()}
          atOnce={getGenerationConfig().limits.maxActivePerProject}
          activeInProject={activeInProject}
        />
        {inLibrary ? (
          <div className="xl:col-span-2">
            <UseInProject
              kind="character"
              id={c.id}
              name={c.name}
              projects={projects}
              saved={saved}
              fresh={fresh}
            />
          </div>
        ) : null}
        {/* the picture list only once there is something in it (making the first ones is just below) */}
        {pictures.images.length > 0 || pictures.archived.length > 0 ? (
          <Panel
            title={`Pictures (${pictures.images.length})`}
            className="xl:col-span-2"
            actions={
              <Link
                href={`/projects/${slug}/studio?subject=character:${c.id}`}
                className="text-[12px] text-accent hover:underline"
              >
                Open in the Reference Studio
              </Link>
            }
          >
            <div data-testid="character-pictures">
              {pictures.images.length === 0 ? (
                <p className="text-[12px] text-muted">
                  No pictures yet. Add photos or make one in the Reference Studio.
                </p>
              ) : (
                <ul className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-3">
                  {pictures.images.map((i) => (
                    <li
                      key={i.assetId}
                      className="flex flex-col gap-1"
                      data-testid="character-picture"
                      data-asset={i.assetId}
                    >
                      <div className="aspect-[3/4] overflow-hidden rounded-[3px] border border-line2 bg-[#232326]">
                        {i.url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={i.url} alt={i.label} className="h-full w-full object-cover" />
                        ) : null}
                      </div>
                      <div className="truncate text-[11.5px]" title={i.label}>
                        {i.label}
                      </div>
                      <div className="text-[10.5px] text-muted">
                        {i.roles.length > 0 ? i.roles.join(", ") : i.originLabel}
                        {i.rejected ? " · rejected" : ""}
                      </div>
                      <div className="flex flex-wrap gap-1">
                        <ArchiveButton slug={slug} subject={archiveSubject} assetId={i.assetId} />
                        <DeleteButton slug={slug} subject={archiveSubject} assetId={i.assetId} />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <ArchivedPanel slug={slug} subject={archiveSubject} archived={pictures.archived} />
            </div>
          </Panel>
        ) : null}
        <div className="xl:col-span-2">
          <VisualBiblePanel
            data={data}
            characterId={c.id}
            slug={slug}
            sources={images.sources}
            models={images.models}
          />
        </div>
        <div className="xl:col-span-2">
          <SubjectImagePanel
            projectSlug={slug}
            subject={{ kind: "character", id: c.id, looks: looks.map((l) => ({ id: l.id, name: l.name })) }}
            attempts={images.attempts}
            models={images.models}
            sources={images.sources}
            hostedMatting={images.hostedMatting}
          />
        </div>

        <Panel
          title="Identity references"
          className="xl:col-span-2"
          actions={
            <ActionForm action={setIdentityLocked}>
              {hidden}
              <input type="hidden" name="characterId" value={c.id} />
              <input type="hidden" name="locked" value={String(!identityLocked)} />
              <Button size="sm" type="submit">
                {identityLocked ? "Unlock" : "Lock all"}
              </Button>
            </ActionForm>
          }
        >
          <div className="grid grid-cols-2 gap-3">
            {IDENTITY_SLOTS.filter((s) => s !== "additional").map((slot) => {
              const ref = refs.find((r) => r.slot === slot);
              const asset = data.assets.find((a) => a.id === ref?.assetId);
              const url = assetUrl(asset);
              const origin = url ? referenceOrigin(asset) : null;
              return (
                <div key={slot} data-testid={`identity-slot-${slot}`} className="border border-line p-2">
                  <div className="mb-1 flex items-center justify-between text-[11px] uppercase tracking-wide text-muted">
                    {slot.replace("_", " ")}
                    {ref?.locked ? <Badge tone="pass">locked</Badge> : null}
                  </div>
                  {url ? (
                    <figure>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={url} alt={slot} className="aspect-[3/4] w-full object-cover" />
                      {origin ? (
                        // a generated reference is never presented as a photograph of the Character
                        <figcaption
                          className="mt-0.5 text-[10.5px] text-muted"
                          data-testid="identity-origin"
                          data-origin={origin}
                        >
                          {referenceOriginLabel(asset)}
                        </figcaption>
                      ) : null}
                    </figure>
                  ) : (
                    <FramePlaceholder
                      code={slot}
                      label={asset ? "Placeholder reference" : "Missing"}
                      className="aspect-[3/4]"
                    />
                  )}
                  <ActionForm action={uploadIdentityRef} className="mt-2 flex gap-1">
                    {hidden}
                    <input type="hidden" name="characterId" value={c.id} />
                    <input type="hidden" name="slot" value={slot} />
                    <input
                      data-testid="identity-file"
                      type="file"
                      name="file"
                      accept="image/*"
                      className="!p-0.5 text-[11px]"
                    />
                    <Button data-testid="identity-upload" size="sm" type="submit">
                      Upload
                    </Button>
                  </ActionForm>
                </div>
              );
            })}
          </div>
        </Panel>

        <Panel title={`Looks (${looks.length})`} className="xl:col-span-2">
          <div className="space-y-3">
            {looks.map((l) => (
              <details key={l.id} className="border border-line" open={looks.length === 1}>
                <summary className="flex items-center justify-between px-3 py-2">
                  <span className="font-medium">{l.name}</span>
                  <Badge tone={l.locked ? "pass" : "warn"}>{l.locked ? "locked" : "open"}</Badge>
                </summary>
                <div className="border-t border-line p-3">
                  <ActionForm action={saveLook} className="grid grid-cols-2 gap-3">
                    {hidden}
                    <input type="hidden" name="id" value={l.id} />
                    <input type="hidden" name="characterId" value={c.id} />
                    <input type="hidden" name="episodeId" value={l.episodeId ?? ""} />
                    <Field label="Name" className="col-span-2">
                      <input name="name" defaultValue={l.name} disabled={l.locked} />
                    </Field>
                    {(
                      [
                        ["wardrobe", "Wardrobe"],
                        ["shoes", "Shoes"],
                        ["jewelry", "Jewelry"],
                        ["hair", "Hair"],
                        ["makeup", "Makeup"],
                        ["grooming", "Grooming"],
                        ["bodyNotes", "Body notes"],
                        ["accessories", "Accessories"],
                      ] as const
                    ).map(([k, label]) => (
                      <Field label={label} key={k}>
                        <textarea name={k} rows={2} defaultValue={l[k]} disabled={l.locked} />
                      </Field>
                    ))}
                    <div className="col-span-2 flex gap-2">
                      {!l.locked ? (
                        <Button type="submit" variant="primary">
                          Save look
                        </Button>
                      ) : null}
                    </div>
                  </ActionForm>
                  <div className="mt-2 text-[12px]">
                    <div className="mb-1 text-muted">
                      Look reference images ({l.referenceAssetIds.length})
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {l.referenceAssetIds.map((aid) => {
                        const url = assetUrl(assetsById.get(aid));
                        return url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            key={aid}
                            data-testid="look-ref-thumb"
                            src={url}
                            alt={`${l.name} reference`}
                            className="h-14 border border-line object-cover"
                          />
                        ) : (
                          <span key={aid} className="border border-line px-1 text-[11px] text-muted">
                            placeholder
                          </span>
                        );
                      })}
                    </div>
                    {!l.locked ? (
                      <ActionForm action={uploadLookReference} className="mt-1 flex gap-1">
                        {hidden}
                        <input type="hidden" name="lookId" value={l.id} />
                        <input
                          data-testid="look-ref-file"
                          type="file"
                          name="file"
                          accept="image/*"
                          className="!p-0.5 text-[11px]"
                        />
                        <Button data-testid="look-ref-upload" size="sm" type="submit">
                          Add Look image
                        </Button>
                      </ActionForm>
                    ) : null}
                  </div>
                  <ActionForm action={setLookLocked} className="mt-2">
                    {hidden}
                    <input type="hidden" name="id" value={l.id} />
                    <input type="hidden" name="locked" value={String(!l.locked)} />
                    <Button type="submit">{l.locked ? "Unlock look" : "Lock look"}</Button>
                  </ActionForm>
                </div>
              </details>
            ))}
            <details className="border border-dashed border-line2">
              <summary className="px-3 py-2 text-muted">+ New look</summary>
              <ActionForm action={saveLook} className="grid grid-cols-2 gap-3 border-t border-line p-3">
                {hidden}
                <input type="hidden" name="characterId" value={c.id} />
                <Field label="Name" className="col-span-2">
                  <input name="name" placeholder="Episode 1 / Formal Black" required />
                </Field>
                <Field label="Episode">
                  <select name="episodeId" defaultValue="">
                    <option value="">All episodes</option>
                    {data.episodes.map((e) => (
                      <option key={e.id} value={e.id}>
                        Ep {e.number} — {e.title}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Wardrobe" className="col-span-2">
                  <textarea name="wardrobe" rows={2} />
                </Field>
                <Field label="Shoes">
                  <input name="shoes" />
                </Field>
                <Field label="Jewelry">
                  <input name="jewelry" />
                </Field>
                <Field label="Hair">
                  <input name="hair" />
                </Field>
                <Field label="Makeup">
                  <input name="makeup" />
                </Field>
                <div className="col-span-2">
                  <Button type="submit" variant="primary">
                    Create look
                  </Button>
                </div>
              </ActionForm>
            </details>
          </div>
        </Panel>

        <Panel title={`Continuity Locks (${locks.length})`} className="xl:col-span-2">
          <p className="mb-2 text-[12px] text-muted">
            {CONTINUITY_LOCK_EXPLANATION} A Lock is immutable: it copies today&apos;s identity facts, the
            chosen Look and their stored images, so later edits here never change a Shot that relies on it. No
            images are generated or copied.
          </p>
          <ActionForm
            action={createCharacterContinuityLock}
            className="mb-3 flex flex-wrap items-end gap-2 border border-dashed border-line2 p-2"
          >
            {hidden}
            <input type="hidden" name="characterId" value={c.id} />
            <Field label="Look">
              <select data-testid="cl-look" name="lookId" defaultValue={looks[0]?.id ?? ""}>
                {looks.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
                <option value="">No Look (intentional)</option>
              </select>
            </Field>
            <Field label="Name" className="min-w-[260px] flex-1">
              <input
                data-testid="cl-name"
                name="name"
                required
                maxLength={120}
                defaultValue={`${c.name} — ${looks[0]?.name ?? "No Look"}`}
              />
            </Field>
            <Button data-testid="cl-create" type="submit" variant="primary">
              Create Continuity Lock
            </Button>
          </ActionForm>
          {locks.length === 0 ? (
            <p data-testid="cl-none" className="text-[12px] text-muted">
              No Continuity Locks yet. Shots use {c.name}&apos;s current identity references and Looks.
            </p>
          ) : (
            <div className="space-y-3">
              {lockGroups.map((g) => (
                <div key={g.lookId ?? "none"} data-testid="cl-group" className="space-y-1.5">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">
                    {g.title}
                  </div>
                  {g.locks.map((l) => (
                    <ContinuityLockCard key={l.id} lock={l} assets={assetsById} />
                  ))}
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title={`Voice profiles (${voices.length})`} className="xl:col-span-2">
          <p className="mb-3 text-muted">Data model only — no voice provider is connected yet.</p>
          <div className="space-y-3">
            {[...voices, null].map((v) => (
              <details
                key={v?.id ?? "new"}
                className={v ? "border border-line" : "border border-dashed border-line2"}
              >
                <summary className="flex items-center justify-between px-3 py-2">
                  <span className={v ? "font-medium" : "text-muted"}>
                    {v ? v.name : "+ New voice profile"}
                  </span>
                  {v ? (
                    <span className="flex gap-1.5">
                      <Badge>{v.locale}</Badge>
                      <Badge>{v.provider}</Badge>
                      {v.locked ? <Badge tone="pass">locked</Badge> : null}
                    </span>
                  ) : null}
                </summary>
                <div className="border-t border-line p-3">
                  <ActionForm action={saveVoiceProfile} className="grid grid-cols-2 gap-3">
                    {hidden}
                    <input type="hidden" name="characterId" value={c.id} />
                    {v ? <input type="hidden" name="id" value={v.id} /> : null}
                    <Field label="Name">
                      <input name="name" defaultValue={v?.name ?? ""} required disabled={v?.locked} />
                    </Field>
                    <Field label="Accent">
                      <input name="accent" defaultValue={v?.accent ?? ""} disabled={v?.locked} />
                    </Field>
                    <Field label="Language">
                      <input name="language" defaultValue={v?.language ?? "ja"} disabled={v?.locked} />
                    </Field>
                    <Field label="Locale">
                      <input name="locale" defaultValue={v?.locale ?? ""} disabled={v?.locked} />
                    </Field>
                    <Field label="Provider">
                      <input
                        name="provider"
                        defaultValue={v?.provider ?? "unassigned"}
                        disabled={v?.locked}
                      />
                    </Field>
                    <Field label="Provider voice id">
                      <input
                        name="providerVoiceId"
                        defaultValue={v?.providerVoiceId ?? ""}
                        disabled={v?.locked}
                      />
                    </Field>
                    <Field label="Description" className="col-span-2">
                      <textarea
                        name="description"
                        rows={2}
                        defaultValue={v?.description ?? ""}
                        disabled={v?.locked}
                      />
                    </Field>
                    <Field label="Pitch notes">
                      <input name="pitchNotes" defaultValue={v?.pitchNotes ?? ""} disabled={v?.locked} />
                    </Field>
                    <Field label="Timbre notes">
                      <input name="timbreNotes" defaultValue={v?.timbreNotes ?? ""} disabled={v?.locked} />
                    </Field>
                    <Field label="Speaking style">
                      <input
                        name="speakingStyle"
                        defaultValue={v?.speakingStyle ?? ""}
                        disabled={v?.locked}
                      />
                    </Field>
                    <Field label="Emotional range">
                      <input
                        name="emotionalRange"
                        defaultValue={v?.emotionalRange ?? ""}
                        disabled={v?.locked}
                      />
                    </Field>
                    <Field label="Pronunciation rules" hint="One per line" className="col-span-2">
                      <textarea
                        name="pronunciationRules"
                        rows={2}
                        defaultValue={join(v?.pronunciationRules ?? [])}
                        disabled={v?.locked}
                      />
                    </Field>
                    {!v?.locked ? (
                      <div className="col-span-2">
                        <Button type="submit" variant="primary">
                          {v ? "Save voice" : "Create voice"}
                        </Button>
                      </div>
                    ) : null}
                  </ActionForm>
                  {v ? (
                    <ActionForm action={setVoiceLocked} className="mt-2">
                      {hidden}
                      <input type="hidden" name="id" value={v.id} />
                      <input type="hidden" name="locked" value={String(!v.locked)} />
                      <Button type="submit">{v.locked ? "Unlock voice" : "Lock voice"}</Button>
                    </ActionForm>
                  ) : null}
                </div>
              </details>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}
