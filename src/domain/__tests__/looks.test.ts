import { describe, expect, it } from "vitest";
import { assignLook, validateLookLink } from "@/domain/looks";
import { seed, shotByCode } from "./helpers";

describe("character Look linking", () => {
  it("links a Look by id without copying wardrobe text into the shot", () => {
    const data = seed();
    const shot = shotByCode(data, "3A");
    const look = data.looks.find((l) => l.name.includes("Formal Black"))!;
    const linked = assignLook(shot, shot.characters[0].characterId, look.id, data.looks);
    expect(linked.characters[0].lookId).toBe(look.id);
    expect(JSON.stringify(linked)).not.toContain(look.wardrobe);
  });

  it("rejects a Look that belongs to another character", () => {
    const data = seed();
    const shot = shotByCode(data, "3A");
    const seanLook = data.looks.find((l) => l.name.includes("Charcoal"))!;
    expect(() => assignLook(shot, shot.characters[0].characterId, seanLook.id, data.looks)).toThrow(
      /different character/,
    );
    expect(
      validateLookLink(
        { characterId: shot.characters[0].characterId, lookId: seanLook.id },
        data.looks,
        shot.episodeId,
      )?.code,
    ).toBe("look_character_mismatch");
  });

  it("rejects unknown Looks and characters not in the shot", () => {
    const data = seed();
    const shot = shotByCode(data, "3A");
    expect(() => assignLook(shot, shot.characters[0].characterId, "nope", data.looks)).toThrow();
    expect(() => assignLook(shot, "ghost", null, data.looks)).toThrow(/not assigned/);
  });
});
