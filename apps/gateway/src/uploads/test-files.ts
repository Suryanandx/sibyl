/**
 * Real sample files for tests and live checks (not used by the gateway):
 * a ZIP writer with CRCs, so the Office / OpenDocument / EPUB files built
 * here open in other tools too, plus PDF, RTF and email builders.
 */
import { crc32, deflateRawSync } from "node:zlib";

const esc = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A ZIP archive (deflate; "stored" for entries listed in `store`). */
export function makeZip(files: Record<string, string | Buffer>, options: { store?: string[] } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = Buffer.from(name, "utf8");
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const stored = options.store?.includes(name) ?? false;
    const data = stored ? raw : deflateRawSync(raw);
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralSize = centrals.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

/** A one-page PDF with a text layer (Helvetica, one line per entry). */
export function makePdf(lines: string[] | string): Buffer {
  const list = Array.isArray(lines) ? lines : [lines];
  const stream = list.map((line, index) => `BT /F1 18 Tf 20 ${120 - index * 24} Td (${line.replace(/[()\\]/g, "\\$&")}) Tj ET`).join("\n");
  return pdfFromObjects([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ]);
}

/** A "scanned" PDF: one page that is only a JPEG image (no text layer). */
export function makeImagePdf(jpeg: Buffer, width: number, height: number): Buffer {
  const ops = `q ${width} 0 0 ${height} 0 0 cm /Im1 Do Q`;
  return pdfFromObjects([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> >> >>`,
    `<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`,
    Buffer.concat([
      Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`, "latin1"),
      jpeg,
      Buffer.from("\nendstream", "latin1")
    ])
  ]);
}

function pdfFromObjects(objects: Array<string | Buffer>): Buffer {
  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n", "latin1")];
  let length = chunks[0]!.length;
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(length);
    const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`, "latin1"), Buffer.isBuffer(body) ? body : Buffer.from(body, "latin1"), Buffer.from("\nendobj\n", "latin1")]);
    chunks.push(chunk);
    length += chunk.length;
  });
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`, "latin1"));
  return Buffer.concat(chunks);
}

export function makeDocx(paragraphs: string[]): Buffer {
  const body = paragraphs.map((text) => `<w:p><w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`).join("");
  return makeZip({
    "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    "word/document.xml": `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`
  });
}

/** An Excel workbook; cells are inline strings or numbers. */
export function makeXlsx(sheets: Array<{ name: string; rows: Array<Array<string | number>> }>): Buffer {
  const files: Record<string, string> = {
    "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`,
    "xl/workbook.xml": `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets>${sheets
      .map((sheet, index) => `<sheet name="${esc(sheet.name)}" sheetId="${index + 1}"/>`)
      .join("")}</sheets></workbook>`
  };
  sheets.forEach((sheet, index) => {
    const rows = sheet.rows
      .map((row, r) => {
        const cells = row
          .map((value, c) => {
            const ref = `${String.fromCharCode(65 + c)}${r + 1}`;
            return typeof value === "number" ? `<c r="${ref}"><v>${value}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t>${esc(value)}</t></is></c>`;
          })
          .join("");
        return `<row r="${r + 1}">${cells}</row>`;
      })
      .join("");
    files[`xl/worksheets/sheet${index + 1}.xml`] = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
  });
  return makeZip(files);
}

const DRAWING_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

function shapes(paragraphs: string[]): string {
  return `<p:sp><p:txBody>${paragraphs.map((text) => `<a:p><a:r><a:t>${esc(text)}</a:t></a:r></a:p>`).join("")}</p:txBody></p:sp>`;
}

/**
 * A PowerPoint deck. `order` lists slide file numbers in presentation order
 * (default 1..n), to check the reader follows the presentation, not file names.
 */
export function makePptx(slides: Array<{ text: string[]; notes?: string[] }>, order?: number[]): Buffer {
  const numbers = order ?? slides.map((_slide, index) => index + 1);
  const files: Record<string, string> = {
    "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>`,
    "ppt/presentation.xml": `<?xml version="1.0"?><p:presentation ${DRAWING_NS}><p:sldIdLst>${numbers
      .map((number, index) => `<p:sldId id="${256 + index}" r:id="rId${number}"/>`)
      .join("")}</p:sldIdLst></p:presentation>`,
    "ppt/_rels/presentation.xml.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slides
      .map((_slide, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`)
      .join("")}</Relationships>`
  };
  slides.forEach((slide, index) => {
    const n = index + 1;
    files[`ppt/slides/slide${n}.xml`] = `<?xml version="1.0"?><p:sld ${DRAWING_NS}><p:cSld><p:spTree>${shapes(slide.text)}</p:spTree></p:cSld></p:sld>`;
    if (slide.notes) {
      files[`ppt/slides/_rels/slide${n}.xml.rels`] = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${n}.xml"/></Relationships>`;
      files[`ppt/notesSlides/notesSlide${n}.xml`] = `<?xml version="1.0"?><p:notes ${DRAWING_NS}><p:cSld><p:spTree>${shapes(slide.notes)}<p:sp><p:txBody><a:p><a:fld type="slidenum"><a:t>${n}</a:t></a:fld></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`;
    }
  });
  return makeZip(files);
}

const ODF_NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0"';

function odf(mime: string, body: string): Buffer {
  return makeZip(
    {
      mimetype: mime,
      "META-INF/manifest.xml": `<?xml version="1.0"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="/" manifest:media-type="${mime}"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>`,
      "content.xml": `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${ODF_NS} office:version="1.3"><office:body>${body}</office:body></office:document-content>`
    },
    { store: ["mimetype"] }
  );
}

export function makeOdt(blocks: Array<{ heading?: string; text?: string }>): Buffer {
  const body = blocks
    .map((block) => (block.heading ? `<text:h text:outline-level="1">${esc(block.heading)}</text:h>` : `<text:p>${esc(block.text ?? "")}</text:p>`))
    .join("");
  return odf("application/vnd.oasis.opendocument.text", `<office:text>${body}</office:text>`);
}

export function makeOds(sheets: Array<{ name: string; rows: string[][] }>): Buffer {
  const body = sheets
    .map(
      (sheet) =>
        `<table:table table:name="${esc(sheet.name)}">${sheet.rows
          .map((row) => `<table:table-row>${row.map((cell) => `<table:table-cell office:value-type="string"><text:p>${esc(cell)}</text:p></table:table-cell>`).join("")}<table:table-cell table:number-columns-repeated="1000"/></table:table-row>`)
          .join("")}<table:table-row table:number-rows-repeated="1048000"><table:table-cell table:number-columns-repeated="1024"/></table:table-row></table:table>`
    )
    .join("");
  return odf("application/vnd.oasis.opendocument.spreadsheet", `<office:spreadsheet>${body}</office:spreadsheet>`);
}

export function makeOdp(slides: Array<{ text: string[]; notes?: string[] }>): Buffer {
  const body = slides
    .map(
      (slide, index) =>
        `<draw:page draw:name="page${index + 1}"><draw:frame><draw:text-box>${slide.text.map((line) => `<text:p>${esc(line)}</text:p>`).join("")}</draw:text-box></draw:frame>${
          slide.notes ? `<presentation:notes><draw:frame><draw:text-box>${slide.notes.map((line) => `<text:p>${esc(line)}</text:p>`).join("")}</draw:text-box></draw:frame></presentation:notes>` : ""
        }</draw:page>`
    )
    .join("");
  return odf("application/vnd.oasis.opendocument.presentation", `<office:presentation>${body}</office:presentation>`);
}

/** An EPUB 3 book; the spine lists chapters in the given order (file names in reverse, to test spine order). */
export function makeEpub(title: string, chapters: Array<{ title: string; text: string }>): Buffer {
  const files: Record<string, string> = {
    mimetype: "application/epub+zip",
    "META-INF/container.xml": `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`
  };
  const count = chapters.length;
  const fileFor = (index: number) => `text/ch${count - index}.xhtml`;
  files["OEBPS/content.opf"] = `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${esc(title)}</dc:title><dc:identifier id="id">sample</dc:identifier><dc:language>en</dc:language></metadata><manifest>${chapters
    .map((_chapter, index) => `<item media-type="application/xhtml+xml" href="${fileFor(index)}" id="c${index}"/>`)
    .join("")}</manifest><spine>${chapters.map((_chapter, index) => `<itemref idref="c${index}"/>`).join("")}</spine></package>`;
  chapters.forEach((chapter, index) => {
    files[`OEBPS/${fileFor(index)}`] = `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${esc(chapter.title)}</title></head><body><h1>${esc(chapter.title)}</h1><p>${esc(chapter.text)}</p></body></html>`;
  });
  return makeZip(files, { store: ["mimetype"] });
}

export function makeRtf(paragraphs: string[]): Buffer {
  const body = paragraphs.map((text) => `${text.replace(/[\\{}]/g, "\\$&").replace(/[^\x20-\x7e]/g, (ch) => `\\u${ch.charCodeAt(0)}?`)}\\par\n`).join("");
  return Buffer.from(`{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Times New Roman;}}{\\colortbl;\\red0\\green0\\blue0;}{\\*\\generator Sibyl tests;}\\f0\\fs24 ${body}}`, "latin1");
}

/** A multipart email: a quoted-printable text part, an HTML part and one attachment. */
export function makeEml(input: { from: string; to: string; subject: string; text: string; html?: string; attachment?: string }): Buffer {
  const boundary = "b1_sibyl";
  const alt = "b2_sibyl";
  const qp = (value: string) => Buffer.from(value, "utf8").toString("latin1").replace(/[=\x80-\xff]/g, (ch) => `=${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
  const lines = [
    `From: ${input.from}`,
    `To: ${input.to}`,
    `Subject: =?UTF-8?B?${Buffer.from(input.subject, "utf8").toString("base64")}?=`,
    "Date: Mon, 9 Nov 2026 10:00:00 +0000",
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    "",
    `--${alt}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    qp(input.text),
    `--${alt}`,
    "Content-Type: text/html; charset=utf-8",
    "",
    input.html ?? `<p>${esc(input.text)}</p>`,
    `--${alt}--`,
    ...(input.attachment
      ? [`--${boundary}`, `Content-Type: application/pdf; name="${input.attachment}"`, `Content-Disposition: attachment; filename="${input.attachment}"`, "Content-Transfer-Encoding: base64", "", "JVBERi0xLjQK"]
      : []),
    `--${boundary}--`,
    ""
  ];
  return Buffer.from(lines.join("\r\n"), "latin1");
}
