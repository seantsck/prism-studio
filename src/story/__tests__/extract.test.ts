import { deflateRawSync, deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { extractStoryText, OCR_REQUIRED, PDF_UNREADABLE, sniffStoryFile } from "../extract";

/** Phase 5B-S1: text extraction from uploaded files (fixtures built here; no external tooling). */
const enc = (s: string) => new Uint8Array(Buffer.from(s, "utf8"));

/** A minimal ZIP holding the given entries (deflated). */
function zip(entries: Record<string, string>): Uint8Array {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const data = Buffer.from(text, "utf8");
    const comp = deflateRawSync(data);
    const nameBuf = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, comp);
    central.push(cd, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cdBuf, eocd]));
}

const docxXml = (paras: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="x"><w:body>${paras
    .map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`)
    .join("")}</w:body></w:document>`;

/** A minimal PDF: pages are content-stream strings (Flate-compressed), optional fonts / images. */
function pdf(
  pages: Array<{ content: string; font?: "plain" | "cmap"; image?: boolean }>,
  cmap?: string,
): Uint8Array {
  const objs: string[] = [];
  const add = (body: string) => {
    objs.push(body);
    return objs.length;
  };
  const stream = (dict: string, data: string, compress = true) => {
    const bytes = compress ? deflateSync(Buffer.from(data, "latin1")) : Buffer.from(data, "latin1");
    return `<< ${dict} /Length ${bytes.length}${compress ? " /Filter /FlateDecode" : ""} >>\nstream\n${bytes.toString("latin1")}\nendstream`;
  };
  const catalog = add("<< /Type /Catalog /Pages 2 0 R >>");
  add("PAGES");
  const toUnicode = cmap ? add(stream("", cmap)) : null;
  const plainFont = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const cmapFont = toUnicode
    ? add(`<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /ToUnicode ${toUnicode} 0 R >>`)
    : null;
  const image = add(
    stream(
      "/Type /XObject /Subtype /Image /Width 1 /Height 1 /BitsPerComponent 8 /ColorSpace /DeviceGray",
      "\u0000",
      false,
    ),
  );
  const kids: number[] = [];
  for (const p of pages) {
    const content = add(stream("", p.content));
    const font = p.font === "cmap" ? cmapFont : plainFont;
    kids.push(
      add(
        `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 ${font} 0 R >>${p.image ? ` /XObject << /Im1 ${image} 0 R >>` : ""} >> /Contents ${content} 0 R >>`,
      ),
    );
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  const body = objs.map((o, i) => `${i + 1} 0 obj\n${o}\nendobj\n`).join("");
  void catalog;
  return new Uint8Array(Buffer.from(`%PDF-1.4\n${body}trailer << /Root 1 0 R >>\n%%EOF\n`, "latin1"));
}

describe("story file extraction", () => {
  it("TXT and Fountain are UTF-8 text, normalized; binary or invalid UTF-8 is refused", () => {
    const r = extractStoryText("ojousama.txt", enc("﻿INT. LOBBY - NIGHT\r\nYUMEKO\r\nもう帰りたい。\r\n"));
    expect(r).toMatchObject({
      ok: true,
      kind: "txt",
      text: "INT. LOBBY - NIGHT\nYUMEKO\nもう帰りたい。",
      pages: null,
    });
    expect(extractStoryText("x.fountain", enc("EXT. STREET - DAY"))).toMatchObject({
      ok: true,
      kind: "fountain",
    });
    expect(extractStoryText("x.txt", new Uint8Array([0xff, 0xfe, 0x41, 0x42, 0x43, 0x44]))).toMatchObject({
      ok: false,
    });
    expect(extractStoryText("x.exe", enc("MZ"))).toMatchObject({ ok: false });
    expect(extractStoryText("x.txt", new Uint8Array())).toEqual({ ok: false, reason: "The file is empty." });
  });

  it("DOCX: paragraphs from word/document.xml; a ZIP that is not a DOCX is refused", () => {
    const bytes = zip({
      "[Content_Types].xml": "<Types/>",
      "word/document.xml": docxXml([
        "INT. GRAND CELESTE LOBBY - NIGHT",
        "Yumeko crosses the lobby &amp; stops.",
        "YUMEKO",
      ]),
    });
    expect(sniffStoryFile("script.docx", bytes)?.kind).toBe("docx");
    expect(extractStoryText("script.docx", bytes)).toMatchObject({
      ok: true,
      kind: "docx",
      text: "INT. GRAND CELESTE LOBBY - NIGHT\nYumeko crosses the lobby & stops.\nYUMEKO",
    });
    expect(extractStoryText("archive.zip", bytes)).toMatchObject({ ok: false });
    expect(extractStoryText("broken.docx", zip({ "other.xml": "<x/>" }))).toMatchObject({ ok: false });
  });

  it("PDF (text-based): pages in order, line breaks from positioning, and a page map", () => {
    const bytes = pdf([
      {
        content:
          "BT /F1 12 Tf 72 720 Td (INT. GRAND CELESTE LOBBY - NIGHT) Tj 0 -14 Td (Yumeko enters.) Tj ET",
      },
      { content: "BT /F1 12 Tf 72 720 Td [(YU) -20 (MEKO)] TJ T* (I want to go home.) Tj ET" },
    ]);
    const r = extractStoryText("ojousama.pdf", bytes);
    expect(r).toMatchObject({ ok: true, kind: "pdf" });
    if (!r.ok) return;
    expect(r.text).toBe("INT. GRAND CELESTE LOBBY - NIGHT\nYumeko enters.\n\nYUMEKO\nI want to go home.");
    expect(r.pages).toEqual([1, 4]);
  });

  it("PDF with a ToUnicode font (hex codes) is decoded through its map", () => {
    const cmap = [
      "/CIDInit /ProcSet findresource begin begincmap",
      "1 begincodespacerange <0000> <FFFF> endcodespacerange",
      "2 beginbfchar <0001> <0049> <0002> <004E> endbfchar",
      "1 beginbfrange <0003> <0004> <0054> endbfrange",
      "endcmap",
    ].join("\n");
    // 0001 0002 0003 → I N T ; 0004 → U
    const r = extractStoryText(
      "cid.pdf",
      pdf([{ content: "BT /F1 12 Tf <000100020003> Tj ET", font: "cmap" }], cmap),
    );
    expect(r).toMatchObject({ ok: true, text: "INT" });
  });

  it("a scanned PDF (images, no text) needs OCR; undecodable text is refused, never guessed", () => {
    expect(
      extractStoryText("scan.pdf", pdf([{ content: "q 612 0 0 792 0 0 cm /Im1 Do Q", image: true }])),
    ).toEqual({
      ok: false,
      reason: OCR_REQUIRED,
    });
    const garbage = pdf([{ content: `BT /F1 12 Tf (${"\u0001\u0002\u0003".repeat(30)}) Tj ET` }]);
    expect(extractStoryText("odd.pdf", garbage)).toEqual({ ok: false, reason: PDF_UNREADABLE });
  });
});
