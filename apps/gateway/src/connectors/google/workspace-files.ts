/** Google Drive, Docs and Sheets actions. */
import { int, objectSchema, optionalInt, optionalString, requireId, requireString, requireTable, seg, str, table } from "../common.js";
import { DEFAULT_READ_CHARS, MAX_READ_CHARS, fileToText, pageOfText } from "../files.js";
import type { ConnectorAction, ConnectorActionContext } from "../types.js";

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  size?: string;
  webViewLink?: string;
  owners?: Array<{ displayName?: string; emailAddress?: string }>;
}

const drive = (ctx: ConnectorActionContext) => `${ctx.base("drive")}/drive/v3`;
const docsApi = (ctx: ConnectorActionContext) => `${ctx.base("docs")}/v1/documents`;
const sheetsApi = (ctx: ConnectorActionContext) => `${ctx.base("sheets")}/v4/spreadsheets`;

/** Google-native types are exported to text; everything else is downloaded. */
const EXPORTS: Record<string, { mime: string; ext: string }> = {
  "application/vnd.google-apps.document": { mime: "text/plain", ext: ".txt" },
  "application/vnd.google-apps.spreadsheet": { mime: "text/csv", ext: ".csv" },
  "application/vnd.google-apps.presentation": { mime: "text/plain", ext: ".txt" },
  "application/vnd.google-apps.drawing": { mime: "image/svg+xml", ext: ".svg" }
};

const FILE_FIELDS = "id,name,mimeType,modifiedTime,size,webViewLink,owners(displayName,emailAddress)";

function fileView(file: DriveFile) {
  return {
    id: file.id,
    name: file.name,
    type: friendlyType(file.mimeType),
    modified: file.modifiedTime,
    owner: file.owners?.[0]?.displayName ?? file.owners?.[0]?.emailAddress,
    size: file.size ? Number(file.size) : undefined,
    link: file.webViewLink
  };
}

function friendlyType(mime: string): string {
  if (mime.startsWith("application/vnd.google-apps.")) return `google-${mime.slice("application/vnd.google-apps.".length)}`;
  return mime;
}

/** Escape a value for a Drive query string literal. */
function quote(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** Docs body → plain text (paragraphs and table cells). */
function docText(content: unknown[] | undefined): string {
  const out: string[] = [];
  const walk = (elements: unknown[] | undefined) => {
    for (const element of elements ?? []) {
      const e = element as Record<string, any>;
      if (e.paragraph) out.push(((e.paragraph.elements ?? []) as Array<Record<string, any>>).map((p) => p.textRun?.content ?? "").join(""));
      if (e.table) for (const row of e.table.tableRows ?? []) for (const cell of row.tableCells ?? []) walk(cell.content);
      if (e.tableOfContents) walk(e.tableOfContents.content);
    }
  };
  walk(content);
  return out.join("").replace(/\n{3,}/g, "\n\n").trim();
}

const rangeHelp = "A1 notation including the sheet name, e.g. 'Sheet1!A1:D20' or 'Budget'.";

export const driveActions: ConnectorAction[] = [
  {
    name: "drive_search",
    group: "drive_read",
    title: "Search Google Drive",
    effect: "read",
    description: "Find files in the user's Google Drive (and shared drives) by words in their name or content. Returns id, name, type, modified time, owner and link.",
    inputSchema: objectSchema(
      {
        query: str("Words to look for in names and content."),
        type: { type: "string", description: "Only this kind of file.", enum: ["any", "document", "spreadsheet", "presentation", "pdf", "folder"] },
        maxResults: int("Max files (default 15).", 1, 50)
      },
      ["query"]
    ),
    async run(input, ctx) {
      const words = requireString(input, "query", 500);
      const types: Record<string, string> = {
        document: "application/vnd.google-apps.document",
        spreadsheet: "application/vnd.google-apps.spreadsheet",
        presentation: "application/vnd.google-apps.presentation",
        pdf: "application/pdf",
        folder: "application/vnd.google-apps.folder"
      };
      const type = typeof input.type === "string" ? types[input.type] : undefined;
      const q = [`(name contains ${quote(words)} or fullText contains ${quote(words)})`, "trashed = false", ...(type ? [`mimeType = ${quote(type)}`] : [])].join(" and ");
      const result = await ctx.http.get<{ files?: DriveFile[] }>(`${drive(ctx)}/files`, {
        q,
        pageSize: optionalInt(input, "maxResults", 1, 50, 15),
        fields: `files(${FILE_FIELDS})`,
        orderBy: "modifiedTime desc",
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        corpora: "allDrives"
      });
      const files = (result.files ?? []).map(fileView);
      return { summary: `Found ${files.length} file${files.length === 1 ? "" : "s"}.`, data: { files } };
    }
  },
  {
    name: "drive_read_file",
    group: "drive_read",
    title: "Read a Drive file",
    effect: "read",
    description:
      "Read the text of a Google Drive file by id: Google Docs and Slides as text, Sheets as CSV, and uploaded PDF, Word (.docx), Excel (.xlsx), CSV, JSON and text files. Long files come in pages: pass nextOffset to continue.",
    inputSchema: objectSchema(
      {
        fileId: str("File id from drive_search."),
        offset: int("Character offset to start from (default 0).", 0, 50_000_000),
        maxChars: int(`Characters to return (default ${DEFAULT_READ_CHARS}).`, 500, MAX_READ_CHARS)
      },
      ["fileId"]
    ),
    async run(input, ctx) {
      const fileId = requireId(input, "fileId");
      const meta = await ctx.http.get<DriveFile>(`${drive(ctx)}/files/${seg(fileId)}`, { fields: FILE_FIELDS, supportsAllDrives: true });
      const exportAs = EXPORTS[meta.mimeType];
      let data: Buffer;
      let name = meta.name;
      if (exportAs) {
        data = (await ctx.http.request<Buffer>({ url: `${drive(ctx)}/files/${seg(fileId)}/export`, query: { mimeType: exportAs.mime }, responseType: "buffer", maxBytes: 10 * 1024 * 1024 })).data;
        name = `${meta.name}${exportAs.ext}`;
      } else if (meta.mimeType.startsWith("application/vnd.google-apps.")) {
        return { summary: "This kind of Google file can't be read as text.", data: fileView(meta) };
      } else {
        data = (await ctx.http.request<Buffer>({ url: `${drive(ctx)}/files/${seg(fileId)}`, query: { alt: "media", supportsAllDrives: true }, responseType: "buffer" })).data;
      }
      const text = await fileToText(data, name);
      if (!text) return { summary: "This file type can't be read as text (images, audio, video and archives aren't supported).", data: fileView(meta) };
      const page = pageOfText(text.text, optionalInt(input, "offset", 0, 50_000_000, 0), optionalInt(input, "maxChars", 500, MAX_READ_CHARS, DEFAULT_READ_CHARS));
      return { data: { file: fileView(meta), ...page } };
    }
  },
  {
    name: "docs_read",
    group: "docs_read",
    title: "Read a Google Doc",
    effect: "read",
    description: "Read the text of a Google Doc by its document id (from the URL docs.google.com/document/d/<id> or drive_search).",
    inputSchema: objectSchema(
      {
        documentId: str("Document id."),
        offset: int("Character offset (default 0).", 0, 50_000_000),
        maxChars: int(`Characters to return (default ${DEFAULT_READ_CHARS}).`, 500, MAX_READ_CHARS)
      },
      ["documentId"]
    ),
    async run(input, ctx) {
      const doc = await ctx.http.get<{ documentId: string; title?: string; body?: { content?: unknown[] } }>(`${docsApi(ctx)}/${seg(requireId(input, "documentId"))}`);
      const page = pageOfText(docText(doc.body?.content), optionalInt(input, "offset", 0, 50_000_000, 0), optionalInt(input, "maxChars", 500, MAX_READ_CHARS, DEFAULT_READ_CHARS));
      return { data: { documentId: doc.documentId, title: doc.title, ...page } };
    }
  },
  {
    name: "docs_create",
    group: "docs_write",
    title: "Create a Google Doc",
    effect: "write",
    description: "Create a new Google Doc with a title and optional starting text. Returns its id and link.",
    inputSchema: objectSchema({ title: str("Document title."), text: str("Initial text (plain).") }, ["title"]),
    async run(input, ctx) {
      const doc = await ctx.http.post<{ documentId: string; title?: string }>(docsApi(ctx), { title: requireString(input, "title", 300) });
      const text = optionalString(input, "text", 100_000);
      if (text) {
        await ctx.http.post(`${docsApi(ctx)}/${seg(doc.documentId)}:batchUpdate`, { requests: [{ insertText: { location: { index: 1 }, text } }] });
      }
      return { summary: "Document created.", data: { documentId: doc.documentId, title: doc.title, link: `https://docs.google.com/document/d/${doc.documentId}/edit` } };
    }
  },
  {
    name: "docs_append",
    group: "docs_write",
    title: "Append to a Google Doc",
    effect: "write",
    description: "Add text at the end of an existing Google Doc.",
    inputSchema: objectSchema({ documentId: str("Document id."), text: str("Text to append (plain; start with a newline to begin a new paragraph).") }, ["documentId", "text"]),
    async run(input, ctx) {
      const documentId = requireId(input, "documentId");
      await ctx.http.post(`${docsApi(ctx)}/${seg(documentId)}:batchUpdate`, {
        requests: [{ insertText: { endOfSegmentLocation: {}, text: requireString(input, "text", 100_000) } }]
      });
      return { summary: "Text appended.", data: { documentId, link: `https://docs.google.com/document/d/${documentId}/edit` } };
    }
  },
  {
    name: "sheets_read_range",
    group: "sheets_read",
    title: "Read a Google Sheet range",
    effect: "read",
    description: `Read cell values from a Google Sheet. Range: ${rangeHelp} Use a sheet name alone for the whole sheet.`,
    inputSchema: objectSchema({ spreadsheetId: str("Spreadsheet id (from its URL or drive_search)."), range: str(rangeHelp) }, ["spreadsheetId", "range"]),
    async run(input, ctx) {
      const result = await ctx.http.get<{ range?: string; values?: unknown[][] }>(
        `${sheetsApi(ctx)}/${seg(requireId(input, "spreadsheetId"))}/values/${seg(requireString(input, "range", 300))}`,
        { valueRenderOption: "FORMATTED_VALUE" }
      );
      const rows = result.values ?? [];
      return { summary: `${rows.length} row${rows.length === 1 ? "" : "s"}.`, data: { range: result.range, rows } };
    }
  },
  {
    name: "sheets_append_rows",
    group: "sheets_write",
    title: "Append rows to a Google Sheet",
    effect: "write",
    description: `Add rows after the last row of a table in a Google Sheet. Values are entered as if typed (formulas and dates work). Range: ${rangeHelp}`,
    inputSchema: objectSchema({ spreadsheetId: str("Spreadsheet id."), range: str(rangeHelp), rows: table("Rows to add; each row is a list of cell values.") }, ["spreadsheetId", "range", "rows"]),
    async run(input, ctx) {
      const result = await ctx.http.post<{ updates?: { updatedRange?: string; updatedRows?: number } }>(
        `${sheetsApi(ctx)}/${seg(requireId(input, "spreadsheetId"))}/values/${seg(requireString(input, "range", 300))}:append`,
        { values: requireTable(input, "rows") },
        { valueInputOption: "USER_ENTERED", insertDataOption: "INSERT_ROWS" }
      );
      return { summary: `Added ${result.updates?.updatedRows ?? 0} row(s).`, data: result.updates };
    }
  },
  {
    name: "sheets_update_range",
    group: "sheets_write",
    title: "Update a Google Sheet range",
    effect: "write",
    description: `Overwrite cells in a Google Sheet range with new values (entered as if typed). Range: ${rangeHelp}`,
    inputSchema: objectSchema({ spreadsheetId: str("Spreadsheet id."), range: str(rangeHelp), values: table("New values, row by row.") }, ["spreadsheetId", "range", "values"]),
    async run(input, ctx) {
      const result = await ctx.http.put<{ updatedRange?: string; updatedCells?: number }>(
        `${sheetsApi(ctx)}/${seg(requireId(input, "spreadsheetId"))}/values/${seg(requireString(input, "range", 300))}`,
        { values: requireTable(input, "values") },
        { valueInputOption: "USER_ENTERED" }
      );
      return { summary: `Updated ${result.updatedCells ?? 0} cell(s).`, data: { updatedRange: result.updatedRange, updatedCells: result.updatedCells } };
    }
  }
];
