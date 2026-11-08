import { inflateRawSync, inflateSync } from "node:zlib";
import { normalizeSourceText, type PageMap } from "@/domain/story/source";

/**
 * Phase 5B-S1: text extraction from an uploaded screenplay / treatment / outline. Dependency-free (node:zlib only),
 * pure, bounded. It extracts; it never guesses:
 *
 *   TXT / Fountain / Markdown   UTF-8 text (a file with NUL bytes or invalid UTF-8 is refused)
 *   DOCX                        word/document.xml from the ZIP container: paragraphs, tabs, breaks
 *   PDF                         text-based PDFs: Flate streams, object streams, the page tree in order, literal and hex
 *                               strings through each font's ToUnicode map (or plain single-byte text when a font has
 *                               none). A PDF whose pages carry images but no text is reported as needing OCR; text
 *                               that cannot be decoded reliably is refused. No OCR pipeline (out of scope for S1).
 */
export type StoryFileKind = "txt" | "fountain" | "docx" | "pdf";
export const STORY_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
const MAX_UNCOMPRESSED = 30 * 1024 * 1024;

export type Extraction =
  | { ok: true; kind: StoryFileKind; mime: string; text: string; pages: PageMap | null }
  | { ok: false; reason: string };

export const OCR_REQUIRED =
  "This PDF appears to require OCR (its pages are images without text). OCR is not available yet.";
export const PDF_UNREADABLE =
  "This PDF's text could not be extracted reliably (its fonts have no text mapping). Export it again as text, or paste the script.";

const ext = (name: string) => name.toLowerCase().split(".").pop() ?? "";

/** What the bytes ARE (magic bytes first; the extension only distinguishes plain-text flavours). */
export function sniffStoryFile(
  name: string,
  bytes: Uint8Array,
): { kind: StoryFileKind; mime: string } | null {
  if (bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)
    return { kind: "pdf", mime: "application/pdf" };
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04)
    return ext(name) === "docx"
      ? { kind: "docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }
      : null;
  if (bytes.includes(0)) return null;
  const e = ext(name);
  if (e === "fountain" || e === "spmd") return { kind: "fountain", mime: "text/plain" };
  if (e === "txt" || e === "text" || e === "md") return { kind: "txt", mime: "text/plain" };
  return null;
}

export function extractStoryText(name: string, bytes: Uint8Array): Extraction {
  if (bytes.length === 0) return { ok: false, reason: "The file is empty." };
  if (bytes.length > STORY_UPLOAD_MAX_BYTES)
    return { ok: false, reason: "The file is too large (limit 10 MB)." };
  const sniffed = sniffStoryFile(name, bytes);
  if (!sniffed) return { ok: false, reason: "Upload a PDF, DOCX, TXT or Fountain file." };
  try {
    if (sniffed.kind === "pdf") {
      const r = extractPdf(bytes);
      if (!r.ok) return r;
      return { ok: true, ...sniffed, text: r.text, pages: r.pages };
    }
    const raw = sniffed.kind === "docx" ? extractDocx(bytes) : decodeUtf8(bytes);
    if (raw === null)
      return {
        ok: false,
        reason:
          sniffed.kind === "docx" ? "This DOCX file could not be read." : "The text is not valid UTF-8.",
      };
    const text = normalizeSourceText(raw);
    if (!text) return { ok: false, reason: "No text was found in the file." };
    return { ok: true, ...sniffed, text, pages: null };
  } catch {
    return { ok: false, reason: "The file could not be read." };
  }
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

// ───────────────────────── DOCX (ZIP → word/document.xml) ─────────────────────────

function readZipEntry(bytes: Uint8Array, wanted: string): Uint8Array | null {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) return null;
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  for (let n = 0; n < count && p + 46 <= bytes.length; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) return null;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    if (name === wanted) {
      if (size > MAX_UNCOMPRESSED || dv.getUint32(local, true) !== 0x04034b50) return null;
      const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
      const data = bytes.subarray(start, start + compSize);
      if (method === 0) return data;
      if (method === 8) return new Uint8Array(inflateRawSync(data, { maxOutputLength: MAX_UNCOMPRESSED }));
      return null;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decodeXml = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) =>
    e[0] === "#"
      ? String.fromCodePoint(
          e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10),
        )
      : (XML_ENTITIES[e.toLowerCase()] ?? ""),
  );

export function extractDocx(bytes: Uint8Array): string | null {
  const xmlBytes = readZipEntry(bytes, "word/document.xml");
  if (!xmlBytes) return null;
  const xml = new TextDecoder("utf-8").decode(xmlBytes);
  const paragraphs = xml.match(/<w:p[\s>][\s\S]*?<\/w:p>|<w:p\/>/g) ?? [];
  return paragraphs
    .map((p) =>
      (p.match(/<w:t(?:\s[^>]*)?>[\s\S]*?<\/w:t>|<w:tab\/>|<w:br(?:\s[^>]*)?\/>|<w:cr\/>/g) ?? [])
        .map((t) =>
          t.startsWith("<w:tab")
            ? "\t"
            : t.startsWith("<w:br") || t.startsWith("<w:cr")
              ? "\n"
              : decodeXml(t.replace(/^<w:t(?:\s[^>]*)?>|<\/w:t>$/g, "")),
        )
        .join(""),
    )
    .join("\n");
}

// ───────────────────────── PDF (text-based) ─────────────────────────

type PdfObjects = Map<number, string>;
const latin1 = (b: Uint8Array) => Buffer.from(b).toString("latin1");

function inflateStream(dict: string, raw: Uint8Array): Uint8Array | null {
  if (/\/Filter\s*(\[\s*)?\/FlateDecode/.test(dict)) {
    try {
      return new Uint8Array(inflateSync(raw, { maxOutputLength: MAX_UNCOMPRESSED }));
    } catch {
      return null;
    }
  }
  return /\/Filter/.test(dict) ? null : raw;
}

/** Every `N 0 obj … endobj` (dictionary text + decoded stream as latin1), including those inside object streams. */
function readObjects(bytes: Uint8Array): { objects: PdfObjects; streams: Map<number, string> } {
  const src = latin1(bytes);
  const objects: PdfObjects = new Map();
  const streams = new Map<number, string>();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const num = Number(m[1]);
    const end = src.indexOf("endobj", re.lastIndex);
    if (end < 0) break;
    const body = src.slice(re.lastIndex, end);
    const si = body.indexOf("stream");
    if (si >= 0 && /^\s*<</.test(body)) {
      const dict = body.slice(0, si);
      let start = re.lastIndex + si + 6;
      if (src[start] === "\r") start++;
      if (src[start] === "\n") start++;
      const len = Number(dict.match(/\/Length\s+(\d+)(?!\s+\d+\s+R)/)?.[1] ?? NaN);
      const stop = Number.isFinite(len) ? start + len : src.indexOf("endstream", start);
      const decoded = inflateStream(dict, bytes.subarray(start, stop));
      objects.set(num, dict);
      if (decoded) streams.set(num, latin1(decoded));
    } else objects.set(num, body);
    re.lastIndex = end + 6;
  }
  // PDF 1.5 object streams: "num offset" pairs then the objects
  for (const [num, dict] of objects) {
    if (!/\/Type\s*\/ObjStm/.test(dict)) continue;
    const data = streams.get(num);
    const n = Number(dict.match(/\/N\s+(\d+)/)?.[1] ?? 0);
    const first = Number(dict.match(/\/First\s+(\d+)/)?.[1] ?? 0);
    if (!data || !n) continue;
    const header = data.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < n; i++) {
      const objNum = header[i * 2]!;
      const off = first + header[i * 2 + 1]!;
      const next = i + 1 < n ? first + header[(i + 1) * 2 + 1]! : data.length;
      if (!objects.has(objNum)) objects.set(objNum, data.slice(off, next));
    }
  }
  return { objects, streams };
}

const refOf = (s: string | undefined, key: string): number | null => {
  const m = s?.match(new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`));
  return m ? Number(m[1]) : null;
};

/** The inline dictionary that follows `/Key << … >>` (balanced), or the referenced object's text. */
function dictOf(objects: PdfObjects, s: string | undefined, key: string): string | undefined {
  if (!s) return undefined;
  const ref = refOf(s, key);
  if (ref !== null) return objects.get(ref);
  const i = s.search(new RegExp(`/${key}\\s*<<`));
  if (i < 0) return undefined;
  let depth = 0;
  for (let j = s.indexOf("<<", i); j < s.length - 1; j++) {
    if (s[j] === "<" && s[j + 1] === "<") {
      depth++;
      j++;
    } else if (s[j] === ">" && s[j + 1] === ">") {
      depth--;
      j++;
      if (depth === 0) return s.slice(s.indexOf("<<", i), j + 1);
    }
  }
  return undefined;
}

/** ToUnicode CMap → code (hex) to text. */
function parseCMap(cmap: string): { map: Map<string, string>; width: number } {
  const map = new Map<string, string>();
  let width = 1;
  const hexToText = (h: string) => {
    let out = "";
    for (let i = 0; i + 4 <= h.length; i += 4) out += String.fromCharCode(parseInt(h.slice(i, i + 4), 16));
    return out;
  };
  for (const block of cmap.match(/beginbfchar([\s\S]*?)endbfchar/g) ?? [])
    for (const m of block.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      map.set(m[1]!.toUpperCase(), hexToText(m[2]!));
      width = Math.max(width, m[1]!.length / 2);
    }
  for (const block of cmap.match(/beginbfrange([\s\S]*?)endbfrange/g) ?? [])
    for (const m of block.matchAll(
      /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<([0-9A-Fa-f]+)>|\[([^\]]*)\])/g,
    )) {
      const lo = parseInt(m[1]!, 16);
      const hi = parseInt(m[2]!, 16);
      const w = m[1]!.length;
      width = Math.max(width, w / 2);
      if (hi - lo > 65535) continue;
      const list = m[5] ? [...m[5].matchAll(/<([0-9A-Fa-f]+)>/g)].map((x) => x[1]!) : null;
      for (let c = lo; c <= hi; c++) {
        const code = c.toString(16).toUpperCase().padStart(w, "0");
        if (list) {
          const t = list[c - lo];
          if (t) map.set(code, hexToText(t));
        } else {
          const base = parseInt(m[4]!, 16);
          map.set(code, String.fromCharCode(base + (c - lo)));
        }
      }
    }
  return { map, width };
}

function literalBytes(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch !== "\\") {
      out.push(ch.charCodeAt(0) & 0xff);
      continue;
    }
    const n = s[++i];
    if (n === undefined) break;
    const esc: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12, "(": 40, ")": 41, "\\": 92 };
    if (n in esc) out.push(esc[n]!);
    else if (/[0-7]/.test(n)) {
      let oct = n;
      while (oct.length < 3 && /[0-7]/.test(s[i + 1] ?? "")) oct += s[++i];
      out.push(parseInt(oct, 8) & 0xff);
    } else if (n === "\r" || n === "\n") {
      if (n === "\r" && s[i + 1] === "\n") i++;
    } else out.push(n.charCodeAt(0) & 0xff);
  }
  return out;
}

interface Font {
  cmap: { map: Map<string, string>; width: number } | null;
}

function decodeString(bytes: number[], font: Font | undefined): string {
  if (font?.cmap) {
    const w = font.cmap.width;
    let out = "";
    for (let i = 0; i + w <= bytes.length; i += w) {
      const code = bytes
        .slice(i, i + w)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
        .toUpperCase();
      out += font.cmap.map.get(code) ?? "�";
    }
    return out;
  }
  return String.fromCharCode(...bytes.map((b) => (b < 32 && b !== 9 ? 0xfffd : b)));
}

/** Text of one content stream: strings through the active font; line breaks from text positioning. */
function contentText(stream: string, fonts: Map<string, Font>): string {
  let out = "";
  let font: Font | undefined;
  const tokens = stream.matchAll(
    /\((?:\\[\s\S]|[^\\)])*\)|<[0-9A-Fa-f\s]*>|\[|\]|\/[^\s/\[\]()<>]+|-?\d*\.?\d+|[A-Za-z'"*]+/g,
  );
  const operands: string[] = [];
  let inArray = false;
  let arrayText = "";
  const strBytes = (t: string): number[] =>
    t.startsWith("(")
      ? literalBytes(t.slice(1, -1))
      : (
          t
            .slice(1, -1)
            .replace(/\s+/g, "")
            .match(/.{1,2}/g) ?? []
        ).map((h) => parseInt(h.padEnd(2, "0"), 16));
  for (const [t] of tokens) {
    if (t === "[") {
      inArray = true;
      arrayText = "";
      continue;
    }
    if (t === "]") {
      inArray = false;
      operands.push(`\u0000${arrayText}`);
      continue;
    }
    if (inArray) {
      if (t.startsWith("(") || t.startsWith("<")) arrayText += decodeString(strBytes(t), font);
      else if (/^-?\d*\.?\d+$/.test(t) && Number(t) < -200) arrayText += " ";
      continue;
    }
    if (t.startsWith("(") || t.startsWith("<") || t.startsWith("/") || /^-?\d*\.?\d+$/.test(t)) {
      operands.push(t);
      continue;
    }
    switch (t) {
      case "Tf":
        font = fonts.get(operands[operands.length - 2]?.slice(1) ?? "");
        break;
      case "Tj":
      case "'":
      case '"': {
        const s = operands[operands.length - 1];
        if (t !== "Tj") out += "\n";
        if (s && (s.startsWith("(") || s.startsWith("<"))) out += decodeString(strBytes(s), font);
        break;
      }
      case "TJ": {
        const s = operands[operands.length - 1];
        if (s?.startsWith("\u0000")) out += s.slice(1);
        break;
      }
      case "T*":
        out += "\n";
        break;
      case "Td":
      case "TD":
        if (Number(operands[operands.length - 1]) !== 0) out += "\n";
        else out += " ";
        break;
      case "Tm":
        out += "\n";
        break;
      case "ET":
        out += "\n";
        break;
    }
    operands.length = 0;
  }
  return out;
}

export function extractPdf(
  bytes: Uint8Array,
): { ok: true; text: string; pages: PageMap } | { ok: false; reason: string } {
  const { objects, streams } = readObjects(bytes);
  const catalog = [...objects.entries()].find(([, d]) => /\/Type\s*\/Catalog/.test(d));
  const pagesRef = refOf(catalog?.[1], "Pages");
  const pages: number[] = [];
  const walk = (num: number | null, depth = 0) => {
    if (num === null || depth > 50) return;
    const d = objects.get(num) ?? "";
    if (/\/Type\s*\/Page(?!s)/.test(d)) pages.push(num);
    else
      for (const k of d.match(/\/Kids\s*\[([^\]]*)\]/)?.[1]?.matchAll(/(\d+)\s+\d+\s+R/g) ?? [])
        walk(Number(k[1]), depth + 1);
  };
  walk(pagesRef);
  if (pages.length === 0) return { ok: false, reason: "This PDF has no readable pages." };

  const fontCache = new Map<number, Font>();
  const pageTexts: string[] = [];
  let hasImages = false;
  let replacement = 0;
  let visible = 0;
  for (const pageNum of pages) {
    const page = objects.get(pageNum) ?? "";
    let resources = dictOf(objects, page, "Resources");
    // inherited Resources (from the parent Pages node)
    for (let parent = refOf(page, "Parent"), i = 0; !resources && parent !== null && i < 20; i++) {
      resources = dictOf(objects, objects.get(parent), "Resources");
      parent = refOf(objects.get(parent), "Parent");
    }
    if (/\/XObject/.test(resources ?? "")) {
      const xobjects = dictOf(objects, resources, "XObject") ?? "";
      for (const r of xobjects.matchAll(/(\d+)\s+\d+\s+R/g))
        if (/\/Subtype\s*\/Image/.test(objects.get(Number(r[1])) ?? "")) hasImages = true;
    }
    const fonts = new Map<string, Font>();
    const fontDict = dictOf(objects, resources, "Font") ?? "";
    for (const m of fontDict.matchAll(/\/([^\s/<>\[\]]+)\s+(\d+)\s+\d+\s+R/g)) {
      const num = Number(m[2]);
      if (!fontCache.has(num)) {
        const toUnicode = refOf(objects.get(num), "ToUnicode");
        const cmapText = toUnicode !== null ? streams.get(toUnicode) : undefined;
        fontCache.set(num, { cmap: cmapText ? parseCMap(cmapText) : null });
      }
      fonts.set(m[1]!, fontCache.get(num)!);
    }
    const contentRefs: number[] = [];
    const single = refOf(page, "Contents");
    if (single !== null) contentRefs.push(single);
    else
      for (const r of page.match(/\/Contents\s*\[([^\]]*)\]/)?.[1]?.matchAll(/(\d+)\s+\d+\s+R/g) ?? [])
        contentRefs.push(Number(r[1]));
    const text = contentRefs
      .map((r) => streams.get(r) ?? "")
      .map((s) => contentText(s, fonts))
      .join("\n");
    replacement += (text.match(/�/g) ?? []).length;
    visible += (text.match(/[^\s�]/g) ?? []).length;
    pageTexts.push(
      text
        .split("\n")
        .map((l) => l.replace(/[ \t]+/g, " ").trim())
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim(),
    );
  }
  // text that is there but cannot be decoded is refused (never guessed); pages without text need OCR
  if (replacement > 0 && replacement > visible * 0.05) return { ok: false, reason: PDF_UNREADABLE };
  if (visible === 0 || (visible < 20 * pages.length && hasImages)) return { ok: false, reason: OCR_REQUIRED };
  // join pages; remember where each page starts (1-based line numbers of the normalized text)
  const pageMap: PageMap = [];
  const parts: string[] = [];
  let line = 1;
  for (const t of pageTexts) {
    const norm = normalizeSourceText(t);
    pageMap.push(line);
    parts.push(norm);
    line += (norm ? norm.split("\n").length : 0) + 1;
  }
  return { ok: true, text: parts.join("\n\n").replace(/^\n+/, ""), pages: pageMap };
}
