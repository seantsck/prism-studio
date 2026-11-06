import { z } from "zod";
import { fingerprint } from "../hash";
import { blockingFingerprint, shotBlockingEntrySchema } from "./blocking";
import { lightingFingerprint, parseShotLightingDraft, shotLightingDraftSchema } from "./lighting";
import {
  SETUP_COMPONENTS,
  SetupCopyRefusal,
  availableSetup,
  parseSetupComponents,
  type CurrentSetupSet,
  type SetupComponent,
  type SetupRows,
} from "./setup-copy";
import { bookmarkCameraFingerprint } from "./spatial-passes";
import { cameraBookmarkSchema } from "./types";

/**
 * Phase 4D-I2: NAMED reusable setup templates (`prism.setup-template.v1`, migration 0050).
 *
 * A template is a SNAPSHOT of reusable VALUES (camera, lighting and/or blocking) saved on one Location's 3D set. Saving
 * "from Shot A" copies A's current values into the template; nothing in the template points back at A to be resolved
 * later. Applying a template is the 4D-I1 copy with the template as origin: its values are copied into the destination
 * Shot's OWN rows, and the template is never read again by anything that renders, captures, promotes or packages.
 *
 * Identity is split on purpose:
 *   - content (`setupTemplateContentFingerprint`): the reusable values only, the same function of camera / lighting /
 *     blocking whatever the name, description, provenance, set anchor or row identity;
 *   - revision: every edit (rename, new content) advances it, and a copy review names the revision it saw;
 *   - provenance (`sourceShotId` / code): display-only.
 */
export const SETUP_TEMPLATE_SCHEMA = "prism.setup-template.v1" as const;
export const MAX_TEMPLATE_NAME = 120;
export const MAX_TEMPLATE_DESCRIPTION = 2000;

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const anchor = { sceneRevision: z.number().int().min(1), sceneFingerprint: hex64 };

export const templateCameraSchema = z.strictObject({
  cameraLabel: z.string().max(200),
  value: cameraBookmarkSchema,
  ...anchor,
});
/** lights and base mode only: a Shot's authored lighting text never enters a template */
export const templateLightingSchema = z.strictObject({ rig: shotLightingDraftSchema, ...anchor });
export const templateFigureSchema = z
  .strictObject({ characterId: z.string().min(1), entry: shotBlockingEntrySchema, ...anchor })
  .refine((f) => f.entry.characterId === f.characterId, { message: "figure character mismatch" });
export const templateBlockingSchema = z
  .array(templateFigureSchema)
  .min(1)
  .max(32)
  .refine((fs) => new Set(fs.map((f) => f.characterId)).size === fs.length, {
    message: "duplicate character",
  });

export const setupTemplateContentSchema = z
  .strictObject({
    camera: templateCameraSchema.nullable(),
    lighting: templateLightingSchema.nullable(),
    blocking: templateBlockingSchema.nullable(),
  })
  .refine((c) => c.camera || c.lighting || c.blocking, { message: "a template holds at least one part" });
export type SetupTemplateContent = z.infer<typeof setupTemplateContentSchema>;

export function parseSetupTemplateContent(input: unknown): SetupTemplateContent {
  const c = setupTemplateContentSchema.parse(input);
  return {
    ...c,
    lighting: c.lighting ? { ...c.lighting, rig: parseShotLightingDraft(c.lighting.rig) } : null,
    blocking: c.blocking ? [...c.blocking].sort((a, b) => (a.characterId < b.characterId ? -1 : 1)) : null,
  };
}

export const templateParts = (c: SetupTemplateContent): SetupComponent[] =>
  SETUP_COMPONENTS.filter((p) =>
    p === "camera" ? !!c.camera : p === "lighting" ? !!c.lighting : !!c.blocking,
  );

/** Semantic identity of the reusable values ONLY (never the name, description, provenance, anchor or row id). */
export function setupTemplateContentFingerprint(
  c: SetupTemplateContent,
  anchor: { locationId: string },
): string {
  return fingerprint({
    schema: SETUP_TEMPLATE_SCHEMA,
    camera: c.camera
      ? { label: c.camera.cameraLabel, value: bookmarkCameraFingerprint(c.camera.value) }
      : null,
    lighting: c.lighting ? lightingFingerprint(c.lighting.rig) : null,
    blocking: c.blocking
      ? c.blocking.map((f) => [
          f.characterId,
          blockingFingerprint(f.entry, { locationId: anchor.locationId }),
        ])
      : null,
  });
}

export function normalizeTemplateName(raw: string): string {
  const name = raw.replace(/\s+/g, " ").trim();
  if (name.length === 0) throw new SetupCopyRefusal("Give the template a name.");
  if (name.length > MAX_TEMPLATE_NAME)
    throw new SetupCopyRefusal(`A template name is at most ${MAX_TEMPLATE_NAME} characters.`);
  return name;
}
export function normalizeTemplateDescription(raw: string): string {
  const d = raw.trim();
  if (d.length > MAX_TEMPLATE_DESCRIPTION)
    throw new SetupCopyRefusal(`A template description is at most ${MAX_TEMPLATE_DESCRIPTION} characters.`);
  return d;
}

/**
 * "Save setup as template": snapshots the chosen parts of a Shot's CURRENT-set rows by value. A part the Shot does not
 * have on this set is refused, never saved empty; rows the Shot left on another set are history and never saved.
 */
export function snapshotSetupTemplate(args: {
  rows: SetupRows;
  set: CurrentSetupSet;
  components: readonly unknown[];
}): SetupTemplateContent {
  const components = parseSetupComponents(args.components);
  if (components.length === 0)
    throw new SetupCopyRefusal("Choose at least one part to save in the template.");
  const available = availableSetup(args.rows, args.set);
  for (const c of components)
    if (!available[c]) throw new SetupCopyRefusal(`This Shot has no ${c} on this 3D set to save.`);
  const on = <T extends { locationId: string; sceneDocumentId: string }>(r: T) =>
    r.locationId === args.set.locationId && r.sceneDocumentId === args.set.sceneDocumentId;
  const cam = args.rows.camera;
  const rig = args.rows.lighting;
  return parseSetupTemplateContent({
    camera:
      components.includes("camera") && cam
        ? {
            cameraLabel: cam.cameraLabel,
            value: cam.value,
            sceneRevision: cam.sceneRevision,
            sceneFingerprint: cam.sceneFingerprint,
          }
        : null,
    lighting:
      components.includes("lighting") && rig
        ? {
            rig: { schema: rig.rig.schema, base: rig.rig.base, lights: rig.rig.lights },
            sceneRevision: rig.sceneRevision,
            sceneFingerprint: rig.sceneFingerprint,
          }
        : null,
    blocking: components.includes("blocking")
      ? args.rows.blocking.filter(on).map((b) => ({
          characterId: b.characterId,
          entry: b.entry,
          sceneRevision: b.sceneRevision,
          sceneFingerprint: b.sceneFingerprint,
        }))
      : null,
  });
}

/** The template's values as copy-planner source rows on the template's own set (the planner is shared with 4D-I1). */
export function templateAsSetupRows(c: SetupTemplateContent, set: CurrentSetupSet): SetupRows {
  return {
    camera: c.camera ? { ...set, ...c.camera } : null,
    lighting: c.lighting
      ? {
          ...set,
          sceneRevision: c.lighting.sceneRevision,
          sceneFingerprint: c.lighting.sceneFingerprint,
          revision: 0,
          rig: c.lighting.rig,
          lightingFingerprint: lightingFingerprint(c.lighting.rig),
        }
      : null,
    blocking: (c.blocking ?? []).map((f) => ({
      ...set,
      characterId: f.characterId,
      revision: 0,
      entry: f.entry,
      sceneRevision: f.sceneRevision,
      sceneFingerprint: f.sceneFingerprint,
      blockingFingerprint: blockingFingerprint(f.entry, { locationId: set.locationId }),
    })),
  };
}

export const TEMPLATE_GONE = "That template no longer exists.";
export const TEMPLATE_OTHER_SET =
  "This template was saved on another 3D set. A setup can only be copied onto the set its positions belong to.";
export const TEMPLATE_CHANGED = "The template changed after you reviewed it. Review it again before saving.";
export const TEMPLATE_NAME_TAKEN = "A template with that name already exists on this 3D set.";
export const TEMPLATE_CHARACTER_GONE = "A character in this template is no longer in the Project.";
/** A stored template that no longer validates (hand-edited row, or a later stricter schema): never fatal to a Shot. */
export const TEMPLATE_UNREADABLE =
  "This template's stored values can no longer be read. Delete it and save a new one.";
export const TEMPLATES_NOT_MIGRATED =
  "Setup templates are not available until database migration 0050 is applied.";
