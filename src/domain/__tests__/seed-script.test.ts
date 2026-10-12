import { describe, expect, it } from "vitest";
import {
  assetSchema,
  bibleSchema,
  characterSchema,
  continuityCheckSchema,
  dialogueLineSchema,
  episodeSchema,
  generationAttemptSchema,
  locationSchema,
  lookSchema,
  performanceDirectionSchema,
  performanceTakeSchema,
  projectSchema,
  sceneSchema,
  shotSchema,
  storyboardFrameSchema,
  voiceProfileSchema,
} from "@/domain/schemas";
import { parseScreenplay, syncScript } from "@/domain/script";
import { buildAnimaticTimeline } from "@/domain/animatic";
import { seed } from "./helpers";

describe("seed fixtures", () => {
  it("validate against the domain schemas", () => {
    const d = seed();
    projectSchema.parse(d.project);
    bibleSchema.parse(d.bible);
    const groups: Array<[{ parse: (x: unknown) => unknown }, unknown[]]> = [
      [assetSchema, d.assets],
      [characterSchema, d.characters],
      [lookSchema, d.looks],
      [voiceProfileSchema, d.voiceProfiles],
      [locationSchema, d.locations],
      [episodeSchema, d.episodes],
      [sceneSchema, d.scenes],
      [shotSchema, d.shots],
      [dialogueLineSchema, d.dialogueLines],
      [performanceDirectionSchema, d.directions],
      [performanceTakeSchema, d.takes],
      [storyboardFrameSchema, d.frames],
      [generationAttemptSchema, d.attempts],
      [continuityCheckSchema, d.continuityChecks],
    ];
    for (const [schema, items] of groups) for (const item of items) schema.parse(item);
    expect(d.shots).toHaveLength(14);
  });
});

describe("script parsing and stable-ID sync", () => {
  it("round-trips the seeded script onto the same scene and line ids", () => {
    const d = seed();
    const parsed = parseScreenplay(d.episodes[0].scriptText);
    expect(parsed).toHaveLength(6);
    const sync = syncScript(parsed, d.scenes, d.dialogueLines, (l) => l.speakerLabel);
    expect(sync.scenes.every((s) => s.existingId)).toBe(true);
    expect(sync.scenes.flatMap((s) => s.lines).every((l) => l.existingId)).toBe(true);
    expect(sync.removedLineIds).toEqual([]);
    expect(sync.lockedConflicts).toEqual([]);
  });

  it("reports locked dialogue edits instead of applying them", () => {
    const d = seed();
    const text = d.episodes[0].scriptText.replace("もう帰りたい……", "帰りたくない。");
    const sync = syncScript(parseScreenplay(text), d.scenes, d.dialogueLines, (l) => l.speakerLabel);
    expect(sync.lockedConflicts).toHaveLength(1);
    expect(sync.lockedConflicts[0].storedText).toBe("もう帰りたい……");
  });
});

describe("animatic timeline", () => {
  it("sequences clips by duration and places dialogue cues after pre-roll", () => {
    const d = seed();
    const t = buildAnimaticTimeline(d, d.episodes[0].id);
    expect(t.clips).toHaveLength(14);
    expect(t.totalMs).toBe(t.clips.reduce((s, c) => s + c.durationMs, 0));
    const c3a = t.clips.find((c) => c.shotCode === "3A")!;
    expect(c3a.durationMs).toBe(4500);
    expect(c3a.cues[0].startMs).toBe(c3a.startMs + 800);
    expect(t.clips[1].startMs).toBe(t.clips[0].durationMs);
  });
});
