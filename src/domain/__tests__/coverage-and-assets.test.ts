import { describe, expect, it } from "vitest";
import { findAssetUsage, indexAssetUsage } from "@/domain/asset-usage";
import { filterAssets } from "@/domain/asset-library";
import { buildEpisodeCoverage, buildSceneCoverage, shotSourceContent } from "@/domain/coverage";
import { parseScreenplay, syncScript } from "@/domain/script";
import { seed, shotByCode } from "./helpers";

describe("script traceability + coverage", () => {
  it("seed has stable action blocks with line ranges and scene ranges", () => {
    const data = seed();
    expect(data.actionBlocks.length).toBeGreaterThan(6);
    for (const b of data.actionBlocks) expect(b.startLine).toBeGreaterThan(0);
    for (const l of data.dialogueLines) expect(l.sourceStartLine).toBeGreaterThan(0);
    for (const s of data.scenes) expect(s.scriptRange?.startLine).toBeGreaterThan(0);
  });

  it("covers beats deterministically from shot links", () => {
    const data = seed();
    const ep = buildEpisodeCoverage(data, data.episodes[0].id);
    const byNum = new Map(ep.scenes.map((s) => [s.sceneNumber, s]));
    expect(byNum.get("1")!.percent).toBe(100);
    // Scene 6: Sean's line is covered by 6A, the action beat is deliberately unlinked.
    const s6 = byNum.get("6")!;
    expect(s6.total).toBe(2);
    expect(s6.covered).toBe(1);
    expect(s6.percent).toBe(50);
    expect(s6.uncovered.map((u) => u.kind)).toEqual(["action"]);
  });

  it("linking a shot to the uncovered beat raises coverage; unlinking lowers it", () => {
    const data = seed();
    const shot = shotByCode(data, "6A");
    const scene = data.scenes.find((s) => s.id === shot.sceneId)!;
    const block = data.actionBlocks.find((b) => b.sceneId === scene.id)!;
    expect(buildSceneCoverage(data, scene.id).percent).toBe(50);
    shot.scriptSources.actionBlockIds = [block.id];
    expect(buildSceneCoverage(data, scene.id).percent).toBe(100);
    shot.scriptSources.actionBlockIds = [];
    expect(buildSceneCoverage(data, scene.id).percent).toBe(50);
  });

  it("resolves a shot's linked source content", () => {
    const data = seed();
    const src = shotSourceContent(data, shotByCode(data, "3A"));
    expect(src.actions).toHaveLength(1);
    expect(src.dialogue.map((l) => l.originalText)).toEqual(["もう帰りたい……"]);
  });

  it("action block ids stay stable when the script is edited around them", () => {
    const data = seed();
    const ep = data.episodes[0];
    const edited = ep.scriptText.replace("The lobby is hushed.", "The lobby is hushed and gleaming.");
    const parsed = parseScreenplay(edited);
    const epScenes = data.scenes.filter((s) => s.episodeId === ep.id);
    const epLines = data.dialogueLines.filter((l) => l.episodeId === ep.id);
    const sync = syncScript(
      parsed,
      epScenes,
      epLines,
      (l) => l.speakerLabel,
      data.actionBlocks.filter((a) => a.episodeId === ep.id),
    );
    expect(sync.removedActionIds).toEqual([]);
    const matched = sync.scenes.flatMap((s) => s.actions).filter((a) => a.existingId);
    expect(matched).toHaveLength(data.actionBlocks.length);
    const lobby = sync.scenes[2].actions[0];
    expect(lobby.parsed.text).toContain("gleaming");
    expect(lobby.existingId).toBe(shotByCode(data, "3A").scriptSources.actionBlockIds[0]);
  });
});

describe("asset library", () => {
  it("reports where an asset is used, including shots reached via the character", () => {
    const data = seed();
    const ref = data.identityRefs.find(
      (r) => r.assetId && data.characters.find((c) => c.id === r.characterId)?.name === "Yumeko",
    )!;
    const u = findAssetUsage(data, ref.assetId!);
    expect(u.inUse).toBe(true);
    expect(u.direct[0].kind).toBe("identity_ref");
    expect(u.shots.length).toBeGreaterThan(3);
    expect(u.summary).toMatch(/^Used in \d+ shots/);
  });

  it("an unreferenced asset is safe to delete; a take's audio is not", () => {
    const data = seed();
    const orphan = { ...data.assets[0], id: "00000000-0000-4000-8000-000000000001", name: "orphan.png" };
    data.assets.push(orphan);
    expect(findAssetUsage(data, orphan.id).inUse).toBe(false);
    const takeAsset = data.takes.find((t) => t.audioAssetId)!.audioAssetId!;
    expect(findAssetUsage(data, takeAsset).inUse).toBe(true);
  });

  it("filters by kind and searches names, tags, characters, scenes and shots", () => {
    const data = seed();
    const usage = indexAssetUsage(data);
    expect(filterAssets(data, usage, { filter: "audio", q: "" }).every((a) => a.type === "audio")).toBe(true);
    const storyboard = filterAssets(data, usage, { filter: "storyboard", q: "" });
    expect(storyboard.length).toBeGreaterThan(5);
    const byShot = filterAssets(data, usage, { filter: "all", q: "3A storyboard" });
    expect(byShot.map((a) => a.name)).toContain("3A storyboard v1");
    expect(filterAssets(data, usage, { filter: "character", q: "yumeko" }).length).toBeGreaterThan(0);
    expect(filterAssets(data, usage, { filter: "all", q: "no-such-thing-xyz" })).toEqual([]);
  });
});
