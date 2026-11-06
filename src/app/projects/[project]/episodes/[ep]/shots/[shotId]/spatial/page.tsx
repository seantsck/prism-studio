import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { CopySetupPanel } from "@/components/previs/copy-setup-panel";
import { VirtualSetLoader } from "@/components/previs/virtual-set-loader";
import { availableSetup, SETUP_COMPONENT_LABEL, SETUP_COMPONENTS } from "@/domain/previs/setup-copy";
import { templateParts } from "@/domain/previs/setup-template";
import { shotPrepSetHref } from "@/domain/previs/spatial-workspace";
import { shotPath } from "@/lib/paths";
import { getPrevisRepo } from "@/server/previs";
import { requireProject } from "@/server/repo";
import { loadVirtualSetProps } from "@/server/virtual-set-props";

export const dynamic = "force-dynamic";

/**
 * Phase 4C-I2: the Shot-centric Spatial Workspace. The ROUTE owns the Shot (there is no Shot selector here), and the
 * Shot's CURRENT Location decides the one set it opens (`shot.spatial.locationId` -> that Location's
 * `location_scene_documents` row). Location assignment stays a Shot Prep operation, so this page can never change
 * story intent. 3D stays optional: with no Location the editor is not mounted at all and nothing is created.
 */
export default async function ShotSpatialWorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ project: string; ep: string; shotId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { project: slug, ep, shotId } = await params;
  const query = await searchParams;
  const data = await requireProject(slug);
  const episode = data.episodes.find((e) => e.slug === ep);
  const shot = data.shots.find((s) => s.id === shotId);
  if (!episode || !shot || shot.episodeId !== episode.id) notFound();

  const prepHref = shotPath(slug, episode.slug, shot.id);
  const location = shot.spatial.locationId
    ? (data.locations.find((l) => l.id === shot.spatial.locationId) ?? null)
    : null;
  const header = (
    <>
      <PageHeader
        title={`Spatial Workspace — Shot ${shot.shotCode}`}
        subtitle={`Episode ${episode.number} · ${episode.title}${location ? ` · ${location.name}` : ""}. Frame this Shot's camera, block and light it, capture a Master Frame, and choose a Production Frame.`}
      />
      <div className="flex gap-3 px-6 pb-1 text-xs text-muted">
        <Link href={prepHref} className="underline" data-testid="back-to-shot-prep">
          ← Shot Prep
        </Link>
      </div>
    </>
  );

  if (!location) {
    return (
      <div>
        {header}
        <div
          className="m-6 border border-dashed border-line2 p-4 text-sm"
          data-testid="workspace-no-location"
        >
          <p className="font-medium">Assign a Location to use optional spatial tools.</p>
          <p className="mt-1 text-[12px] text-muted">
            3D is optional. This Shot&apos;s Production Frame can come from its Storyboard, an upload or
            generated candidates without any 3D Set.
          </p>
          <Link
            href={shotPrepSetHref(slug, episode.slug, shot.id)}
            className="mt-2 inline-block text-[12px] text-accent underline"
            data-testid="assign-location-link"
          >
            Choose this Shot&apos;s Location
          </Link>
        </div>
      </div>
    );
  }

  const previs = await getPrevisRepo();
  const props = await loadVirtualSetProps({
    slug,
    data,
    previs,
    location,
    activeShotId: shot.id,
    context: { kind: "shot", shotPrepHref: prepHref },
  });

  // Phase 4D: other Shots set in the SAME Location are the only copy sources (coordinates mean nothing elsewhere)
  const episodeNumber = new Map(data.episodes.map((e) => [e.id, e.number]));
  const sources = data.shots
    .filter((s) => s.id !== shot.id && s.spatial.locationId === location.id)
    .map((s) => ({
      id: s.id,
      label: `Shot ${s.shotCode} · Episode ${episodeNumber.get(s.episodeId) ?? "?"}`,
    }));
  // the one-time notice after a copy; the source is resolved here, never echoed from the URL
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const copiedFrom = data.shots.find((s) => s.id === one(query.copiedFrom)) ?? null;
  const copiedParts = SETUP_COMPONENTS.filter((c) => one(query.copied).split(",").includes(c));

  // Phase 4D-I2: named templates on this set (null before migration 0050), what this Shot can save, its copy history.
  // None of this is read by the editor, capture, promotion or the package: it only feeds the copy panel.
  // a template problem must never block this Shot's editor: on any failure the library is hidden, the editor still opens
  let templatesReady = false;
  let templateRecords: Awaited<ReturnType<typeof previs.listSetupTemplates>> = [];
  let copyRecords: Awaited<ReturnType<typeof previs.listSetupCopies>> = [];
  try {
    templatesReady = await previs.setupTemplatesReady();
    if (templatesReady) {
      templateRecords = await previs.listSetupTemplates(data.project.id, location.id);
      copyRecords = await previs.listSetupCopies(data.project.id, shot.id);
    }
  } catch (err) {
    templatesReady = false;
    console.error("[setup-templates] unavailable for this page:", err instanceof Error ? err.message : err);
  }
  const scene = await previs.getSceneForLocation(location.id);
  const ownAvailable = scene
    ? availableSetup(
        {
          camera: await previs.getBookmarkForShot(shot.id),
          lighting: await previs.getLightingRigForShot(shot.id),
          blocking: await previs.listShotBlocking(shot.id),
        },
        { locationId: location.id, sceneDocumentId: scene.id },
      )
    : { camera: false, lighting: false, blocking: false };
  const templates = templatesReady
    ? templateRecords
        .filter((t) => scene && t.sceneDocumentId === scene.id)
        .map((t) => ({
          id: t.id,
          name: t.name,
          description: t.description,
          revision: t.revision,
          parts: templateParts(t.content),
          contentFingerprint: t.contentFingerprint,
          sourceShotCode: t.sourceShotCode,
          updatedAt: t.updatedAt,
        }))
    : null;
  const copies = copyRecords.slice(0, 5);
  const partsText = (ps: readonly string[]) =>
    SETUP_COMPONENTS.filter((c) => ps.includes(c))
      .map((c) => SETUP_COMPONENT_LABEL[c].toLowerCase())
      .join(", ");
  const history = copies.map((c) => ({
    id: c.id,
    text:
      c.sourceKind === "template"
        ? `${partsText(c.components)} copied from template “${c.templateName}” (revision ${c.templateRevision})${c.templateId ? "" : " — template since deleted"} · ${c.copiedAt.slice(0, 16).replace("T", " ")}`
        : `${partsText(c.components)} copied from Shot ${c.sourceShotCode}${c.sourceShotId ? "" : " — Shot since deleted"} · ${c.copiedAt.slice(0, 16).replace("T", " ")}`,
  }));
  const copiedTemplate =
    templatesReady && one(query.copiedTemplate)
      ? (templateRecords.find((t) => t.id === one(query.copiedTemplate)) ?? null)
      : null;

  return (
    <div>
      {header}
      {copiedFrom && copiedParts.length > 0 ? (
        <div
          className="mx-6 mb-3 rounded-[3px] border border-line2 p-2 text-[12px]"
          role="status"
          data-testid="copy-setup-done"
        >
          Copied {copiedParts.map((c) => SETUP_COMPONENT_LABEL[c].toLowerCase()).join(", ")} from Shot{" "}
          {copiedFrom.shotCode}. Shot {shot.shotCode} now owns its own copy: editing or deleting Shot{" "}
          {copiedFrom.shotCode} will not change it.
        </div>
      ) : null}
      {copiedTemplate && copiedParts.length > 0 ? (
        <div
          className="mx-6 mb-3 rounded-[3px] border border-line2 p-2 text-[12px]"
          role="status"
          data-testid="copy-setup-done"
        >
          Copied {copiedParts.map((c) => SETUP_COMPONENT_LABEL[c].toLowerCase()).join(", ")} from{" "}
          {copiedTemplate.name}; this Shot now owns its own copy. Editing or deleting the template will not
          change it.
        </div>
      ) : null}
      <CopySetupPanel
        projectSlug={slug}
        shotId={shot.id}
        shotCode={shot.shotCode}
        sources={sources}
        templates={templates}
        ownAvailable={ownAvailable}
        history={history}
      />
      {/* keyed by the Shot AND its current Location: either change remounts one clean editor + adapter */}
      <VirtualSetLoader key={`${location.id}:${shot.id}`} {...props} />
    </div>
  );
}
