"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { PrevisError, type SetupTemplateRecord } from "@/data/previs-repository";
import { authoredLightingIntent } from "@/domain/previs/lighting";
import {
  availableSetup,
  parseSetupComponents,
  planIsNoop,
  planSetupCopy,
  SETUP_COMPONENTS,
  SetupCopyRefusal,
  type SetupComponent,
  type SetupCopyPlan,
} from "@/domain/previs/setup-copy";
import {
  normalizeTemplateDescription,
  normalizeTemplateName,
  templateAsSetupRows,
  templateParts,
  TEMPLATE_GONE,
  TEMPLATE_OTHER_SET,
  TEMPLATES_NOT_MIGRATED,
} from "@/domain/previs/setup-template";
import { SETUP_SHOT_GONE } from "@/domain/previs/setup-copy";
import { UserFacingError } from "./action-result";
import { requireUser } from "./auth";
import { getPrevisRepo } from "./previs";
import { requireProjectFresh } from "./repo";

/**
 * Phase 4D-I2 named setup templates. A template is a SOURCE FOR COPIES, never a runtime dependency: saving snapshots a
 * Shot's values; applying copies the template's values into the destination Shot's own rows (after a read-only review
 * whose token names the template revision). Every action resolves the Project from the caller (RLS-bound in Supabase
 * mode); a template id from another Project, a deleted template and a malformed id all get TEMPLATE_GONE.
 */
export type TemplateResult<T> = ({ ok: true } & T) | { ok: false; error: string; conflict?: boolean };

export interface SetupTemplateSummary {
  id: string;
  name: string;
  description: string;
  revision: number;
  parts: SetupComponent[];
  contentFingerprint: string;
  sourceShotCode: string | null;
  updatedAt: string;
}

export interface TemplateCopyPreview {
  template: SetupTemplateSummary;
  plan: SetupCopyPlan | null;
  available: Record<SetupComponent, boolean>;
  characters: Record<string, string>;
  noop: boolean;
}

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const summary = (t: SetupTemplateRecord): SetupTemplateSummary => ({
  id: t.id,
  name: t.name,
  description: t.description,
  revision: t.revision,
  parts: templateParts(t.content),
  contentFingerprint: t.contentFingerprint,
  sourceShotCode: t.sourceShotCode,
  updatedAt: t.updatedAt,
});

async function guarded<T>(body: () => Promise<TemplateResult<T>>): Promise<TemplateResult<T>> {
  try {
    return await body();
  } catch (err) {
    if (err instanceof PrevisError)
      return { ok: false, error: err.message, conflict: err.code === "conflict" };
    if (err instanceof UserFacingError || err instanceof SetupCopyRefusal)
      return { ok: false, error: err.message };
    const digest = (err as { digest?: unknown } | null)?.digest;
    if (typeof digest === "string") throw err;
    const ref = randomUUID().slice(0, 8);
    console.error(`[setup-template ${ref}]`, err instanceof Error ? err.message : "unknown error");
    return { ok: false, error: `Something went wrong with the setup template (ref ${ref}).` };
  }
}

function componentsOf(form: FormData): SetupComponent[] | null {
  const raw = str(form, "components");
  if (raw === "") return null;
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    throw new UserFacingError("The setup parts are not valid.");
  }
  if (!Array.isArray(list)) throw new UserFacingError("The setup parts are not valid.");
  return parseSetupComponents(list);
}
function revisionOf(form: FormData): number {
  const n = Number(str(form, "expectedRevision"));
  if (!Number.isInteger(n) || n < 1) throw new UserFacingError("Invalid revision.");
  return n;
}

/** The caller's Project, the previs store (0050 required) and, when asked, a Shot with its Location's current set. */
async function context(form: FormData) {
  const slug = str(form, "projectSlug");
  const user = await requireUser();
  const data = await requireProjectFresh(slug);
  const previs = await getPrevisRepo();
  if (!(await previs.setupTemplatesReady())) throw new UserFacingError(TEMPLATES_NOT_MIGRATED);
  const shotOnSet = async (shotId: string) => {
    const shot = data.shots.find((s) => s.id === shotId);
    if (!shot) throw new UserFacingError(SETUP_SHOT_GONE);
    const locationId = shot.spatial.locationId;
    if (!locationId) throw new UserFacingError("Choose this Shot's Location in Shot Prep first.");
    const scene = await previs.getSceneForLocation(locationId);
    if (!scene || scene.projectId !== data.project.id) throw new UserFacingError("Save the 3D set first.");
    return { shot, set: { locationId, sceneDocumentId: scene.id } };
  };
  /** Only a template of THIS Project exists for the caller (one answer for foreign, deleted and malformed ids). */
  const template = async (id: string) => {
    if (!UUID.test(id)) throw new UserFacingError(TEMPLATE_GONE);
    const t = await previs.getSetupTemplate(id);
    if (!t || t.projectId !== data.project.id) throw new UserFacingError(TEMPLATE_GONE);
    return t;
  };
  return { slug, user, data, previs, shotOnSet, template, userId: user.kind === "supabase" ? user.id : null };
}

const refresh = (slug: string) => revalidatePath(`/projects/${slug}`, "layout");

/** "Save setup as template": a snapshot of the chosen parts of this Shot's current setup, by value. */
export async function saveSetupTemplate(
  form: FormData,
): Promise<TemplateResult<{ template: SetupTemplateSummary }>> {
  return guarded(async () => {
    const name = normalizeTemplateName(str(form, "name"));
    const description = normalizeTemplateDescription(str(form, "description"));
    const components = componentsOf(form) ?? [];
    if (components.length === 0)
      throw new UserFacingError("Choose at least one part to save in the template.");
    const ctx = await context(form);
    const { shot, set } = await ctx.shotOnSet(str(form, "shotId"));
    const t = await ctx.previs.createSetupTemplate({
      projectId: ctx.data.project.id,
      shotId: shot.id,
      ...set,
      name,
      description,
      components,
      userId: ctx.userId,
      now: new Date().toISOString(),
    });
    refresh(ctx.slug);
    return { ok: true, template: summary(t) };
  });
}

/** Rename / re-describe. Never touches any Shot (Shots that copied the template keep their values). */
export async function renameSetupTemplate(
  form: FormData,
): Promise<TemplateResult<{ template: SetupTemplateSummary }>> {
  return guarded(async () => {
    const name = normalizeTemplateName(str(form, "name"));
    const description = normalizeTemplateDescription(str(form, "description"));
    const expectedRevision = revisionOf(form);
    const ctx = await context(form);
    const t = await ctx.template(str(form, "templateId"));
    const next = await ctx.previs.updateSetupTemplate({
      projectId: ctx.data.project.id,
      templateId: t.id,
      expectedRevision,
      name,
      description,
      now: new Date().toISOString(),
    });
    refresh(ctx.slug);
    return { ok: true, template: summary(next) };
  });
}

/** Replace the template's values with a fresh snapshot of this Shot. Shots that copied it earlier do not change. */
export async function replaceSetupTemplateContent(
  form: FormData,
): Promise<TemplateResult<{ template: SetupTemplateSummary }>> {
  return guarded(async () => {
    const expectedRevision = revisionOf(form);
    const components = componentsOf(form) ?? [];
    if (components.length === 0)
      throw new UserFacingError("Choose at least one part to save in the template.");
    const ctx = await context(form);
    const t = await ctx.template(str(form, "templateId"));
    const { shot, set } = await ctx.shotOnSet(str(form, "shotId"));
    if (t.locationId !== set.locationId || t.sceneDocumentId !== set.sceneDocumentId)
      throw new UserFacingError(TEMPLATE_OTHER_SET);
    const next = await ctx.previs.updateSetupTemplate({
      projectId: ctx.data.project.id,
      templateId: t.id,
      expectedRevision,
      contentFrom: { shotId: shot.id, components },
      now: new Date().toISOString(),
    });
    refresh(ctx.slug);
    return { ok: true, template: summary(next) };
  });
}

/** Deletes the template. Shots that copied it keep their values; their copy history keeps the template's name. */
export async function deleteSetupTemplate(form: FormData): Promise<TemplateResult<object>> {
  return guarded(async () => {
    const expectedRevision = revisionOf(form);
    const ctx = await context(form);
    const t = await ctx.template(str(form, "templateId"));
    await ctx.previs.deleteSetupTemplate({
      projectId: ctx.data.project.id,
      templateId: t.id,
      expectedRevision,
    });
    refresh(ctx.slug);
    return { ok: true };
  });
}

async function resolveCopy(form: FormData) {
  const ctx = await context(form);
  const { shot, set } = await ctx.shotOnSet(str(form, "shotId"));
  const t = await ctx.template(str(form, "templateId"));
  // positions belong to ONE set: a template from another Location (or an earlier set) is never reinterpreted
  if (t.locationId !== set.locationId || t.sceneDocumentId !== set.sceneDocumentId)
    throw new UserFacingError(TEMPLATE_OTHER_SET);
  const destination = {
    camera: await ctx.previs.getBookmarkForShot(shot.id),
    lighting: await ctx.previs.getLightingRigForShot(shot.id),
    blocking: await ctx.previs.listShotBlocking(shot.id),
  };
  return { ctx, shot, set, t, source: templateAsSetupRows(t.content, set), destination };
}

/** Read-only: what "Copy from template" would copy into this Shot and what it replaces. Writes nothing. */
export async function previewTemplateSetupCopy(form: FormData): Promise<TemplateResult<TemplateCopyPreview>> {
  return guarded(async () => {
    const asked = componentsOf(form);
    const r = await resolveCopy(form);
    const available = availableSetup(r.source, r.set);
    const components = asked ?? SETUP_COMPONENTS.filter((c) => available[c]);
    const plan =
      components.length === 0
        ? null
        : planSetupCopy({
            sourceShotId: null,
            template: { id: r.t.id, revision: r.t.revision, contentFingerprint: r.t.contentFingerprint },
            destinationShotId: r.shot.id,
            set: r.set,
            source: r.source,
            destination: r.destination,
            components,
          });
    const characters: Record<string, string> = {};
    for (const c of r.ctx.data.characters) characters[c.id] = c.name;
    return {
      ok: true,
      template: summary(r.t),
      plan,
      available,
      characters,
      noop: plan ? planIsNoop(plan) : true,
    };
  });
}

/** The explicit copy from a template into this Shot's own rows (one transaction; the reviewed token is required). */
export async function copyTemplateSetup(
  form: FormData,
): Promise<TemplateResult<{ plan: SetupCopyPlan; copied: SetupComponent[]; templateName: string }>> {
  return guarded(async () => {
    const components = componentsOf(form);
    const token = str(form, "token");
    if (!components || components.length === 0)
      throw new UserFacingError("Choose at least one part to copy.");
    if (!/^[0-9a-f]{64}$/.test(token)) throw new UserFacingError("Review the copy before confirming it.");
    const r = await resolveCopy(form);
    const result = await r.ctx.previs.copyTemplateSetup({
      projectId: r.ctx.data.project.id,
      templateId: r.t.id,
      destinationShotId: r.shot.id,
      ...r.set,
      components,
      expectedToken: token,
      destinationIntent: authoredLightingIntent(r.shot),
      userId: r.ctx.userId,
      now: new Date().toISOString(),
    });
    refresh(r.ctx.slug);
    return { ok: true, plan: result.plan, copied: result.plan.components, templateName: r.t.name };
  });
}
