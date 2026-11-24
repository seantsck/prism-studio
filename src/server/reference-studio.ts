import "server-only";
import { pictureOwnersOf } from "@/domain/character-merge";
import { userPrice } from "@/domain/pricing/user-price";
import type { SubjectAttemptView } from "@/data/generation-repository";
import { archiveOf, isArchived } from "@/domain/archive";
import { isTrashed } from "@/domain/trash";
import { findAssetUsage } from "@/domain/asset-usage";
import { catalogModel } from "@/domain/generation/models/catalog";
import {
  referenceOrigin,
  referenceOriginLabel,
  type ReferenceOrigin,
} from "@/domain/generation/reference-integrity";
import {
  inspectReferenceImage,
  offersTestModels,
  REFERENCE_SET_VIEWS,
  type ReferenceSetViewId,
  type CostSample,
  type ReferenceInspection,
} from "@/domain/generation/reference-studio";
import { REJECTION_LABELS, type RejectionCategory } from "@/domain/generation/schemas";
import {
  hasStoredImage,
  SUBJECT_IMAGE_INTENT_LABEL,
  type SubjectImageIntent,
} from "@/domain/generation/subject-image";
import { locationBibleAssetIds, locationBibleOf } from "@/domain/location-visual-bible";
import type { Asset, ProjectData } from "@/domain/schemas";
import { expressionOf, visualRoleOf } from "@/domain/visual-bible";
import { MOCK_PROVIDER_ID } from "@/generation/providers/mock";
import { PHOTOROOM_PROVIDER_ID } from "@/generation/providers/photoroom/config";
import { PRISM_MATTING_PROVIDER_ID } from "@/generation/providers/prism-matting/adapter";
import { assetUrl } from "@/lib/utils";
import { getGenerationConfig, getGenerationRepo, getRegistry } from "./generation";
import { hostedMattingOffer, type HostedMattingOffer } from "./subject-images";

/**
 * The Reference Studio's read model: everything one screen needs to turn a reference photograph into production
 * references for ONE Character or Location. It reads the records the image pipeline already keeps (attempts, outputs,
 * costs, identity references, Looks, the Location Visual Bible, asset usage); it stores nothing of its own, and reading
 * never starts work.
 */
export interface StudioSubject {
  kind: "character" | "location";
  id: string;
  name: string;
  detail: string;
  thumbUrl: string | null;
  /** Stored images this subject already has (references and finished generated images). */
  images: number;
}

/** One stored image of the subject: something a new picture can start from. */
export interface StudioImage {
  assetId: string;
  url: string | null;
  /** "Reference photo", "Generated #3 · 3/4 view" … */
  label: string;
  origin: ReferenceOrigin | null;
  /** "uploaded original" / "generated reference" / … (a generated picture is never presented as a photograph) */
  originLabel: string;
  /** What the Visual Bible uses it as: "Canonical identity", "Front reference", 'Look "Formal Black"' … */
  roles: string[];
  /** true: it is only a Look's wardrobe picture (it shows what is worn, not who the Character is). */
  wardrobeOnly: boolean;
  /** true: it currently stands for the subject (canonical identity, or canonical location). */
  canonical: boolean;
  /** When it was stored (ISO). */
  addedAt: string;
  /** true: a test model made it. It is a placeholder pattern, not a picture of the subject. */
  test: boolean;
  inspection: ReferenceInspection;
  /** Where the project uses it ("used in 3 shots"), and each direct use. */
  usage: { summary: string; lines: string[] };
  /** The attempt that made it, when Prism generated it. */
  attemptId: string | null;
  /** Rejected in review: kept in history, not offered as a starting image. */
  rejected: boolean;
}

/** A picture archived from this subject: out of the Studio's lists and never sent, until it is restored. */
export interface StudioArchivedImage {
  assetId: string;
  url: string | null;
  label: string;
  archivedAt: string;
  /** The take that made it, when Prism generated it. */
  takeNumber: number | null;
  /** Delete permanently is offered (nothing depends on it). Re-checked by the action. */
  deletable: boolean;
  /** Why it is kept when it can't be deleted: one plain sentence. */
  keptBecause: string | null;
}

export interface StudioTake {
  attemptId: string;
  number: number;
  status: string;
  rejected: boolean;
  rejection: string | null;
  /** "3/4 view", "Change", "Cutout" */
  what: string;
  operation: "text" | "reference" | "edit" | "cutout";
  provider: string;
  model: string;
  modelLabel: string;
  /** true: a test model made it. Its result is a placeholder pattern, never a real picture. */
  test: boolean;
  createdAt: string;
  asset: {
    id: string;
    url: string | null;
    width: number | null;
    height: number | null;
    hasAlpha: boolean;
  } | null;
  paid: boolean;
  estimateUsd: number | null;
  actualUsd: number | null;
  /** The images that were sent, in order. */
  inputs: Array<{ assetId: string; label: string; url: string | null }>;
  /** The prompt frozen on the attempt. */
  prompt: string;
  error: string | null;
  /** The local cutout tool refused a busy background (the paid one may be offered). */
  cutoutRefused: boolean;
  /** What the Visual Bible already uses this result as. */
  roles: string[];
  /** Enough to load the same request back into the composer. */
  settings: {
    intent: string;
    lookId: string | null;
    aspectRatio: string | null;
    quality: string | null;
    transparent: boolean;
    sourceAssetIds: string[];
    editSourceAssetId: string | null;
    composer: Record<string, string>;
  };
}

export interface StudioModel {
  value: string;
  provider: string;
  modelId: string;
  label: string;
  available: boolean;
  /** Why it cannot be chosen, in the creator's words (empty when available). */
  unavailable: string;
  paid: boolean;
  /** A local test model: it makes a placeholder pattern, never a real picture. */
  test: boolean;
  /** It can make a picture from words alone. */
  text: boolean;
  /** It can be given images (references, or an image to change). */
  images: boolean;
  maxImages: number;
  transparency: boolean;
  formats: string[];
  qualities: Array<{ id: string; label: string; note: string }>;
  defaultQuality: string | null;
}

/** A Shot this subject appears in: where its references are turned into a Production Frame. */
export interface StudioShot {
  id: string;
  code: string;
  href: string;
  /** The Shot already has a selected Production Frame. */
  hasFrame: boolean;
}

/** One view of a Character's reference set (see REFERENCE_SET_VIEWS). */
export interface StudioSetView {
  id: ReferenceSetViewId;
  label: string;
  /** The preset that makes this view. */
  intent: string;
  /** true: the front view, which is the canonical identity. */
  canonical: boolean;
  /** The picture in this view, or null. */
  assetId: string | null;
  url: string | null;
  /** "your photo", "take #10", "generated picture" */
  from: string | null;
  /** true: a locked slot holding an image (it is not replaced from the Studio). */
  locked: boolean;
}

export interface StudioState {
  subjects: StudioSubject[];
  selected:
    | (StudioSubject & {
        /** A locked Location: its references and Visual Bible cannot change until it is unlocked. */
        locked: boolean;
        looks: Array<{
          id: string;
          name: string;
          references: number;
          locked: boolean;
          /** The Look's (first) picture: it is sent with every Shot in this Look. */
          pictureUrl: string | null;
          pictureAssetId: string | null;
        }>;
        /** Identity slots that already hold a stored image (replacing one is confirmed, never one click). */
        filledSlots: string[];
        /** A Character's written appearance: what a picture made from words alone is made from. */
        appearance: string;
        /** What the Bible says about who the Character is (role, description, personality), for context. */
        about: string;
      })
    | null;
  images: StudioImage[];
  takes: StudioTake[];
  models: StudioModel[];
  hostedMatting: HostedMattingOffer;
  /** What finished images in this project were really billed: the honest companion to an upper-bound estimate. */
  costHistory: CostSample[];
  /**
   * Real money billed for this subject's images so far, and how many images that was; `charged` is what the creator
   * was charged for them (each image's price shown before it ran: src/domain/pricing/user-price.ts).
   */
  spent: { usd: number; images: number; charged: number };
  /** The Shots this subject appears in, in story order (the next step after references: a Production Frame). */
  shots: StudioShot[];
  /** A Character's reference set (empty for a Location). */
  referenceSet: StudioSetView[];
  /** Pictures archived from this subject, newest first. */
  archived: StudioArchivedImage[];
}

const stored = (a: Asset | undefined): a is Asset => hasStoredImage(a);

/**
 * The image models of this deployment, and whether its test models are offered at all (see `offersTestModels`). A real
 * model is always listed, with the reason when it cannot be used; a test model only where it is offered and switched
 * on.
 */
function studioModels(): { models: StudioModel[]; testModels: boolean } {
  const listed = everyImageModel();
  const testModels = offersTestModels(listed, getGenerationConfig().mock.showBesideRealModels === true);
  return { models: listed.filter((m) => !m.test || (testModels && m.available)), testModels };
}

function everyImageModel(): StudioModel[] {
  const registry = getRegistry();
  return registry
    .models()
    .filter(
      (m) =>
        m.capabilities.image &&
        // background removal is its own action, never a generation or edit model
        m.provider !== PRISM_MATTING_PROVIDER_ID &&
        m.provider !== PHOTOROOM_PROVIDER_ID &&
        (m.capabilities.modalities.includes("text_to_image") ||
          m.capabilities.modalities.includes("image_to_image")),
    )
    .map((m) => {
      const a = registry.availabilityOf(m);
      const cat = catalogModel(m.provider, m.modelId);
      const images =
        m.capabilities.modalities.includes("image_to_image") && m.capabilities.references.referenceImages;
      return {
        value: `${m.provider}/${m.modelId}`,
        provider: m.provider,
        modelId: m.modelId,
        label: m.displayName,
        available: a.available,
        unavailable: a.available
          ? ""
          : !a.enabled
            ? "not switched on for this server"
            : a.missingConfig.length
              ? "not set up on this server"
              : !a.paidGenerationEnabled
                ? "paid generation is switched off"
                : "not available right now",
        paid: registry.billsMoney(m),
        test: m.kind === "mock",
        text: m.capabilities.modalities.includes("text_to_image"),
        images,
        maxImages: images ? m.capabilities.references.maxReferences : 0,
        transparency: m.capabilities.image!.transparency,
        formats: m.capabilities.image!.aspectRatios,
        qualities: cat?.image?.qualities ?? [],
        defaultQuality: cat?.image?.defaultQuality ?? null,
      };
    });
}

/** The quality a request really ran at: the one it named, else the model's own default. */
function qualityOf(provider: string, model: string, settings: unknown): string | null {
  const named = (settings as { providerOptions?: { quality?: unknown } } | null)?.providerOptions?.quality;
  return typeof named === "string" && named
    ? named
    : (catalogModel(provider, model)?.image?.defaultQuality ?? null);
}

const actualOf = (v: SubjectAttemptView) => v.costs.find((c) => c.kind === "actual")?.amount ?? null;
const estimateOf = (v: SubjectAttemptView) => v.costs.find((c) => c.kind === "estimated")?.amount ?? null;
const primaryOf = (v: SubjectAttemptView) =>
  v.outputs.find((o) => o.output.role === "primary") ?? v.outputs[0];

function studioShots(data: ProjectData, subject: Pick<StudioSubject, "kind" | "id">): StudioShot[] {
  const scenes = new Map(data.scenes.map((sc) => [sc.id, sc]));
  const episodes = new Map(data.episodes.map((e) => [e.id, e]));
  const framed = new Set((data.productionFrameSelections ?? []).map((s) => s.shotId));
  return data.shots
    .filter((s) =>
      subject.kind === "character"
        ? s.characters.some((c) => c.characterId === subject.id)
        : s.spatial.locationId === subject.id,
    )
    .flatMap((s) => {
      const episode = episodes.get(scenes.get(s.sceneId)?.episodeId ?? "");
      return episode
        ? [
            {
              id: s.id,
              code: s.shotCode,
              href: `/projects/${data.project.slug}/episodes/${episode.slug}/shots/${s.id}`,
              hasFrame: framed.has(s.id),
              order: [episode.order, s.shotCode] as const,
            },
          ]
        : [];
    })
    .sort(
      (a, b) => a.order[0] - b.order[0] || a.order[1].localeCompare(b.order[1], undefined, { numeric: true }),
    )
    .map((s) => ({ id: s.id, code: s.code, href: s.href, hasFrame: s.hasFrame }));
}

export function parseSubjectParam(
  raw: string | undefined,
): { kind: "character" | "location"; id: string } | null {
  const [kind, ...rest] = (raw ?? "").split(":");
  const id = rest.join(":");
  return (kind === "character" || kind === "location") && id ? { kind, id } : null;
}

export async function referenceStudioState(
  loaded: ProjectData,
  subjectParam: string | undefined,
): Promise<StudioState> {
  // a picture in the Trash is out of the Studio, as if deleted (the server loaders set it apart already)
  const trashedIds = new Set([
    ...(loaded.trashedAssets ?? []).map((a) => a.id),
    ...loaded.assets.filter(isTrashed).map((a) => a.id),
  ]);
  const data = loaded.assets.some(isTrashed)
    ? { ...loaded, assets: loaded.assets.filter((a) => !isTrashed(a)) }
    : loaded;
  const repo = await getGenerationRepo({ startInlineWorker: false });
  const registry = getRegistry();
  const { models, testModels } = studioModels();
  const assets = new Map(data.assets.map((a) => [a.id, a]));
  /** true: a test model made it, so its result is a coloured pattern, not a picture. */
  const madeByTestModel = (v: SubjectAttemptView) =>
    v.attempt.provider === MOCK_PROVIDER_ID ||
    registry.model(v.attempt.provider, v.attempt.model)?.kind === "mock";
  // Where test models are not offered, neither is what they made: a test pattern is not a picture of anything, and
  // the creator did not ask to see it. Nothing is deleted (the attempts and their files stay), and a pattern the
  // Visual Bible uses stays in view, so it can be seen for what it is and replaced.
  const inVisualBible = new Set<string>();
  for (const r of data.identityRefs) if (r.assetId) inVisualBible.add(r.assetId);
  for (const l of data.looks) for (const id of l.referenceAssetIds) inVisualBible.add(id);
  for (const l of data.locations)
    for (const id of [...l.referenceAssetIds, ...locationBibleAssetIds(l)]) inVisualBible.add(id);
  const everyAttempt = await repo.listProjectSubjectImageAttempts(data.project.id);
  const all = testModels
    ? everyAttempt
    : everyAttempt.filter((v) => !madeByTestModel(v) || v.outputs.some((o) => inVisualBible.has(o.asset.id)));
  // a take whose picture is archived, or in the Trash (not among the project's assets), is not a finished picture here
  const finished = (v: SubjectAttemptView) =>
    v.attempt.status === "succeeded" &&
    !!primaryOf(v) &&
    assets.has(primaryOf(v)!.asset.id) &&
    !isArchived(assets.get(primaryOf(v)!.asset.id));

  const characterImages = (id: string) => {
    const ids = new Set<string>();
    for (const r of data.identityRefs)
      if (r.characterId === id && r.assetId && stored(assets.get(r.assetId))) ids.add(r.assetId);
    for (const l of data.looks)
      if (l.characterId === id) for (const a of l.referenceAssetIds) if (stored(assets.get(a))) ids.add(a);
    const owners = pictureOwnersOf(loaded, id);
    for (const v of all)
      if (
        v.attempt.characterId &&
        owners.has(v.attempt.characterId) &&
        finished(v) &&
        v.attempt.reviewStatus !== "rejected"
      )
        ids.add(primaryOf(v)!.asset.id);
    return ids;
  };
  const locationImages = (id: string) => {
    const ids = new Set<string>();
    const loc = data.locations.find((l) => l.id === id);
    for (const a of loc?.referenceAssetIds ?? []) if (stored(assets.get(a))) ids.add(a);
    for (const v of all)
      if (v.attempt.locationId === id && finished(v) && v.attempt.reviewStatus !== "rejected")
        ids.add(primaryOf(v)!.asset.id);
    return ids;
  };

  const subjects: StudioSubject[] = [
    ...data.characters.map((c) => {
      const canonical = data.identityRefs.find(
        (r) => r.characterId === c.id && visualRoleOf(r) === "canonical",
      );
      const images = characterImages(c.id);
      const thumb =
        (canonical?.assetId && stored(assets.get(canonical.assetId)) ? canonical.assetId : null) ??
        [...images][0] ??
        null;
      return {
        kind: "character" as const,
        id: c.id,
        name: c.name,
        detail: c.role,
        thumbUrl: thumb ? assetUrl(assets.get(thumb)) : null,
        images: images.size,
      };
    }),
    ...data.locations.map((l) => {
      const bible = locationBibleOf(l);
      const images = locationImages(l.id);
      const thumb =
        (bible.canonicalAssetId && stored(assets.get(bible.canonicalAssetId))
          ? bible.canonicalAssetId
          : null) ??
        [...images][0] ??
        null;
      return {
        kind: "location" as const,
        id: l.id,
        name: l.name,
        detail: "Location",
        thumbUrl: thumb ? assetUrl(assets.get(thumb)) : null,
        images: images.size,
      };
    }),
  ];

  const want = parseSubjectParam(subjectParam);
  const base = want ? (subjects.find((s) => s.kind === want.kind && s.id === want.id) ?? null) : null;
  // real money only: a free test model reports a pretend cost, which is never shown as billed
  const bills = (v: SubjectAttemptView) => {
    const m = registry.model(v.attempt.provider, v.attempt.model);
    return m ? registry.billsMoney(m) : true;
  };
  const costHistory: CostSample[] = all.flatMap((v) => {
    const actual = actualOf(v);
    if (v.attempt.status !== "succeeded" || actual == null || !bills(v)) return [];
    return [
      {
        provider: v.attempt.provider,
        model: v.attempt.model,
        quality: qualityOf(v.attempt.provider, v.attempt.model, v.attempt.modelSettings),
        references: v.attempt.inputAssetIds.length,
        actualUsd: actual,
      },
    ];
  });
  if (!base) {
    return {
      subjects,
      selected: null,
      images: [],
      takes: [],
      models,
      hostedMatting: hostedMattingOffer(),
      costHistory,
      spent: { usd: 0, images: 0, charged: 0 },
      shots: [],
      referenceSet: [],
      archived: [],
    };
  }

  const character = base.kind === "character" ? data.characters.find((c) => c.id === base.id) : undefined;
  // a Character's own takes, and those of every Character merged into it (they keep their record, so are found here)
  const owners = base.kind === "character" ? pictureOwnersOf(loaded, base.id) : null;
  const own = all.filter((v) =>
    owners ? !!v.attempt.characterId && owners.has(v.attempt.characterId) : v.attempt.locationId === base.id,
  );
  const location = base.kind === "location" ? data.locations.find((l) => l.id === base.id) : undefined;
  const bible = location ? locationBibleOf(location) : null;
  const refs = base.kind === "character" ? data.identityRefs.filter((r) => r.characterId === base.id) : [];
  const looks = base.kind === "character" ? data.looks.filter((l) => l.characterId === base.id) : [];

  /** What the Visual Bible uses an image as, in the product's words. */
  const rolesOf = (assetId: string): string[] => {
    const out: string[] = [];
    for (const r of refs.filter((x) => x.assetId === assetId)) {
      const role = visualRoleOf(r);
      out.push(
        role === "canonical"
          ? "Canonical identity"
          : role === "cutout"
            ? "Cutout"
            : role === "expression"
              ? `Expression: ${expressionOf(r) ?? "expression"}`
              : r.slot === "additional"
                ? "Reference"
                : `${r.slot.replace("_", " ").replace(/^./, (c) => c.toUpperCase())} reference`,
      );
    }
    for (const l of looks) if (l.referenceAssetIds.includes(assetId)) out.push(`Look "${l.name}"`);
    if (bible?.canonicalAssetId === assetId) out.push("Canonical location");
    for (const e of bible?.entries ?? [])
      if (e.assetId === assetId)
        out.push(
          e.role === "plate" ? "Background plate" : e.role === "establishing" ? "Establishing view" : e.label,
        );
    if (location?.referenceAssetIds.includes(assetId) && out.length === 0) out.push("Location reference");
    return [...new Set(out)];
  };

  const images: StudioImage[] = [];
  const addImage = (assetId: string | null, label: string, view: SubjectAttemptView | null) => {
    const a = assetId ? assets.get(assetId) : undefined;
    if (!stored(a) || isArchived(a) || images.some((x) => x.assetId === a.id)) return;
    const usage = findAssetUsage(data, a.id);
    const origin = referenceOrigin(a);
    images.push({
      assetId: a.id,
      url: assetUrl(a),
      label,
      origin,
      originLabel: referenceOriginLabel(a),
      roles: rolesOf(a.id),
      wardrobeOnly:
        !refs.some((r) => r.assetId === a.id) && looks.some((l) => l.referenceAssetIds.includes(a.id)),
      canonical:
        refs.some((r) => r.assetId === a.id && visualRoleOf(r) === "canonical") ||
        bible?.canonicalAssetId === a.id,
      addedAt: a.createdAt,
      test: view ? madeByTestModel(view) : false,
      inspection: inspectReferenceImage(a),
      usage: { summary: usage.summary, lines: usage.direct.map((u) => u.label) },
      attemptId: view?.attempt.id ?? null,
      rejected: view?.attempt.reviewStatus === "rejected",
    });
  };
  // the creator's own photographs first, then what Prism made from them (newest first)
  if (base.kind === "character") {
    for (const r of refs) {
      const a = r.assetId ? assets.get(r.assetId) : undefined;
      if (referenceOrigin(a) === "uploaded") addImage(r.assetId, a?.name || "Reference photo", null);
    }
    for (const l of looks)
      for (const id of l.referenceAssetIds)
        if (referenceOrigin(assets.get(id)) === "uploaded")
          addImage(id, assets.get(id)?.name || `Look "${l.name}"`, null);
  } else {
    for (const id of location?.referenceAssetIds ?? [])
      if (referenceOrigin(assets.get(id)) === "uploaded")
        addImage(id, assets.get(id)?.name || "Reference photo", null);
  }
  const whatOf = (v: SubjectAttemptView): { what: string; operation: StudioTake["operation"] } => {
    const s = v.attempt.modelSettings as {
      intent?: string;
      purpose?: string;
      operation?: string;
      editSourceAssetId?: string;
    };
    if (s.purpose === "background_removal") return { what: "Cutout", operation: "cutout" };
    if (s.editSourceAssetId) return { what: "Change", operation: "edit" };
    const label = SUBJECT_IMAGE_INTENT_LABEL[s.intent as SubjectImageIntent] ?? "Image";
    return {
      what: label,
      operation: s.operation === "reference" || v.attempt.inputAssetIds.length > 0 ? "reference" : "text",
    };
  };
  for (const v of own) {
    const out = primaryOf(v);
    if (v.attempt.status === "succeeded" && out)
      addImage(out.asset.id, `Generated #${v.attempt.attemptNumber} · ${whatOf(v).what}`, v);
  }
  // any remaining stored reference that is neither an upload nor one of this subject's own results (seeded, imported)
  if (base.kind === "character") {
    for (const r of refs) addImage(r.assetId, r.label || "Reference", null);
    for (const l of looks) for (const id of l.referenceAssetIds) addImage(id, `Look "${l.name}"`, null);
  } else for (const id of location?.referenceAssetIds ?? []) addImage(id, "Reference", null);

  const labelOf = new Map(images.map((i) => [i.assetId, i.label]));
  const archivedOutput = (v: SubjectAttemptView) => {
    const out = primaryOf(v);
    return !!out && isArchived(assets.get(out.asset.id));
  };
  // a take whose picture was deleted (or is in the Trash) leaves the list (its cost still counts in what was spent)
  const deletedOutput = (v: SubjectAttemptView) =>
    v.attempt.status === "succeeded" && (!primaryOf(v) || !assets.has(primaryOf(v)!.asset.id));
  const takes: StudioTake[] = own
    .filter((v) => !archivedOutput(v) && !deletedOutput(v))
    .map((v) => {
      const out = primaryOf(v);
      const s = v.attempt.modelSettings as {
        intent?: string;
        aspectRatio?: string;
        editSourceAssetId?: string;
        backgroundRemovalSourceAssetId?: string;
        sourceAssetIds?: string[];
        composer?: Record<string, string>;
        providerOptions?: { quality?: string; background?: string };
      };
      const request = v.attempt.request as { references?: Array<{ assetId: string; label: string }> } | null;
      const sent =
        request?.references && request.references.length > 0
          ? request.references.map((r) => r.assetId)
          : s.backgroundRemovalSourceAssetId
            ? [s.backgroundRemovalSourceAssetId]
            : v.attempt.inputAssetIds;
      const model = registry.model(v.attempt.provider, v.attempt.model);
      const snapshot = v.attempt.packageSnapshot as { subject?: { look?: { id?: string } | null } } | null;
      const { what, operation } = whatOf(v);
      const asset = out ? (assets.get(out.asset.id) ?? out.asset) : null;
      return {
        attemptId: v.attempt.id,
        number: v.attempt.attemptNumber,
        status: v.attempt.status,
        rejected: v.attempt.reviewStatus === "rejected",
        rejection:
          v.attempt.reviewStatus === "rejected"
            ? [
                ...v.attempt.rejectionCategories.map((c) => REJECTION_LABELS[c as RejectionCategory] ?? c),
                v.attempt.rejectionReason,
              ]
                .filter(Boolean)
                .join(" · ") || "Rejected"
            : null,
        what,
        operation,
        provider: v.attempt.provider,
        model: v.attempt.model,
        modelLabel: model?.displayName ?? v.attempt.model,
        test: madeByTestModel(v),
        createdAt: v.attempt.createdAt,
        asset: asset
          ? {
              id: asset.id,
              url: assetUrl(asset),
              width: asset.width ?? null,
              height: asset.height ?? null,
              hasAlpha: (asset.metadata as { hasAlpha?: unknown } | undefined)?.hasAlpha === true,
            }
          : null,
        paid: bills(v),
        estimateUsd: bills(v) ? estimateOf(v) : null,
        actualUsd: bills(v) ? actualOf(v) : null,
        inputs: sent.map((id) => ({
          assetId: id,
          // a picture deleted since (or in the Trash) is named so: the take still records that it was sent
          label:
            labelOf.get(id) ??
            assets.get(id)?.name ??
            (trashedIds.has(id) ? "In the Trash" : "Picture deleted"),
          url: assetUrl(assets.get(id)),
        })),
        prompt: v.attempt.prompt,
        error:
          v.attempt.status === "failed" ? v.job?.lastErrorMessage || "This image could not be made." : null,
        cutoutRefused:
          operation === "cutout" &&
          v.attempt.status === "failed" &&
          v.job?.lastErrorCode === "matting_background_not_plain",
        roles: asset ? rolesOf(asset.id) : [],
        settings: {
          intent: String(s.intent ?? ""),
          lookId: snapshot?.subject?.look?.id ?? null,
          aspectRatio: s.aspectRatio ?? null,
          quality: s.providerOptions?.quality ?? null,
          transparent: s.providerOptions?.background === "transparent",
          sourceAssetIds: s.sourceAssetIds ?? [],
          editSourceAssetId: s.editSourceAssetId ?? null,
          composer: s.composer ?? {},
        },
      };
    });

  // this subject's archive: what was archived from it (photos and takes), newest first
  const key = `${base.kind}:${base.id}`;
  const takeOf = new Map<string, number>();
  for (const v of everyAttempt) {
    const out = primaryOf(v);
    if (out) takeOf.set(out.asset.id, v.attempt.attemptNumber);
  }
  const archived: StudioArchivedImage[] = data.assets
    .filter((a) => archiveOf(a)?.subject === key && stored(a))
    .map((a) => {
      const takeNumber = takeOf.get(a.id) ?? null;
      const usage = findAssetUsage(data, a.id);
      const keptBecause = usage.inUse
        ? `Still used: ${usage.direct
            .slice(0, 2)
            .map((u) => u.label)
            .join("; ")}.`
        : null;
      return {
        assetId: a.id,
        url: assetUrl(a),
        label: takeNumber != null ? `Take #${takeNumber}` : a.name || "Photo",
        archivedAt: archiveOf(a)!.at,
        takeNumber,
        deletable: keptBecause === null,
        keptBecause,
      };
    })
    .sort((x, y) => y.archivedAt.localeCompare(x.archivedAt));

  return {
    archived,
    subjects,
    selected: {
      ...base,
      locked: location?.locked === true,
      appearance: character?.physicalDescription ?? "",
      about: character
        ? [character.role, character.description, character.personality].filter((x) => x?.trim()).join(" · ")
        : "",
      filledSlots: refs
        .filter(
          (r) => r.slot !== "additional" && visualRoleOf(r) === null && stored(assets.get(r.assetId ?? "")),
        )
        .map((r) => r.slot),
      looks: looks.map((l) => {
        const pictures = l.referenceAssetIds.filter((id) => stored(assets.get(id)));
        return {
          id: l.id,
          name: l.name,
          references: pictures.length,
          locked: l.locked,
          pictureUrl: pictures[0] ? assetUrl(assets.get(pictures[0])) : null,
          pictureAssetId: pictures[0] ?? null,
        };
      }),
    },
    images,
    takes,
    models,
    hostedMatting: hostedMattingOffer(),
    costHistory,
    spent: {
      usd: own.filter(bills).reduce((sum, v) => sum + (actualOf(v) ?? 0), 0),
      images: own.filter((v) => bills(v) && actualOf(v) != null).length,
      charged:
        Math.round(own.filter(bills).reduce((sum, v) => sum + (userPrice(estimateOf(v)) ?? 0), 0) * 100) /
        100,
    },
    shots: studioShots(data, base),
    referenceSet:
      base.kind === "character"
        ? REFERENCE_SET_VIEWS.map((v) => {
            const slotRef =
              v.slot === "additional"
                ? refs.find(
                    (r) => r.slot === "additional" && (r.metadata as { view?: unknown }).view === v.id,
                  )
                : refs.find((r) => r.slot === v.slot && visualRoleOf(r) === null);
            const canonicalRef = v.canonical ? refs.find((r) => visualRoleOf(r) === "canonical") : undefined;
            // the front view shows the canonical identity when there is one: that is the picture sent first
            const ref = [canonicalRef, slotRef].find((r) => r?.assetId && stored(assets.get(r.assetId)));
            const asset = ref?.assetId ? assets.get(ref.assetId) : undefined;
            const take = asset ? takes.find((t) => t.asset?.id === asset.id) : undefined;
            const origin = referenceOrigin(asset);
            return {
              id: v.id,
              label: v.label,
              intent: v.intent,
              canonical: v.canonical,
              assetId: asset?.id ?? null,
              url: asset ? assetUrl(asset) : null,
              from: !asset
                ? null
                : origin === "uploaded"
                  ? "your photo"
                  : take
                    ? `take #${take.number}`
                    : "generated picture",
              locked: !!ref?.locked,
            };
          })
        : [],
  };
}
