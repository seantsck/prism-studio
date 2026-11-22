"use server";

import { revalidatePath } from "next/cache";
import {
  archiveOf,
  archiveRefusal,
  planArchive,
  subjectKey,
  type ArchiveRecord,
  type ArchiveSubject,
} from "@/domain/archive";
import { hasStoredImage } from "@/domain/generation/subject-image";
import type { Asset, ProjectData } from "@/domain/schemas";
import { runAction, UserFacingError, type ActionResult } from "./action-result";
import { requireUser } from "./auth";
import { liftPointers, restorePointers } from "./picture-pointers";
import { getRepo, requireProjectFresh } from "./repo";

/**
 * The Reference Studio's archive. Archive hides a picture from the Studio and stops it being sent (its plain pointers
 * are lifted out and remembered); Restore puts every pointer back. Deleting a picture moves it to the Trash
 * (src/server/trash-actions.ts).
 */

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const now = () => new Date().toISOString();

async function load(form: FormData) {
  await requireUser();
  const data = await requireProjectFresh(str(form, "projectSlug"));
  const asset = data.assets.find((a) => a.id === str(form, "assetId"));
  if (!asset) throw new UserFacingError("That picture no longer exists.");
  return { data, asset, repo: await getRepo(), slug: data.project.slug };
}

function subjectOf(data: ProjectData, form: FormData): ArchiveSubject {
  const kind = str(form, "subjectKind");
  const id = str(form, "subjectId");
  if (kind === "character" && data.characters.some((c) => c.id === id)) return { kind, id };
  if (kind === "location" && data.locations.some((l) => l.id === id)) return { kind, id };
  throw new UserFacingError("Choose who or where this picture belongs to.");
}

const refresh = (slug: string) => revalidatePath(`/projects/${slug}`, "layout");

async function archive_impl(form: FormData) {
  const { data, asset, repo, slug } = await load(form);
  if (archiveOf(asset)) throw new UserFacingError("That picture is already archived.");
  if (!hasStoredImage(asset)) throw new UserFacingError("Only a stored picture can be archived.");
  const subject = subjectOf(data, form);
  const plan = planArchive(data, subject, asset.id);
  if (!plan.ok) throw new UserFacingError(archiveRefusal(plan.blockers));
  // the record first: if lifting a pointer fails, the picture is still findable in the archive and can be restored
  const record: ArchiveRecord = { at: now(), subject: subjectKey(subject), restore: plan.lift };
  await repo.upsert(data.project.id, "assets", {
    ...asset,
    metadata: { ...asset.metadata, archived: record },
    updatedAt: record.at,
  });
  await liftPointers(repo, data, asset.id, plan.lift);
  refresh(slug);
}

async function restore_impl(form: FormData) {
  const { data, asset, repo, slug } = await load(form);
  const record = archiveOf(asset);
  if (!record) throw new UserFacingError("That picture is not archived.");
  await restorePointers(repo, data, asset.id, record.restore);
  const { archived: _archived, ...metadata } = asset.metadata as Asset["metadata"] & { archived?: unknown };
  void _archived;
  await repo.upsert(data.project.id, "assets", { ...asset, metadata, updatedAt: now() });
  refresh(slug);
}

export async function archiveStudioImage(form: FormData): Promise<ActionResult> {
  return runAction(() => archive_impl(form), { name: "archiveStudioImage" });
}

export async function restoreStudioImage(form: FormData): Promise<ActionResult> {
  return runAction(() => restore_impl(form), { name: "restoreStudioImage" });
}
