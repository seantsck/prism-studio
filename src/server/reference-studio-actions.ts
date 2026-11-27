"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { findAssetUsage } from "@/domain/asset-usage";
import type { CostEstimate } from "@/domain/generation/schemas";
import { REJECTION_CATEGORIES, type RejectionCategory } from "@/domain/generation/schemas";
import type { ReferenceQuote } from "@/domain/generation/reference-studio";
import { parseUploadCopy, uploadCopySentence } from "@/domain/generation/reference-upload";
import { hasStoredImage } from "@/domain/generation/subject-image";
import { IDENTITY_SLOTS, type Asset } from "@/domain/schemas";
import { prepareSubjectImage } from "@/generation/subject-submission";
import { runAction, UserFacingError, type ActionResult } from "./action-result";
import { requireUser } from "./auth";
import { getGenerationConfig, getGenerationRepo, getRegistry } from "./generation";
import { discardUpload, hasFile, ingestUpload } from "./ingest-upload";
import { readSubjectImageForm } from "./reference-request";
import { getRepo, requireProjectFresh } from "./repo";

/**
 * The Reference Studio's own acts. Generating and promoting go through the existing Character / Location image
 * actions (`startSubjectImage`, `saveAs…`, the Visual Bible designations); this file adds only what the Studio needs
 * beside them: the price before spending, a creative review, and a plain "add my photo" upload.
 */
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const refresh = (slug: string) => revalidatePath(`/projects/${slug}`, "layout");

// ───────────────────────── the price, and exactly what will be sent ─────────────────────────

/**
 * What a "Generate" with these choices would send and cost. A READ: nothing is queued, stored or sent, and no worker
 * is started. It runs the same preparation as the submission, so the price confirmed is the price of that request.
 */
export async function quoteReferenceImage(form: FormData): Promise<ReferenceQuote> {
  try {
    const user = await requireUser();
    const data = await requireProjectFresh(str(form, "projectSlug"));
    const req = await readSubjectImageForm(form, data, { startInlineWorker: false });
    const registry = getRegistry();
    const prepared = prepareSubjectImage({
      data,
      input: { subject: req.subject, direction: req.direction, sourceAssetIds: req.sourceAssetIds },
      registry,
      provider: req.provider,
      modelId: req.modelId,
      aspectRatio: req.aspectRatio,
      userId: user.kind === "supabase" ? user.id : null,
      idempotencyKey: "quote-only-never-queued",
      config: getGenerationConfig(),
      edit: req.edit,
      options: req.options,
    });
    if (!prepared.ok) return { ok: false, reasons: prepared.reasons.slice(0, 3) };
    const model = registry.model(req.provider, req.modelId)!;
    const adapter = registry.adapter(req.provider)!;
    const attempt = prepared.input.attempt;
    const compiled = adapter.compileRequest(attempt.request as never, attempt.promptPlan as never);
    const fields = compiled.fields as Record<string, unknown>;
    const prompt = String(fields.prompt ?? fields.promptText ?? attempt.prompt);
    const paid = registry.billsMoney(model);
    const estimate: CostEstimate = prepared.estimate;
    const references = (attempt.request as { references: Array<{ assetId: string; label: string }> })
      .references;
    return {
      ok: true,
      paid,
      estimateUsd: paid ? estimate.amount : null,
      basis: estimate.basis,
      operation: prepared.operation,
      sending: references.map((r) => ({ assetId: r.assetId, label: r.label })),
      notSent: prepared.referencesNotSent,
      prompt,
      endpoint: compiled.endpoint,
      notes: compiled.notes,
    };
  } catch (err) {
    if (err instanceof UserFacingError) return { ok: false, reasons: [err.message] };
    const reference = Math.random().toString(36).slice(2, 10);
    console.error(`[action:quoteReferenceImage] ${reference}`, err instanceof Error ? err.message : err);
    return { ok: false, reasons: [`The price could not be worked out. (ref ${reference})`] };
  }
}

// ───────────────────────── creative review ─────────────────────────

/** Why a still is turned down (the subset of rejection reasons that apply to a reference image). */
const STILL_REJECTIONS: readonly RejectionCategory[] = [
  "identity_drift",
  "wrong_wardrobe",
  "wrong_set",
  "bad_anatomy",
  "extra_person",
  "artifact",
  "other",
];

/**
 * Reject a Character / Location image, or take the rejection back. There is no "approve": a reference is accepted by
 * the explicit "Use as…", which points a Visual Bible slot at it. A rejected image stays in history with its reason and
 * is no longer offered as a starting image. An image the project already uses cannot be rejected until that use ends.
 */
async function reviewReferenceImage_impl(form: FormData) {
  const slug = str(form, "projectSlug");
  await requireUser();
  const data = await requireProjectFresh(slug);
  const generation = await getGenerationRepo();
  const view = await generation.getSubjectImageAttempt(str(form, "attemptId"));
  if (!view || view.attempt.projectId !== data.project.id)
    throw new UserFacingError("That image no longer exists.");
  const decision = str(form, "decision");
  const now = new Date().toISOString();
  if (decision === "restore") {
    await generation.reviewSubjectImageAttempt(view.attempt.id, {
      status: "unreviewed",
      categories: [],
      reason: "",
      now,
    });
    refresh(slug);
    return;
  }
  if (decision !== "reject") throw new UserFacingError("Choose Reject or Restore.");
  if (view.attempt.status !== "succeeded")
    throw new UserFacingError("Only a finished image can be reviewed.");
  const category = str(form, "category") as RejectionCategory;
  if (!STILL_REJECTIONS.includes(category) || !(REJECTION_CATEGORIES as readonly string[]).includes(category))
    throw new UserFacingError("Say what is wrong with it.");
  const out = view.outputs.find((o) => o.output.role === "primary") ?? view.outputs[0];
  if (out) {
    // a current USE (a Visual Bible slot, a Look, a Location View, a frame…); having been an input once is history
    const uses = findAssetUsage(data, out.asset.id).direct.filter(
      (u) => u.kind !== "attempt_output" && u.kind !== "attempt_input",
    );
    if (uses.length > 0)
      throw new UserFacingError(
        `This image is in use (${uses
          .slice(0, 2)
          .map((u) => u.label)
          .join("; ")}). Remove that use before rejecting it.`,
      );
  }
  await generation.reviewSubjectImageAttempt(view.attempt.id, {
    status: "rejected",
    categories: [category],
    reason: str(form, "reason").slice(0, 300),
    now,
  });
  refresh(slug);
}

export async function reviewReferenceImage(form: FormData): Promise<ActionResult> {
  return runAction(() => reviewReferenceImage_impl(form), { name: "reviewReferenceImage" });
}

// ───────────────────────── add my photo ─────────────────────────

/**
 * Adds one uploaded photograph to a Character or a Location, as the original it is: the bytes are stored unchanged,
 * and everything made from it is a new image. It never replaces an image the subject already has: a Character slot
 * that holds a stored image is refused (the photo can still be added as an extra reference).
 *
 *   as = reference                          an extra identity reference / a Location reference
 *   as = front | three_quarter | profile | full_body   that identity slot, only while it is empty
 *   as = look:<lookId>                      one of the Look's wardrobe references
 */
async function uploadReferencePhoto_impl(form: FormData): Promise<string> {
  const slug = str(form, "projectSlug");
  await requireUser();
  const data = await requireProjectFresh(slug);
  const repo = await getRepo();
  const file = hasFile(form, "file");
  if (!file) throw new UserFacingError("Choose a photo to upload.");
  const kind = str(form, "subjectKind");
  const subjectId = str(form, "subjectId");
  const as = str(form, "as") || "reference";
  const assetOf = (id: string | null | undefined) => (id ? data.assets.find((a) => a.id === id) : undefined);
  // The browser says so when what it sends is a copy it made (upright, or small enough for one upload) and not the
  // file the creator chose. That is the browser's word: it is recorded as such and decides nothing here.
  const copy = parseUploadCopy(str(form, "copyOf"));
  const store = async (purpose: Asset["purpose"], tags: string[]) => {
    const { asset } = await ingestUpload(data, repo.currentUserId(), file, {
      allowed: ["image"],
      purpose,
      source: "upload",
      tags: copy ? [...tags, "browser-copy"] : tags,
      notes: copy ? uploadCopySentence(copy) : undefined,
      metadata: copy ? { uploadCopy: copy } : undefined,
    });
    try {
      await repo.upsert(data.project.id, "assets", asset);
    } catch (err) {
      await discardUpload(asset);
      throw err;
    }
    return asset;
  };

  if (kind === "location") {
    const location = data.locations.find((l) => l.id === subjectId);
    if (!location) throw new UserFacingError("That location no longer exists.");
    if (location.locked)
      throw new UserFacingError("That location is locked. Unlock it before changing its references.");
    const asset = await store("location_ref", ["location"]);
    await repo.upsert(data.project.id, "locations", {
      ...location,
      referenceAssetIds: [...location.referenceAssetIds, asset.id],
    });
    refresh(slug);
    return asset.id;
  }
  if (kind !== "character") throw new UserFacingError("Choose who or where this photo shows.");
  const character = data.characters.find((c) => c.id === subjectId);
  if (!character) throw new UserFacingError("That character no longer exists.");

  if (as.startsWith("look:")) {
    const look = data.looks.find((l) => l.id === as.slice(5) && l.characterId === character.id);
    if (!look) throw new UserFacingError("That Look no longer exists.");
    if (look.locked)
      throw new UserFacingError("That Look is locked. Unlock it before changing its references.");
    const asset = await store("look_ref", ["look"]);
    await repo.upsert(data.project.id, "looks", {
      ...look,
      referenceAssetIds: [...look.referenceAssetIds, asset.id],
    });
    refresh(slug);
    return asset.id;
  }

  const slot = (as === "reference" ? "additional" : as) as (typeof IDENTITY_SLOTS)[number];
  if (!(IDENTITY_SLOTS as readonly string[]).includes(slot))
    throw new UserFacingError("Choose what this photo shows.");
  const existing =
    slot === "additional"
      ? undefined
      : data.identityRefs.find((r) => r.characterId === character.id && r.slot === slot);
  if (existing && hasStoredImage(assetOf(existing.assetId)))
    throw new UserFacingError(
      `${character.name} already has a ${slot.replace("_", " ")} reference. Add this photo as an extra reference, or replace that slot on the Character page.`,
    );
  const asset = await store("identity_ref", ["identity"]);
  await repo.upsert(data.project.id, "identityRefs", {
    id: existing?.id ?? randomUUID(),
    characterId: character.id,
    slot,
    assetId: asset.id,
    label: slot === "additional" ? "Reference photo" : slot.replace("_", " "),
    metadata: { source: "upload" },
    locked: false,
  });
  refresh(slug);
  return asset.id;
}

/** The stored image's id comes back with a success, so the Studio can make exactly that photo the starting image. */
export async function uploadReferencePhoto(form: FormData): Promise<ActionResult & { assetId?: string }> {
  let assetId: string | undefined;
  const result = await runAction(
    async () => {
      assetId = await uploadReferencePhoto_impl(form);
    },
    { name: "uploadReferencePhoto" },
  );
  return result.ok ? { ...result, assetId } : result;
}
