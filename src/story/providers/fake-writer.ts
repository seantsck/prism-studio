import type { WritingResult } from "@/domain/story/writing";
import type { WritingRequest } from "../provider";

/**
 * Phase 5B-S2: the FREE test writer behind "Prism AI (test, free)". Deterministic, no network. It edits the target
 * passage in small, visible, screenplay-safe ways (a parenthetical on the named Character's cue, a reaction line, a
 * softened line, a short continuation), so diffs, alternatives, Accept and Reject can be exercised end to end. It never
 * touches a scene heading and never invents a Character.
 */
const HEADING = /^(INT\/EXT|INT|EXT|I\/E)[.\s]/i;
const CUE = /^[A-Z][A-Z0-9 .'’-]*(\s*\([^)]*\))?$/;

const TONES: Array<{ match: RegExp; words: string[]; reactions: string[]; summary: string }> = [
  {
    match: /guard|restrain|reserved|cool|distant|withh[eo]ld|less direct|too direct/i,
    words: ["guardedly", "coolly", "after a beat"],
    reactions: [
      "{name} holds his gaze, giving nothing away.",
      "{name}'s hands stay folded; only her eyes move.",
      "{name} lets the silence answer first.",
    ],
    summary: "made {name} more guarded and restrained",
  },
  {
    match: /warm|tender|gentle|kind|romantic|soft/i,
    words: ["warmly", "gently", "with a small smile"],
    reactions: [
      "{name} smiles despite herself.",
      "{name}'s voice softens.",
      "{name} reaches for his hand, then stops.",
    ],
    summary: "made it warmer",
  },
  {
    match: /tens|suspens|dark|threat|uneas/i,
    words: ["tightly", "a beat too long", "low"],
    reactions: ["Nobody moves.", "A glass trembles on the table.", "{name} glances at the door."],
    summary: "raised the tension",
  },
  {
    match: /funn|comic|humou?r|playful|lighter/i,
    words: ["deadpan", "too brightly", "with a perfectly straight face"],
    reactions: [
      "{name} takes a long, deliberate sip.",
      "{name} straightens a napkin that was already straight.",
      "{name} blinks. Twice.",
    ],
    summary: "made it funnier",
  },
];
const DEFAULT_TONE = {
  words: ["quietly", "evenly", "after a beat"],
  reactions: ["{name} takes this in.", "{name} looks away.", "{name} says nothing for a moment."],
  summary: "revised the passage",
};

const IDEAS = [
  ["Hold the silence", "Let a pause sit after the key line; {names} both wait for the other to speak first."],
  [
    "Interrupt the moment",
    "Have an existing interruption (a waiter, a phone) cut in just before the answer.",
  ],
  [
    "Raise what is at stake",
    "Make the cost of saying the true thing visible in the room, through what is already there.",
  ],
  ["A betraying detail", "Give {first} one small physical tell that contradicts the words."],
  ["Delay the answer", "Move the reply a beat later, so the question hangs over the action."],
  [
    "Put a clock on it",
    "Introduce a time pressure that already exists in the story (a car waiting, a call).",
  ],
  ["Let it be overheard", "Someone already in the scene could overhear; play the line knowing that."],
  ["Change the blocking", "Put distance, then closeness, between {names} at the turning point."],
  ["Make an object matter", "Let one prop already in the scene carry the subtext."],
  ["End on the unsaid", "Cut the scene before the obvious last line."],
];

const fill = (t: string, name: string, names: string, first: string) =>
  t.replaceAll("{name}", name).replaceAll("{names}", names).replaceAll("{first}", first);

function namedCharacters(req: WritingRequest): string[] {
  const all = req.context.characters.map((c) => c.name);
  return all.filter((n) =>
    new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(req.instruction),
  );
}

/** Put `(word)` on the named Character's cues (or every cue); report whether any cue was found. */
function parentheticals(text: string, word: string, names: string[]): { text: string; touched: boolean } {
  const lines = text.split("\n");
  const out: string[] = [];
  let touched = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    out.push(line);
    const t = line.trim();
    if (!t || HEADING.test(t) || !CUE.test(t) || t.startsWith("(")) continue;
    const next = lines[i + 1]?.trim() ?? "";
    if (!next || HEADING.test(next)) continue; // a cue needs dialogue
    const who = t.replace(/\s*\(.*\)$/, "").toLowerCase();
    if (names.length && !names.some((n) => n.toLowerCase() === who)) continue;
    touched = true;
    if (next.startsWith("(") && next.endsWith(")")) i++; // replace the existing parenthetical
    out.push(`(${word})`);
  }
  return { text: out.join("\n"), touched };
}

function soften(text: string) {
  return text.replace(/！/g, "。").replace(/!+/g, ".");
}

export function fakeWriting(req: WritingRequest): WritingResult {
  const names = namedCharacters(req);
  const present = req.context.characters.map((c) => c.name);
  const first = names[0] ?? present[0] ?? "She";
  const pair = (names.length ? names : present).slice(0, 2).join(" and ") || "the characters";
  const source = req.draftText ?? req.targetText;

  if (req.mode === "brainstorm") {
    const ideas = Array.from({ length: req.count }, (_, i) => {
      const [title, detail] = IDEAS[i % IDEAS.length]!;
      return {
        title: i < IDEAS.length ? title! : `${title} (${i + 1})`,
        detail: fill(detail!, first, pair, first) + " No new character is needed.",
      };
    });
    return {
      message: `Here are ${req.count} ideas. Nothing in the screenplay has changed — pick one to turn it into a revision.`,
      alternatives: [],
      ideas,
    };
  }

  const tone = TONES.find((t) => t.match.test(req.instruction)) ?? DEFAULT_TONE;
  const facts = /backstory|secret|history/i.test(req.instruction)
    ? [`${first} once kept a secret from her family (implied by this revision).`]
    : [];
  const alternatives = Array.from({ length: req.count }, (_, i) => {
    const word = tone.words[i % tone.words.length]! + (i >= tone.words.length ? ` (${i + 1})` : "");
    const reaction = fill(tone.reactions[i % tone.reactions.length]!, first, pair, first);
    let text: string;
    if (req.mode === "continue") {
      const other = present.find((n) => n !== first) ?? first;
      text = [reaction, "", other.toUpperCase(), `(${word})`, i % 2 ? "……そうですか。" : "……"].join("\n");
    } else if (req.mode === "condense") {
      text = source
        .split("\n")
        .filter(
          (l, j, all) =>
            !(l.trim().startsWith("(") && l.trim().endsWith(")")) && !(l === "" && all[j - 1] === ""),
        )
        .map((l) => (HEADING.test(l.trim()) ? l : l.replace(/^([^.。!?！？]*[.。!?！？]).+$/, "$1")))
        .join("\n");
      if (i > 0) text = text.replace(/……/g, "…".repeat(i));
    } else if (req.mode === "expand") {
      text = `${source.replace(/\s+$/, "")}\n\n${reaction}`;
    } else {
      const base = req.mode === "dialogue" ? soften(source) : source;
      const p = parentheticals(base, word, names);
      if (p.touched) text = p.text;
      else if (!source.includes("\n") && !HEADING.test(source.trim())) text = `(${word})\n${base}`;
      else text = `${base.replace(/\s+$/, "")}\n\n${reaction}`;
    }
    return {
      label: String.fromCharCode(65 + i),
      text,
      explanation: `Version ${String.fromCharCode(65 + i)}: ${word}.`,
      newCharacterFacts: facts,
    };
  });
  return {
    message: `I ${fill(tone.summary, first, pair, first)} without changing what happens.${
      req.count > 1 ? ` Here are ${req.count} versions.` : ""
    }`,
    alternatives,
    ideas: [],
  };
}
