import { CharacterPhotoUpload } from "@/components/characters/character-photo-upload";
import { singleUploadLimit } from "@/lib/upload-policy";
import { notFound } from "next/navigation";
import { Badge, Button, Field, PageHeader, Panel } from "@/components/ui";
import { FramePlaceholder } from "@/components/shared";
import {
  CONTINUITY_LOCK_EXPLANATION,
  ContinuityLockCard,
} from "@/components/character-continuity/continuity-lock-ui";
import { referenceOrigin, referenceOriginLabel } from "@/domain/generation/reference-integrity";
import { assetUrl } from "@/lib/utils";
import {
  saveCharacter,
  saveVoiceProfile,
  setIdentityLocked,
  setVoiceLocked,
  uploadIdentityRef,
} from "@/server/actions";
import { createCharacterContinuityLock } from "@/server/character-continuity-actions";
import { getRepo, requireProject, requireProjectFresh } from "@/server/repo";
import { autoAddMadeViews, syncCanonicalToFront, viewSlots } from "@/server/auto-add-views";
import { ActionForm } from "@/components/action-form";
import { VisualBiblePanel } from "@/components/images/visual-bible-panel";
import { subjectImageState } from "@/server/subject-images";
import { ArchiveButton, ArchivedPanel, DeleteButton, DeleteSubjectButton } from "@/components/studio/archive";
import { LibraryToggle } from "@/components/characters/library";
import { UseInProject } from "@/components/library/use-in-project";
import { CharacterAi } from "@/components/characters/character-ai";
import { SheetField } from "@/components/characters/sheet-field";
import { PART_SIZE_HINT, PART_SIZE_LABEL, partSizeOf } from "@/domain/character-ai";
import { PART_SIZES } from "@/domain/schemas";
import type { Asset } from "@/domain/schemas";
import { ReferenceViewsPanel, type ViewState } from "@/components/characters/reference-views";
import { MergeCharacter, type MergeTarget } from "@/components/characters/merge-character";
import { ViewLock } from "@/components/characters/picture-actions";
import { ZoomImage } from "@/components/zoom-image";
import { planCharacterMerge } from "@/domain/character-merge";
import { characterUsage } from "@/domain/subject-trash";
import { REFERENCE_SET_VIEWS, referenceSetViewOf } from "@/domain/generation/reference-studio";
import { quoteReferenceViews, SUGGESTED_VIEWS_MODEL } from "@/server/reference-views";
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

/** The width of a picture's frame at the Pictures height (176 px), in its own shape (kept between 4:5 and 21:9). */
function frameWidth(width: number | null, height: number | null): number {
  const ratio = width && height ? width / height : 3 / 4;
  return Math.round(176 * Math.min(21 / 9, Math.max(0.6, ratio)));
}

export default async function CharacterPage({
  params,
  searchParams,
}: {
  params: Promise<{ project: string; id: string }>;
  searchParams: Promise<{ new?: string; engine?: string; merged?: string }>;
}) {
  const { project: slug, id } = await params;
  const query = await searchParams;
  const fresh = query.new === "1";
  let data = await requireProject(slug);
  // a finished reference view goes into its empty slot in the set by itself (it was made as that view)
  if (data.characters.some((x) => x.id === id) && (await autoAddMadeViews(data, id)).length)
    data = await requireProjectFresh(slug);
  // the front view is always the canonical identity
  if (data.characters.some((x) => x.id === id) && (await syncCanonicalToFront(data, id)))
    data = await requireProjectFresh(slug);
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
  // a view is in the set when ITS slot holds a picture (a canonical identity alone does not fill the front view: the
  // Studio shows the canonical in the front view, but the front reference is its own slot)
  const slots = viewSlots(data, c.id);
  const slotAsset: Record<string, Asset> = {};
  for (const v of REFERENCE_SET_VIEWS) {
    const asset = slots[v.id]?.asset;
    if (asset) slotAsset[v.id] = asset;
    viewStates[v.id] = asset ? "in_set" : "missing";
  }
  // a newer take of a view already in the set: offered beside it (never swapped in by itself)
  const viewNewer: Record<string, { attemptId: string; url: string | null }> = {};
  const takeAt = new Map(pictures.takes.map((t) => [t.attemptId, t.createdAt]));
  for (const t of pictures.takes) {
    const view = referenceSetViewOf(t.settings.intent);
    if (!view) continue;
    if (IN_FLIGHT.has(t.status)) {
      // being made (again, when the view is already in the set: its picture stays until a new take is chosen)
      viewStates[view] = "making";
      continue;
    }
    if (t.status !== "succeeded" || t.rejected || !t.asset) continue;
    if (viewStates[view] === "missing") viewStates[view] = "made";
    const inSlot = slotAsset[view];
    if (inSlot && t.asset.id !== inSlot.id) {
      const slotAttempt = (slots[view]?.ref?.metadata as { attemptId?: unknown } | undefined)?.attemptId;
      const slotAt = typeof slotAttempt === "string" ? (takeAt.get(slotAttempt) ?? "") : "";
      const current = viewNewer[view] ? (takeAt.get(viewNewer[view]!.attemptId) ?? "") : slotAt;
      if (t.createdAt > current) viewNewer[view] = { attemptId: t.attemptId, url: t.asset.url };
    }
  }
  // every finished take of each view that is not the picture in it: the options to choose from, newest first
  const viewTakes: Record<string, Array<{ attemptId: string; url: string | null; engine: string }>> = {};
  for (const t of [...pictures.takes].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    const view = referenceSetViewOf(t.settings.intent);
    if (!view || t.status !== "succeeded" || t.rejected || !t.asset || t.asset.id === slotAsset[view]?.id)
      continue;
    (viewTakes[view] ??= []).push({ attemptId: t.attemptId, url: t.asset.url, engine: t.modelLabel });
  }
  // each view's newest try (any state): what the run tracker follows
  const viewLatest: Record<string, { attemptId: string; status: string }> = {};
  for (const t of pictures.takes) {
    const view = referenceSetViewOf(t.settings.intent);
    if (view && (!viewLatest[view] || t.createdAt > (takeAt.get(viewLatest[view]!.attemptId) ?? "")))
      viewLatest[view] = { attemptId: t.attemptId, status: t.status };
  }
  // each view's picture locked in place, and the generations still running for each view (to stop them)
  const viewLocked: Record<string, boolean> = {};
  for (const v of REFERENCE_SET_VIEWS) viewLocked[v.id] = !!(slots[v.id]?.ref?.locked && slotAsset[v.id]);
  const viewJobs: Record<string, string[]> = {};
  for (const a of images.attempts) {
    const view = referenceSetViewOf((a.attempt.modelSettings as { intent?: string }).intent);
    if (view && a.job && IN_FLIGHT.has(a.job.status) && a.job.status !== "cancel_requested")
      (viewJobs[view] ??= []).push(a.job.id);
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
  // the picture each view has: the one in the set, else the newest finished take waiting to be added
  const viewPictures: Record<
    string,
    { url: string | null; attemptId: string | null; assetId: string | null }
  > = {};
  for (const [view, asset] of Object.entries(slotAsset))
    viewPictures[view] = { url: assetUrl(asset) ?? null, attemptId: null, assetId: asset.id };
  const newestMade: Record<string, string> = {};
  for (const t of pictures.takes) {
    const view = referenceSetViewOf(t.settings.intent);
    if (!view || viewStates[view] !== "made" || t.status !== "succeeded" || t.rejected || !t.asset) continue;
    if (newestMade[view] && newestMade[view]! >= t.createdAt) continue;
    newestMade[view] = t.createdAt;
    viewPictures[view] = { url: t.asset.url, attemptId: t.attemptId, assetId: t.asset.id };
  }
  // the engines that can make the views: they take the photos (or the front view), or, with neither, draw from words
  const engines = pictures.models
    .filter((m) => m.images || m.text)
    .map((m) => ({
      value: m.value,
      label: m.label,
      paid: m.paid,
      available: m.available,
      unavailable: m.unavailable,
    }));
  const usableEngines = engines.filter((e) => e.available);
  const engine =
    usableEngines.find((e) => e.value === query.engine)?.value ??
    usableEngines.find((e) => e.value === SUGGESTED_VIEWS_MODEL)?.value ??
    usableEngines[0]?.value ??
    SUGGESTED_VIEWS_MODEL;
  const viewsQuote = await quoteReferenceViews(
    data,
    c,
    new Set(
      Object.entries(viewStates)
        .filter(([, s]) => s !== "missing")
        .map(([id]) => id),
    ),
    null,
    engine,
  );
  // how many of the project's generation slots are busy (any subject): views that don't fit wait their turn
  const activeInProject = (await (await getGenerationRepo()).listActiveProjectJobs(data.project.id)).length;
  // "Merge into…": the other characters of this project, each with what merging into it would do (or why not)
  const mergeTargets: MergeTarget[] = data.characters
    .filter((x) => x.id !== c.id)
    .map((t) => {
      const plan = (prefer: "merged" | "kept") =>
        planCharacterMerge(data, c.id, t.id, { name: c.name, prefer });
      const merged = plan("merged");
      const kept = plan("kept");
      return {
        id: t.id,
        name: t.name,
        role: t.role,
        usedIn: characterUsage(data, t.id).join("; "),
        preview:
          merged.ok && kept.ok
            ? { merged: merged.plan.summary, kept: kept.plan.summary }
            : { refused: merged.ok ? (kept.ok ? "" : kept.reason) : merged.reason },
      };
    });
  // shown at the top when another character looks like the same person (a name word in common), lower down otherwise
  const nameWords = new Set(c.name.toLowerCase().split(/\s+/).filter(Boolean));
  const likelySame = mergeTargets.some((t) =>
    t.name
      .toLowerCase()
      .split(/\s+/)
      .some((w) => nameWords.has(w)),
  );
  const merge = <MergeCharacter slug={slug} characterId={c.id} name={c.name} targets={mergeTargets} />;
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
        {query.merged === "1" ? (
          <p
            className="rounded-[3px] border border-pass/40 bg-pass/10 px-3 py-2 text-[12.5px] xl:col-span-2"
            data-testid="merged-note"
            role="status"
          >
            Merged. The other character is in the Trash, where it can be restored.
          </p>
        ) : null}
        {likelySame ? merge : null}
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
        <Panel title="2. Character">
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
          newer={viewNewer}
          takes={viewTakes}
          locked={viewLocked}
          jobs={viewJobs}
          latest={viewLatest}
          pictures={viewPictures}
          engines={engines}
          suggestedEngine={SUGGESTED_VIEWS_MODEL}
          photos={ownPhotos}
          photoPreviews={pictures.images
            .filter((i) => i.origin === "uploaded")
            .map((i) => ({ assetId: i.assetId, url: i.url, label: i.label }))}
          photoUpload={
            pictures.selected ? (
              <CharacterPhotoUpload
                slug={slug}
                subject={pictures.selected}
                maxUploadBytes={singleUploadLimit(process.env)}
                hasPhotos={ownPhotos > 0}
              />
            ) : null
          }
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
                <ul className="flex flex-wrap items-start gap-3">
                  {pictures.images.map((i) => (
                    <li
                      key={i.assetId}
                      className="flex flex-col gap-1"
                      // each picture in its own shape, at one height: nothing is cropped and nothing is padded
                      style={{ width: frameWidth(i.inspection.width, i.inspection.height) }}
                      data-testid="character-picture"
                      data-asset={i.assetId}
                    >
                      <div className="h-44 overflow-hidden rounded-[3px] border border-line2 bg-[#1b1b1e]">
                        {i.url ? (
                          <ZoomImage
                            src={i.url}
                            alt={i.label}
                            wrapperClassName="block h-full w-full"
                            className="h-full w-full object-contain"
                            caption={i.label}
                          ></ZoomImage>
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
                        {(() => {
                          const inView = REFERENCE_SET_VIEWS.find((v) => slotAsset[v.id]?.id === i.assetId);
                          return inView ? (
                            <ViewLock
                              slug={slug}
                              characterId={c.id}
                              view={inView.id}
                              locked={!!viewLocked[inView.id]}
                            />
                          ) : null;
                        })()}
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
        {likelySame ? null : merge}
        <div className="xl:col-span-2">
          <VisualBiblePanel
            data={data}
            characterId={c.id}
            slug={slug}
            sources={images.sources}
            models={images.models}
            views={viewsQuote.views.map((v) => ({
              id: v.id,
              label: v.label,
              state: viewStates[v.id] ?? "missing",
              url: viewPictures[v.id]?.url ?? null,
              attemptId: viewPictures[v.id]?.attemptId ?? null,
              assetId: viewPictures[v.id]?.assetId ?? null,
              locked: viewLocked[v.id],
            }))}
          />
        </div>

        <Panel
          title="Reference set: approve and lock"
          className="xl:col-span-2"
          actions={
            <Badge tone={identityLocked ? "pass" : "warn"}>
              {identityLocked ? "Approved, locked" : "Not locked"}
            </Badge>
          }
        >
          <div
            className={
              identityLocked
                ? "mb-3 flex flex-wrap items-center justify-between gap-3 rounded-[3px] border border-pass/40 bg-pass/10 p-3 text-[12.5px]"
                : "mb-3 flex flex-wrap items-center justify-between gap-3 rounded-[3px] border border-accent/50 bg-accent/5 p-3 text-[12.5px]"
            }
            data-testid="identity-lock-box"
          >
            <div className="max-w-[70ch] space-y-1">
              <p className="font-medium">
                {identityLocked
                  ? `${c.name}'s reference set is approved and locked.`
                  : `Happy with these pictures? Approve and lock ${c.name}'s reference set.`}
              </p>
              <p className="text-muted">
                Locking freezes these pictures: every shot keeps using exactly them, and nothing replaces one
                by accident (a new take, an upload or a merge). It is not needed to make shots, but lock the
                set before you approve shots so they all match. You can unlock at any time to change a
                picture.
              </p>
            </div>
            <ActionForm action={setIdentityLocked}>
              {hidden}
              <input type="hidden" name="characterId" value={c.id} />
              <input type="hidden" name="locked" value={String(!identityLocked)} />
              <Button
                size="sm"
                type="submit"
                variant={identityLocked ? undefined : "primary"}
                data-testid="identity-lock"
              >
                {identityLocked ? "Unlock to change" : "Approve and lock the set"}
              </Button>
            </ActionForm>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
            {REFERENCE_SET_VIEWS.map((v) => {
              const ref = slots[v.id]?.ref;
              const asset = slots[v.id]?.asset;
              const url = asset ? assetUrl(asset) : null;
              const origin = url ? referenceOrigin(asset) : null;
              return (
                <div key={v.id} data-testid={`identity-slot-${v.id}`} className="border border-line p-2">
                  <div className="mb-1 flex items-center justify-between text-[11px] uppercase tracking-wide text-muted">
                    {v.label}
                    {v.id === "front" ? <span className="normal-case text-pass">canonical</span> : null}
                    {ref?.locked && asset ? <Badge tone="pass">locked</Badge> : null}
                  </div>
                  {url ? (
                    <figure>
                      <ZoomImage
                        src={url}
                        alt={`${c.name}: ${v.label}`}
                        wrapperClassName="block h-48 w-full rounded-[2px] bg-[#1b1b1e]"
                        className="h-full w-full object-contain"
                        caption={`${c.name} · ${v.label}${ref?.locked ? " · locked" : ""}`}
                      >
                        <ViewLock slug={slug} characterId={c.id} view={v.id} locked={!!ref?.locked} />
                      </ZoomImage>
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
                    <FramePlaceholder code={v.id} label="Missing" className="h-48" />
                  )}
                  {asset ? (
                    <div className="mt-1 flex flex-wrap gap-1">
                      <ViewLock slug={slug} characterId={c.id} view={v.id} locked={!!ref?.locked} />
                    </div>
                  ) : null}
                  {ref?.locked && asset ? null : (
                    <ActionForm action={uploadIdentityRef} className="mt-2 flex flex-col gap-1">
                      {hidden}
                      <input type="hidden" name="characterId" value={c.id} />
                      <input type="hidden" name="slot" value={v.slot} />
                      {v.slot === "additional" ? <input type="hidden" name="view" value={v.id} /> : null}
                      <input type="hidden" name="label" value={v.label} />
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
                  )}
                </div>
              );
            })}
          </div>
        </Panel>

        <Panel
          title={`Looks (${looks.length})`}
          className="xl:col-span-2"
          actions={
            <Link
              href={`/projects/${slug}/looks#looks-${c.id}`}
              className="text-[12px] text-accent hover:underline"
              data-testid="open-looks"
            >
              Edit Looks
            </Link>
          }
        >
          <p className="mb-2 text-[12px] text-muted">
            A Look is an outfit (wardrobe, hair, makeup, accessories) {c.name} wears in some scenes, with its
            own pictures. Looks are made and edited on the Looks page, under Characters in the sidebar.
          </p>
          {looks.length ? (
            <ul className="flex flex-wrap gap-2 text-[12.5px]" data-testid="character-looks">
              {looks.map((l) => (
                <li
                  key={l.id}
                  className="flex items-center gap-1.5 rounded-[3px] border border-line px-2 py-1"
                >
                  {l.name}
                  <Badge tone={l.locked ? "pass" : "warn"}>{l.locked ? "locked" : "open"}</Badge>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[12px] text-faint">No Look yet.</p>
          )}
        </Panel>

        <Panel title={`Continuity Locks (${locks.length})`} className="xl:col-span-2">
          <div
            className="mb-3 space-y-1.5 rounded-[3px] border border-line bg-panel2 p-3 text-[12.5px]"
            data-testid="cl-explainer"
          >
            <p className="font-medium">What is a Continuity Lock?</p>
            <p className="text-muted">
              A saved, frozen snapshot of how {c.name} looks: the written appearance, the outfit (the Look you
              choose) and the exact reference pictures, as they are right now. A shot can be pinned to a Lock,
              so it is always made from that snapshot.
            </p>
            <ul className="list-disc space-y-0.5 pl-5 text-muted">
              <li>
                <span className="text-fg">Why:</span> later changes here (a new canonical, a remade view, an
                edited outfit) never change a shot pinned to a Lock, so shots you approved keep matching each
                other.
              </li>
              <li>
                <span className="text-fg">When:</span> once you are happy with {c.name}&apos;s look and start
                making and approving shots. While you are still designing the character, you don&apos;t need
                one.
              </li>
              <li>
                <span className="text-fg">How:</span> choose a Look below and save a Lock; then pin shots to
                it in Shot Prep. A Lock can&apos;t be edited: to change the look, save a new one and pin the
                shots you want to it.
              </li>
            </ul>
            <p className="text-[11px] text-faint">
              {CONTINUITY_LOCK_EXPLANATION} Saving a Lock copies no pictures and makes nothing.
            </p>
          </div>
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
