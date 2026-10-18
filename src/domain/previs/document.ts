import { fingerprint } from "../hash";
import { parseCalibration, SPLAT_USER_DATA } from "./splat";
import {
  PREVIS_ENGINE,
  PREVIS_PRODUCTION_FRAME,
  PREVIS_SCHEMA,
  PREVIS_UPSTREAM_COMMIT,
  previsDocumentSchema,
  type PrevisCamera,
  type PrevisDocument,
  type PrevisObject,
} from "./types";

/** Engine token prefix for a Prism asset: `m_<assetId>` (the vendored loader dispatches on `includes("m_")`). */
export const ASSET_TOKEN_PREFIX = "m_";
export const assetTokenFor = (assetId: string) => `${ASSET_TOKEN_PREFIX}${assetId}`;
export function assetIdFromToken(token: string): string | null {
  return token.startsWith(ASSET_TOKEN_PREFIX) && token.length > ASSET_TOKEN_PREFIX.length
    ? token.slice(ASSET_TOKEN_PREFIX.length)
    : null;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const n = (v: unknown, fallback = 0) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const vec = (v: unknown) => (isRec(v) ? { x: n(v.x), y: n(v.y), z: n(v.z) } : { x: 0, y: 0, z: 0 });
const str = (v: unknown) => (typeof v === "string" ? v : null);

/** user_data keys Prism writes on engine objects (carried in the engine's own save JSON). */
export const PRISM_USER_DATA = {
  characterId: "prismCharacterId",
  assetChecksum: "prismAssetChecksum",
} as const;

/**
 * Normalise the engine's `scene` array into Prism objects. Environment lighting and the internal render-camera
 * frustum are not production objects. Order is not significant (the fingerprint sorts by id).
 */
export function extractObjects(engineScene: unknown): PrevisObject[] {
  if (!isRec(engineScene) || !Array.isArray(engineScene.scene)) return [];
  const out: PrevisObject[] = [];
  for (const raw of engineScene.scene) {
    if (!isRec(raw)) continue;
    const token = str(raw.media_file_token) ?? "";
    const userData = isRec(raw.user_data) ? raw.user_data : {};
    const id = str(raw.object_uuid);
    if (!id || token === "DirectionalLight" || raw.object_name === "::CAM::") continue;

    // a Gaussian-splat environment is an asset-bound object that names its (immutable) reconstruction record
    const reconstructionId = str(userData[SPLAT_USER_DATA.reconstructionId]);
    let kind: PrevisObject["kind"];
    let shape: string | null = null;
    let assetId: string | null = null;
    if (token === "Parim") {
      const key = str(userData.shapeKey) ?? str(userData.shapeType) ?? str(raw.object_name) ?? "Box";
      kind = key === "Mannequin" ? "mannequin" : key === "PointLight" ? "light" : "primitive";
      shape = key;
    } else {
      assetId = assetIdFromToken(token);
      if (!assetId) continue; // an object this schema cannot represent faithfully is never silently included
      kind = reconstructionId ? "splat" : "glb";
    }
    out.push({
      id,
      kind,
      shape,
      name: str(raw.object_name) ?? "",
      assetId,
      assetChecksum: str(userData[PRISM_USER_DATA.assetChecksum]),
      characterId: str(userData[PRISM_USER_DATA.characterId]),
      position: vec(raw.position),
      rotation: vec(raw.rotation),
      scale: isRec(raw.scale) ? vec(raw.scale) : { x: 1, y: 1, z: 1 },
      color: str(raw.color),
      visible: raw.visible !== false,
      locked: raw.locked === true,
      reconstructionId: kind === "splat" ? reconstructionId : null,
      calibration: kind === "splat" ? parseCalibration(userData[SPLAT_USER_DATA.calibration]) : null,
    });
  }
  return out;
}

/** The production camera is the engine's first non-"main" camera entry (its live ::CAM:: pose at save time). */
export function extractProductionCamera(engineScene: unknown): PrevisCamera | null {
  if (!isRec(engineScene) || !Array.isArray(engineScene.cameras)) return null;
  const cam = engineScene.cameras.find((c) => isRec(c) && c.id !== "main");
  if (!isRec(cam)) return null;
  const focal = n(cam.focalLength, 0);
  if (focal <= 0) return null;
  return {
    id: str(cam.id) ?? "cam",
    label: str(cam.label) ?? "Camera",
    position: vec(cam.position),
    rotation: vec(cam.rotation),
    focalLengthMm: focal,
  };
}

/** The editor navigation camera (the engine's `camera_data`). Never a Shot camera. */
export function extractNavigationCamera(engineScene: unknown) {
  if (!isRec(engineScene) || !isRec(engineScene.camera_data)) return null;
  const c = engineScene.camera_data;
  if (!isRec(c.position) || !isRec(c.rotation)) return null;
  return { position: vec(c.position), rotation: vec(c.rotation) };
}

const URL_LIKE =
  /(https?:\/\/|blob:|data:[a-z]+\/[a-z0-9.+-]+;base64|[?&](token|signature|sig|X-Amz-[A-Za-z-]+)=)/i;

/** Every string in the engine payload that looks like a URL or credential (must always be empty). */
export function findEphemeralStrings(value: unknown, path = "$", found: string[] = []): string[] {
  if (typeof value === "string") {
    if (URL_LIKE.test(value)) found.push(path);
  } else if (Array.isArray(value)) value.forEach((v, i) => findEphemeralStrings(v, `${path}[${i}]`, found));
  else if (isRec(value))
    for (const [k, v] of Object.entries(value)) findEphemeralStrings(v, `${path}.${k}`, found);
  return found;
}

export interface BuildPrevisInput {
  /** the engine's own `getSceneJson()` output */
  engineScene: object;
  /** assetId -> checksum, for the assets the scene references */
  assetChecksums?: Record<string, string | null>;
}

/** Wrap engine JSON into the persisted Prism document. Throws if the payload carries an ephemeral URL. */
export function buildPrevisDocument(input: BuildPrevisInput): PrevisDocument {
  const checksums = input.assetChecksums ?? {};
  const objects = extractObjects(input.engineScene).map((o) =>
    o.assetId ? { ...o, assetChecksum: checksums[o.assetId] ?? o.assetChecksum } : o,
  );
  const assetBindings: PrevisDocument["assetBindings"] = {};
  for (const o of objects) if (o.assetId) assetBindings[o.assetId] = { checksum: o.assetChecksum };

  const ephemeral = findEphemeralStrings(input.engineScene);
  if (ephemeral.length > 0)
    throw new Error(`Scene carries ephemeral URLs or credentials at ${ephemeral.slice(0, 3).join(", ")}`);

  return previsDocumentSchema.parse({
    schema: PREVIS_SCHEMA,
    engine: PREVIS_ENGINE,
    upstreamCommit: PREVIS_UPSTREAM_COMMIT,
    productionFrame: { ...PREVIS_PRODUCTION_FRAME },
    objects,
    productionCamera: extractProductionCamera(input.engineScene),
    assetBindings,
    scene: { ...(input.engineScene as Rec) },
    editor: { navigationCamera: extractNavigationCamera(input.engineScene) },
  });
}

const r5 = (v: number) => Math.round(v * 1e5) / 1e5 + 0; // + 0 normalises -0
const rv = (v: { x: number; y: number; z: number }) => ({ x: r5(v.x), y: r5(v.y), z: r5(v.z) });

type Spatial = Pick<PrevisDocument, "objects" | "productionCamera" | "productionFrame">;

/**
 * The production-relevant spatial truth of a set. Changes when objects are added/removed/moved, an asset's
 * content changes, a blocked character changes or the production camera moves. Selection, hover, panel state and
 * the editor navigation camera are not part of it, so they cannot change the fingerprint.
 */
export function spatialSnapshot(doc: Spatial) {
  return {
    schema: PREVIS_SCHEMA,
    frame: doc.productionFrame.ratio,
    objects: [...doc.objects]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((o) => ({
        id: o.id,
        kind: o.kind,
        shape: o.shape,
        name: o.name,
        assetId: o.assetId,
        assetChecksum: o.assetChecksum,
        characterId: o.characterId,
        position: rv(o.position),
        rotation: rv(o.rotation),
        scale: rv(o.scale),
        color: o.color ? o.color.toLowerCase() : null,
        visible: o.visible,
        // Splat-only identity, added ONLY for splats so a Set without one keeps its historical fingerprint.
        ...(o.kind === "splat"
          ? {
              reconstructionId: o.reconstructionId,
              calibration: o.calibration
                ? {
                    units: o.calibration.units,
                    metresPerSourceUnit: o.calibration.metresPerSourceUnit,
                    scaleMethod: o.calibration.scaleMethod,
                    groundOffsetMetres: r5(o.calibration.groundOffsetMetres),
                  }
                : null,
            }
          : {}),
      })),
    camera: doc.productionCamera
      ? {
          id: doc.productionCamera.id,
          position: rv(doc.productionCamera.position),
          rotation: rv(doc.productionCamera.rotation),
          focalLengthMm: r5(doc.productionCamera.focalLengthMm),
        }
      : null,
  };
}

export function sceneFingerprint(doc: Spatial): string {
  return fingerprint(spatialSnapshot(doc));
}

/** Where each blocked Prism Character's proxy stands: the blocking generation needs, frozen with a package. */
export function characterBlocking(doc: Pick<PrevisDocument, "objects">) {
  return doc.objects
    .filter((o) => o.kind === "mannequin" && o.characterId)
    .map((o) => ({
      characterId: o.characterId as string,
      objectId: o.id,
      position: rv(o.position),
      rotation: rv(o.rotation),
      scale: rv(o.scale),
    }))
    .sort((a, b) => (a.objectId < b.objectId ? -1 : a.objectId > b.objectId ? 1 : 0));
}
