/**
 * Phase 5B-S2: a human-readable diff for revision review (Original vs Proposed). Pure.
 *
 * Line-level first (LCS over lines), then word-level inside each changed line pair, so a large Scene rewrite reads as
 * "these lines changed, and within them these words". Japanese text has no spaces: tokens fall back to characters for
 * runs of non-ASCII text, which keeps highlights tight.
 */
export type DiffOp = "same" | "add" | "del";
export interface DiffSegment {
  op: DiffOp;
  text: string;
}
export interface DiffLine {
  op: "same" | "add" | "del" | "change";
  /** For `change`: word-level segments of the merged line. */
  segments: DiffSegment[];
}

const MAX_CELLS = 4_000_000;

function lcs<T>(a: T[], b: T[], eq: (x: T, y: T) => boolean): Array<{ op: DiffOp; a?: T; b?: T }> {
  const n = a.length;
  const m = b.length;
  if (n * m > MAX_CELLS) {
    // too large to align precisely: everything removed, then everything added (still truthful)
    return [...a.map((x) => ({ op: "del" as const, a: x })), ...b.map((y) => ({ op: "add" as const, b: y }))];
  }
  const t: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      t[i]![j] = eq(a[i]!, b[j]!) ? t[i + 1]![j + 1]! + 1 : Math.max(t[i + 1]![j]!, t[i]![j + 1]!);
  const out: Array<{ op: DiffOp; a?: T; b?: T }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (eq(a[i]!, b[j]!)) {
      out.push({ op: "same", a: a[i]!, b: b[j]! });
      i++;
      j++;
    } else if (t[i + 1]![j]! >= t[i]![j + 1]!) out.push({ op: "del", a: a[i++]! });
    else out.push({ op: "add", b: b[j++]! });
  }
  while (i < n) out.push({ op: "del", a: a[i++]! });
  while (j < m) out.push({ op: "add", b: b[j++]! });
  return out;
}

/** Words + whitespace for ASCII; single characters for non-ASCII runs. */
export function tokens(s: string): string[] {
  return s.match(/\s+|[A-Za-z0-9_'’-]+|[^\sA-Za-z0-9_'’-]/g) ?? [];
}

function merge(segs: DiffSegment[]): DiffSegment[] {
  const out: DiffSegment[] = [];
  for (const s of segs) {
    const last = out.at(-1);
    if (last && last.op === s.op) last.text += s.text;
    else if (s.text) out.push({ ...s });
  }
  return out;
}

export function diffWords(a: string, b: string): DiffSegment[] {
  return merge(
    lcs(tokens(a), tokens(b), (x, y) => x === y).map((d) => ({
      op: d.op,
      text: (d.op === "add" ? d.b : d.a) ?? "",
    })),
  );
}

export function diffLines(original: string, proposed: string): DiffLine[] {
  const steps = lcs(original.split("\n"), proposed.split("\n"), (x, y) => x === y);
  const out: DiffLine[] = [];
  for (let k = 0; k < steps.length; k++) {
    const s = steps[k]!;
    if (s.op === "same") {
      out.push({ op: "same", segments: [{ op: "same", text: s.a! }] });
      continue;
    }
    // pair a run of deletions with the following run of additions as "changed" lines (word-level inside)
    const dels: string[] = [];
    const adds: string[] = [];
    while (k < steps.length && steps[k]!.op === "del") dels.push(steps[k++]!.a!);
    while (k < steps.length && steps[k]!.op === "add") adds.push(steps[k++]!.b!);
    k--;
    const pairs = Math.min(dels.length, adds.length);
    for (let p = 0; p < pairs; p++) out.push({ op: "change", segments: diffWords(dels[p]!, adds[p]!) });
    for (const d of dels.slice(pairs)) out.push({ op: "del", segments: [{ op: "del", text: d }] });
    for (const a of adds.slice(pairs)) out.push({ op: "add", segments: [{ op: "add", text: a }] });
  }
  return out;
}

export function diffStats(lines: DiffLine[]) {
  let added = 0;
  let removed = 0;
  for (const l of lines)
    for (const s of l.segments) {
      if (s.op === "add") added += s.text.length;
      if (s.op === "del") removed += s.text.length;
    }
  return { added, removed, changedLines: lines.filter((l) => l.op !== "same").length };
}
