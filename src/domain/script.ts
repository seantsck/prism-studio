import type { ActionBlock, DialogueLine, INT_EXT, Scene } from "./schemas";

/**
 * Screenplay-oriented script model (Fountain-lite):
 *
 *   INT. SEDAN - NIGHT            <- scene heading
 *   Action paragraph.             <- action
 *   YUMEKO                        <- character cue (uppercase / Japanese name line)
 *   (quietly)                     <- parenthetical, optional
 *   もう帰りたい……                  <- dialogue
 *   SEAN: Inline cue works too.   <- inline cue
 */

export type ParsedBlock =
  | { kind: "action"; text: string; line: number; endLine: number }
  | { kind: "dialogue"; speaker: string; text: string; parenthetical: string; line: number; endLine: number };

export interface ParsedScene {
  slugline: string;
  intExt: (typeof INT_EXT)[number];
  location: string;
  timeOfDay: string;
  startLine: number;
  endLine: number;
  blocks: ParsedBlock[];
}

const HEADING = /^(INT\/EXT|INT|EXT|I\/E)[.\s]/i;

function parseHeading(raw: string): Pick<ParsedScene, "intExt" | "location" | "timeOfDay"> {
  const m = raw.match(/^(INT\/EXT|INT|EXT|I\/E)[.\s]+(.*)$/i);
  const prefix = (m?.[1] ?? "INT").toUpperCase();
  const rest = (m?.[2] ?? raw).trim();
  const [location, ...tod] = rest.split(/\s+-\s+/);
  return {
    intExt: prefix === "EXT" ? "EXT" : prefix === "INT" ? "INT" : "INT/EXT",
    location: (location ?? "").trim(),
    timeOfDay: tod.join(" - ").trim(),
  };
}

const isCue = (line: string) =>
  /^[A-Z0-9][A-Z0-9 .'’()\-]{0,38}$/.test(line) && !HEADING.test(line) && /[A-Z]/.test(line);

export function parseScreenplay(text: string): ParsedScene[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const scenes: ParsedScene[] = [];
  let current: ParsedScene | null = null;
  let actionBuf: { text: string[]; line: number; endLine: number } | null = null;

  const flushAction = () => {
    if (current && actionBuf && actionBuf.text.length > 0) {
      current.blocks.push({
        kind: "action",
        text: actionBuf.text.join(" "),
        line: actionBuf.line,
        endLine: actionBuf.endLine,
      });
    }
    actionBuf = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    const lineNo = i + 1;
    if (HEADING.test(raw)) {
      flushAction();
      if (current) current.endLine = lineNo - 1;
      current = { slugline: raw, ...parseHeading(raw), startLine: lineNo, endLine: lineNo, blocks: [] };
      scenes.push(current);
      continue;
    }
    if (!current) continue;
    if (raw === "") {
      flushAction();
      continue;
    }

    const inline = raw.match(/^([^\s:：()]{1,30}(?:\s[A-Z.()']{1,20})?)\s*[:：]\s*(.+)$/);
    if (inline && (isCue(inline[1]) || /^[぀-ヿ一-鿿]/.test(inline[1]))) {
      flushAction();
      current.blocks.push({
        kind: "dialogue",
        speaker: inline[1].trim(),
        text: inline[2].trim(),
        parenthetical: "",
        line: lineNo,
        endLine: lineNo,
      });
      continue;
    }

    const next = lines[i + 1]?.trim() ?? "";
    if (isCue(raw) && next !== "" && !HEADING.test(next)) {
      flushAction();
      let j = i + 1;
      let parenthetical = "";
      if (/^\(.*\)$/.test(lines[j].trim())) {
        parenthetical = lines[j].trim();
        j++;
      }
      const dialogue: string[] = [];
      while (j < lines.length && lines[j].trim() !== "") dialogue.push(lines[j++].trim());
      current.blocks.push({
        kind: "dialogue",
        speaker: raw,
        text: dialogue.join("\n"),
        parenthetical,
        line: lineNo,
        endLine: Math.max(lineNo, j),
      });
      i = j - 1;
      continue;
    }

    if (!actionBuf) actionBuf = { text: [], line: lineNo, endLine: lineNo };
    actionBuf.text.push(raw);
    actionBuf.endLine = lineNo;
  }
  flushAction();
  if (current) (current as ParsedScene).endLine = lines.length;
  return scenes;
}

// ───────────────────────── Stable-ID sync ─────────────────────────

export interface SyncedLine {
  parsed: Extract<ParsedBlock, { kind: "dialogue" }>;
  existingId: string | null;
  /** Locked dialogue keeps its stored text; the script edit is reported, never applied. */
  lockedConflict: { storedText: string; scriptText: string } | null;
}
export interface SyncedAction {
  parsed: Extract<ParsedBlock, { kind: "action" }>;
  existingId: string | null;
}
export interface SyncedScene {
  parsed: ParsedScene;
  existingId: string | null;
  lines: SyncedLine[];
  actions: SyncedAction[];
}
export interface ScriptSyncResult {
  scenes: SyncedScene[];
  removedSceneIds: string[];
  removedLineIds: string[];
  removedActionIds: string[];
  lockedConflicts: Array<{ lineId: string; storedText: string; scriptText: string }>;
}

/**
 * Re-associate parsed script blocks with existing scene/line IDs so IDs stay stable across edits.
 * Scenes match by slugline (then by position); lines match by speaker+text, then by next unused line of that speaker.
 * Locked lines are never rewritten.
 */
export function syncScript(
  parsed: readonly ParsedScene[],
  existingScenes: readonly Scene[],
  existingLines: readonly DialogueLine[],
  speakerNameFor: (line: DialogueLine) => string,
  existingActions: readonly ActionBlock[] = [],
): ScriptSyncResult {
  const usedScenes = new Set<string>();
  const usedLines = new Set<string>();
  const usedActions = new Set<string>();
  const lockedConflicts: ScriptSyncResult["lockedConflicts"] = [];

  const scenes = parsed.map<SyncedScene>((p, index) => {
    const bySlug = existingScenes.find(
      (s) => !usedScenes.has(s.id) && s.slugline.toLowerCase() === p.slugline.toLowerCase(),
    );
    const byPos = existingScenes.find((s) => !usedScenes.has(s.id) && s.order === index);
    const match = bySlug ?? byPos ?? null;
    if (match) usedScenes.add(match.id);

    const sceneLines = match
      ? existingLines.filter((l) => l.sceneId === match.id).sort((a, b) => a.order - b.order)
      : [];
    const lines = p.blocks
      .filter((b): b is Extract<ParsedBlock, { kind: "dialogue" }> => b.kind === "dialogue")
      .map<SyncedLine>((b) => {
        const key = b.speaker.toLowerCase();
        const sameSpeaker = sceneLines.filter(
          (l) => speakerNameFor(l).toLowerCase() === key && !usedLines.has(l.id),
        );
        const exact = sameSpeaker.find((l) => l.originalText === b.text);
        const positional = sameSpeaker[0];
        const found = exact ?? positional ?? null;
        if (found) usedLines.add(found.id);
        const conflict =
          found && found.locked && found.originalText !== b.text
            ? { storedText: found.originalText, scriptText: b.text }
            : null;
        if (found && conflict) lockedConflicts.push({ lineId: found.id, ...conflict });
        return { parsed: b, existingId: found?.id ?? null, lockedConflict: conflict };
      });
    const sceneActions = match
      ? existingActions.filter((a) => a.sceneId === match.id).sort((a, b) => a.order - b.order)
      : [];
    const actions = p.blocks
      .filter((b): b is Extract<ParsedBlock, { kind: "action" }> => b.kind === "action")
      .map<SyncedAction>((b) => {
        // Same text first (survives reordering), then the next unused block by position.
        const exact = sceneActions.find((a) => !usedActions.has(a.id) && a.text === b.text);
        const positional = sceneActions.find((a) => !usedActions.has(a.id));
        const found = exact ?? positional ?? null;
        if (found) usedActions.add(found.id);
        return { parsed: b, existingId: found?.id ?? null };
      });
    return { parsed: p, existingId: match?.id ?? null, lines, actions };
  });

  return {
    scenes,
    removedSceneIds: existingScenes.filter((s) => !usedScenes.has(s.id)).map((s) => s.id),
    removedLineIds: existingLines.filter((l) => !usedLines.has(l.id)).map((l) => l.id),
    removedActionIds: existingActions.filter((a) => !usedActions.has(a.id)).map((a) => a.id),
    lockedConflicts,
  };
}

/** Render scenes + dialogue back to script text (used for seeds and script regeneration). */
export function renderScreenplay(
  scenes: readonly Scene[],
  actionsByScene: Record<string, string[]>,
  linesByScene: Record<string, Array<{ speaker: string; text: string; parenthetical?: string }>>,
): string {
  return scenes
    .map((s) => {
      const parts = [s.slugline, ""];
      for (const a of actionsByScene[s.id] ?? []) parts.push(a, "");
      for (const l of linesByScene[s.id] ?? []) {
        parts.push(l.speaker);
        if (l.parenthetical) parts.push(l.parenthetical);
        parts.push(l.text, "");
      }
      return parts.join("\n");
    })
    .join("\n");
}
