import type { AssetUsageReport } from "./asset-usage";
import type { Asset, ProjectData } from "./schemas";

export const ASSET_FILTERS = [
  { key: "all", label: "All" },
  { key: "image", label: "Image" },
  { key: "audio", label: "Audio" },
  { key: "video", label: "Video" },
  { key: "storyboard", label: "Storyboard" },
  { key: "character", label: "Character" },
  { key: "look", label: "Look" },
  { key: "location", label: "Location" },
  { key: "generation_input", label: "Generation input" },
  { key: "generation_output", label: "Generation output" },
] as const;
export type AssetFilterKey = (typeof ASSET_FILTERS)[number]["key"];

export function isAssetFilter(v: string | undefined): v is AssetFilterKey {
  return ASSET_FILTERS.some((f) => f.key === v);
}

export function matchesFilter(
  asset: Asset,
  usage: AssetUsageReport | undefined,
  filter: AssetFilterKey,
): boolean {
  switch (filter) {
    case "all":
      return true;
    case "image":
    case "audio":
    case "video":
      return asset.type === filter;
    case "storyboard":
      return (
        asset.purpose === "storyboard" || usage?.direct.some((u) => u.kind === "storyboard_frame") === true
      );
    case "character":
      return (
        asset.purpose === "identity_ref" || usage?.direct.some((u) => u.kind === "identity_ref") === true
      );
    case "look":
      return asset.purpose === "look_ref" || usage?.direct.some((u) => u.kind === "look_ref") === true;
    case "location":
      return (
        asset.purpose === "location_ref" || usage?.direct.some((u) => u.kind === "location_ref") === true
      );
    case "generation_input":
      return (
        asset.purpose === "generation_input" ||
        usage?.direct.some((u) => u.kind === "attempt_input" || u.kind.startsWith("shot_")) === true
      );
    case "generation_output":
      return (
        asset.purpose === "generation_output" ||
        usage?.direct.some((u) => u.kind === "attempt_output") === true
      );
  }
}

/** Lower-cased haystack: file name, tags, purpose, who/what/where uses it (character, scene, shot, location). */
export function assetSearchText(
  data: ProjectData,
  asset: Asset,
  usage: AssetUsageReport | undefined,
): string {
  const parts: string[] = [
    asset.name,
    asset.originalFilename,
    asset.purpose,
    asset.type,
    asset.notes,
    ...asset.tags,
  ];
  if (usage) {
    parts.push(...usage.direct.map((u) => u.label));
    for (const s of usage.shots) {
      const shot = data.shots.find((x) => x.id === s.id);
      if (!shot) continue;
      parts.push(shot.shotCode, shot.title);
      const scene = data.scenes.find((x) => x.id === shot.sceneId);
      if (scene) parts.push(scene.slugline, `scene ${scene.sceneNumber}`);
      const loc = data.locations.find((x) => x.id === shot.spatial.locationId);
      if (loc) parts.push(loc.name);
      for (const c of shot.characters) {
        const ch = data.characters.find((x) => x.id === c.characterId);
        if (ch) parts.push(ch.name);
      }
    }
  }
  return parts.join(" ").toLowerCase();
}

export function filterAssets(
  data: ProjectData,
  usageIndex: ReadonlyMap<string, AssetUsageReport>,
  opts: { filter: AssetFilterKey; q: string },
): Asset[] {
  const terms = opts.q.toLowerCase().split(/\s+/).filter(Boolean);
  return data.assets
    .filter((a) => matchesFilter(a, usageIndex.get(a.id), opts.filter))
    .filter((a) => {
      if (terms.length === 0) return true;
      const hay = assetSearchText(data, a, usageIndex.get(a.id));
      return terms.every((t) => hay.includes(t));
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}
