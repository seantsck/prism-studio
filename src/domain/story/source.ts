import { createHash } from "node:crypto";

/**
 * Phase 5B-S1: the analysed SOURCE TEXT. Whatever the creator gave (pasted text, an uploaded TXT / Fountain / DOCX /
 * PDF, or the project's own Episode script) becomes ONE normalized text whose 1-based line numbers are the citation
 * space for every proposal item. Pure.
 */
export const MAX_SOURCE_CHARS = 1_500_000;
export const STORY_SOURCE_KINDS = ["paste", "upload", "episode_script"] as const;
export type StorySourceKind = (typeof STORY_SOURCE_KINDS)[number];

/** LF line endings, no BOM, no NUL, trailing whitespace trimmed per line; otherwise verbatim (no rewriting). */
export function normalizeSourceText(raw: string): string {
  return raw
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "")
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""))
    .join("\n")
    .trim();
}

export const sourceFingerprint = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
export const lineCount = (text: string) => (text ? text.split("\n").length : 0);

/** The text as the model reads it: each line prefixed with its number, so every citation is a line range. */
export function numberedSource(text: string): string {
  const lines = text.split("\n");
  const width = String(lines.length).length;
  return lines.map((l, i) => `${String(i + 1).padStart(width, "0")}| ${l}`).join("\n");
}

/** A short excerpt for the review screen ("Why did Prism create this?"), read from the stored source by range. */
export function excerpt(text: string, r: { startLine: number; endLine: number }, maxChars = 240): string {
  const lines = text.split("\n").slice(r.startLine - 1, r.endLine);
  const joined = lines.join(" ").replace(/\s+/g, " ").trim();
  return joined.length > maxChars ? `${joined.slice(0, maxChars - 1)}…` : joined;
}

/** For a PDF: the first line of each page (1-based), so a line range can be shown as pages. */
export type PageMap = number[];

export function pagesFor(
  r: { startLine: number; endLine: number },
  pages: PageMap | null | undefined,
): string | null {
  if (!pages || pages.length === 0) return null;
  const pageOf = (line: number) => {
    let p = 1;
    for (let i = 0; i < pages.length; i++) if (pages[i]! <= line) p = i + 1;
    return p;
  };
  const a = pageOf(r.startLine);
  const b = pageOf(r.endLine);
  return a === b ? `page ${a}` : `pages ${a}–${b}`;
}

/** Human citation for several ranges: "lines 12–18, 40" or "pages 1–3, 7". */
export function describeSources(
  ranges: ReadonlyArray<{ startLine: number; endLine: number }>,
  pages?: PageMap | null,
): string {
  if (ranges.length === 0) return "no source cited";
  if (pages && pages.length) {
    const ps = [...new Set(ranges.map((r) => pagesFor(r, pages)!))];
    return ps.join(", ");
  }
  return `lines ${ranges.map((r) => (r.startLine === r.endLine ? `${r.startLine}` : `${r.startLine}–${r.endLine}`)).join(", ")}`;
}

/**
 * Conservative pre-request token estimate (a ceiling for the spend gate, never a quote): ~1 token per 3.5 characters of
 * numbered input, plus the fixed instructions and schema. Actual usage always comes from the provider's response.
 */
export function estimateInputTokens(text: string, overheadTokens = 4000): number {
  return Math.ceil(numberedSource(text).length / 3.5) + overheadTokens;
}
