/**
 * `read_file`: lets the brain page through the extracted text of an upload
 * (the prompt only carries the beginning of long files).
 */
import { DEFAULT_WORKSPACE_ID, type ToolDefinition } from "@open-gpt-live/core";
import type { UploadService } from "./service.js";

export const READ_FILE_DEFAULT_CHARS = 8_000;
export const READ_FILE_MAX_CHARS = 20_000;

export function createUploadTools(uploads: UploadService): ToolDefinition<any, any>[] {
  const readFileTool: ToolDefinition<{ id: string; offset?: number; length?: number }, { id: string; offset: number; end: number; total: number }> = {
    name: "read_file",
    title: "Read an attached file",
    description:
      "Read the text of a file the user attached (PDF, Word, Excel, CSV, JSON, text). Pass the file id from the " +
      "[Attached files] block and an optional character offset to continue where the excerpt stopped. " +
      `Returns up to ${READ_FILE_MAX_CHARS} characters per call.`,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "File id, e.g. up_0123…" },
        offset: { type: "integer", minimum: 0, description: "Character offset to start at (default 0)." },
        length: { type: "integer", minimum: 1, maximum: READ_FILE_MAX_CHARS, description: `Characters to read (default ${READ_FILE_DEFAULT_CHARS}).` }
      },
      required: ["id"],
      additionalProperties: false
    },
    effect: "read",
    source: "builtin",
    provider: "uploads",
    async run(input, context) {
      const id = typeof input?.id === "string" ? input.id.trim() : "";
      const file = await uploads.get(id, { ownerId: context.ownerId, workspaceId: context.workspaceId ?? DEFAULT_WORKSPACE_ID });
      if (!file) return { content: `No attached file with id "${id}".`, isError: true };
      if (file.kind === "image") return { content: `${file.name} is an image; it has no text to read.`, isError: true };
      const text = await uploads.readText(file.id);
      const offset = Math.max(0, Math.floor(Number(input?.offset ?? 0)) || 0);
      const length = Math.min(READ_FILE_MAX_CHARS, Math.max(1, Math.floor(Number(input?.length ?? READ_FILE_DEFAULT_CHARS)) || READ_FILE_DEFAULT_CHARS));
      if (offset >= text.length) {
        return { content: `${file.name}: offset ${offset} is past the end (${text.length} characters).`, data: { id: file.id, offset, end: offset, total: text.length } };
      }
      const end = Math.min(text.length, offset + length);
      const header = `${file.name} — characters ${offset}–${end} of ${text.length}${end < text.length ? ` (continue with offset ${end})` : " (end of file)"}`;
      return { content: `${header}\n\n${text.slice(offset, end)}`, data: { id: file.id, offset, end, total: text.length } };
    }
  };
  return [readFileTool];
}
