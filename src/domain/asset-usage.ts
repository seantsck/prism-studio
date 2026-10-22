import type { Asset, ProjectData } from "./schemas";

/**
 * "Where used" for an asset. Direct usages are explicit references (a Look's reference image, a take's
 * audio, a storyboard frame...). `shots` is the set of shots affected either directly or because they use a
 * character / Look / location that owns the asset ("Yumeko identity ref used in 8 shots").
 * Deletion is only safe when there are no direct usages: nothing may be silently orphaned.
 */

export type AssetUsageKind =
  | "identity_ref"
  | "look_ref"
  | "location_ref"
  | "prop_ref"
  | "voice_sample"
  | "shot_reference"
  | "shot_start_frame"
  | "shot_end_frame"
  | "shot_reference_video"
  | "shot_reference_audio"
  | "shot_lighting_reference"
  | "performance_take"
  | "storyboard_frame"
  | "production_frame"
  | "location_view"
  | "attempt_input"
  | "attempt_output"
  | "set3d_model";

export interface AssetUsage {
  kind: AssetUsageKind;
  /** Human label, e.g. `Yumeko · front identity reference`. */
  label: string;
  entityId: string;
  /** Present when the usage is tied to a specific shot. */
  shotId?: string;
}

export interface AssetUsageReport {
  assetId: string;
  direct: AssetUsage[];
  /** Distinct shots affected, ordered by shot code. */
  shots: Array<{ id: string; code: string }>;
  inUse: boolean;
  summary: string;
}

export function findAssetUsage(data: ProjectData, assetId: string): AssetUsageReport {
  const direct: AssetUsage[] = [];
  const affected = new Set<string>();
  const charName = (id: string) => data.characters.find((c) => c.id === id)?.name ?? "Unknown character";
  const shotCode = (id: string) => data.shots.find((s) => s.id === id)?.shotCode ?? "?";

  for (const ref of data.identityRefs) {
    if (ref.assetId !== assetId) continue;
    direct.push({
      kind: "identity_ref",
      label: `${charName(ref.characterId)} · ${ref.slot.replace("_", " ")} identity reference`,
      entityId: ref.id,
    });
    for (const s of data.shots)
      if (s.characters.some((c) => c.characterId === ref.characterId)) affected.add(s.id);
  }
  for (const look of data.looks) {
    if (!look.referenceAssetIds.includes(assetId)) continue;
    direct.push({
      kind: "look_ref",
      label: `${charName(look.characterId)} · Look "${look.name}" reference`,
      entityId: look.id,
    });
    for (const s of data.shots) if (s.characters.some((c) => c.lookId === look.id)) affected.add(s.id);
  }
  for (const loc of data.locations) {
    if (loc.referenceAssetIds.includes(assetId)) {
      direct.push({ kind: "location_ref", label: `Location "${loc.name}" reference`, entityId: loc.id });
      for (const s of data.shots) if (s.spatial.locationId === loc.id) affected.add(s.id);
    }
    if (loc.set3d?.modelAssetId === assetId) {
      direct.push({ kind: "set3d_model", label: `Location "${loc.name}" 3D model`, entityId: loc.id });
    }
  }
  for (const prop of data.props) {
    if (prop.referenceAssetIds.includes(assetId)) {
      direct.push({ kind: "prop_ref", label: `Prop "${prop.name}" reference`, entityId: prop.id });
      for (const s of data.shots) if (s.propIds.includes(prop.id)) affected.add(s.id);
    }
  }
  for (const v of data.voiceProfiles) {
    if (v.sampleAssetIds.includes(assetId))
      direct.push({
        kind: "voice_sample",
        label: `${charName(v.characterId)} · voice "${v.name}" sample`,
        entityId: v.id,
      });
  }
  for (const s of data.shots) {
    const g = s.generation;
    const add = (kind: AssetUsageKind, what: string) => {
      direct.push({ kind, label: `Shot ${s.shotCode} · ${what}`, entityId: s.id, shotId: s.id });
      affected.add(s.id);
    };
    if (g.referenceAssetIds.includes(assetId)) add("shot_reference", "generation reference");
    if (g.startFrameAssetId === assetId) add("shot_start_frame", "start frame");
    if (g.endFrameAssetId === assetId) add("shot_end_frame", "end frame");
    if (g.referenceVideoAssetId === assetId) add("shot_reference_video", "reference video");
    if (g.referenceAudioAssetId === assetId) add("shot_reference_audio", "reference audio");
    if (s.lighting.referenceAssetId === assetId) add("shot_lighting_reference", "lighting reference");
  }
  for (const t of data.takes) {
    if (t.audioAssetId !== assetId) continue;
    const line = data.dialogueLines.find((l) => l.id === t.dialogueLineId);
    direct.push({
      kind: "performance_take",
      label: `Take ${t.takeNumber}${t.selected ? " (selected)" : ""} · "${(line?.originalText ?? "").slice(0, 24)}"`,
      entityId: t.id,
    });
    for (const s of data.shots) if (s.audio.dialogueLineIds.includes(t.dialogueLineId)) affected.add(s.id);
  }
  for (const f of data.frames) {
    if (f.assetId !== assetId) continue;
    direct.push({
      kind: "storyboard_frame",
      label: `Shot ${shotCode(f.shotId)} · storyboard v${f.version}${f.approved ? " (approved)" : ""}`,
      entityId: f.id,
      shotId: f.shotId,
    });
    affected.add(f.shotId);
  }
  // an immutable Production Frame pins its image (a promoted frame shares the Storyboard / Master Frame Asset)
  for (const f of data.productionFrames ?? []) {
    if (f.assetId !== assetId) continue;
    direct.push({
      kind: "production_frame",
      label: `Shot ${shotCode(f.shotId)} · Production Frame v${f.version}`,
      entityId: f.id,
      shotId: f.shotId,
    });
    affected.add(f.shotId);
  }
  // an immutable Location View pins its image (a promoted view shares the Production Frame / reference Asset)
  for (const v of data.locationViews ?? []) {
    if (v.assetId !== assetId) continue;
    const place = data.locations.find((l) => l.id === v.locationId)?.name ?? "Location";
    direct.push({ kind: "location_view", label: `${place} · Location View "${v.name}"`, entityId: v.id });
    for (const sel of data.shotLocationViewSelections ?? [])
      if (sel.locationViewId === v.id) affected.add(sel.shotId);
  }
  for (const a of data.attempts) {
    if (a.inputAssetIds.includes(assetId))
      direct.push({
        kind: "attempt_input",
        label: `Shot ${shotCode(a.shotId)} · attempt ${a.attemptNumber} input`,
        entityId: a.id,
        shotId: a.shotId,
      });
    if (a.outputAssetId === assetId)
      direct.push({
        kind: "attempt_output",
        label: `Shot ${shotCode(a.shotId)} · attempt ${a.attemptNumber} output`,
        entityId: a.id,
        shotId: a.shotId,
      });
  }
  // Secondary outputs (previews, variants) are linked by generation_outputs; their asset metadata names the
  // attempt, so they are never silently deletable while that attempt's history exists.
  const self = data.assets.find((x) => x.id === assetId);
  const generatedBy = (self?.metadata as { generation?: { attemptId?: string; role?: string } } | undefined)
    ?.generation;
  if (generatedBy?.attemptId) {
    const attempt = data.attempts.find((x) => x.id === generatedBy.attemptId);
    if (attempt && !direct.some((d) => d.kind === "attempt_output" && d.entityId === attempt.id)) {
      direct.push({
        kind: "attempt_output",
        label: `Shot ${shotCode(attempt.shotId)} · attempt ${attempt.attemptNumber} ${generatedBy.role ?? "output"}`,
        entityId: attempt.id,
        shotId: attempt.shotId,
      });
      affected.add(attempt.shotId);
    }
  }

  const shots = [...affected]
    .map((id) => ({ id, code: shotCode(id) }))
    .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  const inUse = direct.length > 0;
  const summary = !inUse
    ? "Not used anywhere"
    : shots.length > 0
      ? `Used in ${shots.length} shot${shots.length === 1 ? "" : "s"} (${shots.map((s) => s.code).join(", ")})`
      : `Referenced ${direct.length} time${direct.length === 1 ? "" : "s"}`;
  return { assetId, direct, shots, inUse, summary };
}

/** Usage for every asset in one pass over the project (library view). */
export function indexAssetUsage(data: ProjectData): Map<string, AssetUsageReport> {
  return new Map(data.assets.map((a: Asset) => [a.id, findAssetUsage(data, a.id)]));
}
