/**
 * /api/skills — the Skills screen's API, behind gateProtectedRoute():
 *
 *   GET    /api/skills                      skills.use  → { skills }
 *   GET    /api/skills/:id                  skills.use  → { skill }
 *   GET    /api/skills/:id/versions         skills.use  → { versions }
 *   GET    /api/skills/:id/export           skills.use  → SKILL.md or <name>.zip
 *   POST   /api/skills          SkillInput  skills.edit → { skill }
 *   PATCH  /api/skills/:id      partial     skills.edit → { skill }
 *   DELETE /api/skills/:id                  skills.edit
 *   POST   /api/skills/:id/restore {version} skills.edit → { skill }
 *   POST   /api/skills/import[?scope=all]   skills.edit → { skill, updated, skipped }
 *          body: a zip (application/zip), a SKILL.md (text/markdown or text/plain),
 *          or JSON { files: [{ path, content }] } for a folder.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { parseSkillInput, type SkillInput } from "@open-gpt-live/protocol";
import {
  corsGuard,
  headerValue,
  isUnder,
  readBody,
  readJson,
  requestPath,
  requestUrl,
  requestWorkspace,
  runRoute,
  sendBodyError,
  sendJson,
  type ApiOptions
} from "../http/index.js";
import { exportSkill, importSkillFolder, importSkillMarkdown, importSkillZip, MAX_ARCHIVE_BYTES } from "./archive.js";
import { SkillError, type SkillsService } from "./service.js";
import { SkillFormatError, slugify } from "./skill-md.js";

export interface SkillsHttpOptions extends ApiOptions {
  skills: SkillsService;
}

const METHODS = "GET, POST, PATCH, DELETE, OPTIONS";
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function isSkillsPath(path: string): boolean {
  return isUnder(path, "/api/skills");
}

export function handleSkillsHttp(options: SkillsHttpOptions, request: IncomingMessage, response: ServerResponse): boolean {
  const path = requestPath(request);
  if (!isSkillsPath(path)) return false;
  return runRoute(response, options.log, "skills.http_failed", serve(options, request, response, path));
}

async function serve(options: SkillsHttpOptions, request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
  const cors = corsGuard(request, response, options.allowedOrigins, METHODS);
  if (!cors) return;
  const reply = (status: number, body: unknown) => sendJson(response, status, body, cors);
  const method = request.method ?? "GET";
  const workspaceId = requestWorkspace(request);
  const { skills } = options;
  const parts = path.slice("/api/skills".length).split("/").filter(Boolean).map(decodeURIComponent);
  const json = () => readJson(request, 1024 * 1024);

  try {
    if (parts.length === 0) {
      if (method === "GET") {
        request.resume();
        return reply(200, { skills: await skills.list(workspaceId) });
      }
      if (method === "POST") {
        const parsed = parseSkillInput(await json());
        if (!parsed.success) return reply(400, { error: "invalid", message: parsed.error });
        return reply(201, { skill: await skills.create(workspaceId, parsed.data as SkillInput) });
      }
    }
    const [first, second] = parts;
    if (parts.length === 1 && first === "import" && method === "POST") {
      const scope = requestUrl(request).searchParams.get("scope") === "all" ? "all" : "workspace";
      const type = String(request.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
      const raw = await readBody(request, MAX_ARCHIVE_BYTES);
      const fileName = decodeHeader(headerValue(request, "x-filename"));
      let bundle;
      if (type === "application/zip" || type === "application/x-zip-compressed" || /\.zip$/i.test(fileName)) {
        bundle = importSkillZip(raw);
      } else if (type === "application/json") {
        const body = JSON.parse(raw.toString("utf8")) as { files?: unknown; markdown?: unknown; name?: unknown };
        if (typeof body.markdown === "string") bundle = importSkillMarkdown(body.markdown, typeof body.name === "string" ? slugify(body.name) : undefined);
        else bundle = importSkillFolder(body.files);
      } else {
        const base = fileName.replace(/\.(md|markdown|txt)$/i, "");
        bundle = importSkillMarkdown(raw.toString("utf8"), base && base.toLowerCase() !== "skill" ? slugify(base) : undefined);
      }
      return reply(201, await skills.importBundle(workspaceId, bundle, scope));
    }
    if (!first || !ID.test(first)) {
      request.resume();
      return reply(404, { error: "not_found" });
    }
    if (parts.length === 1) {
      if (method === "GET") {
        request.resume();
        return reply(200, { skill: await skills.get(workspaceId, first) });
      }
      if (method === "PATCH") {
        const parsed = parseSkillInput(await json(), true);
        if (!parsed.success) return reply(400, { error: "invalid", message: parsed.error });
        return reply(200, { skill: await skills.update(workspaceId, first, parsed.data) });
      }
      if (method === "DELETE") {
        request.resume();
        await skills.remove(workspaceId, first);
        return reply(200, { ok: true });
      }
    }
    if (parts.length === 2 && second === "versions" && method === "GET") {
      request.resume();
      return reply(200, { versions: await skills.versions(workspaceId, first) });
    }
    if (parts.length === 2 && second === "restore" && method === "POST") {
      const body = (await json()) as { version?: unknown };
      if (typeof body.version !== "string") return reply(400, { error: "invalid", message: "version is required" });
      return reply(200, { skill: await skills.restore(workspaceId, first, body.version) });
    }
    if (parts.length === 2 && second === "export" && method === "GET") {
      request.resume();
      const skill = await skills.get(workspaceId, first);
      const file = exportSkill(skill);
      response.writeHead(200, {
        ...cors,
        "content-type": file.contentType,
        "content-length": String(file.data.byteLength),
        "content-disposition": `attachment; filename="${file.fileName}"`,
        "cache-control": "no-store",
        "access-control-expose-headers": "content-disposition"
      });
      response.end(file.data);
      return;
    }
    request.resume();
    return reply(404, { error: "not_found" });
  } catch (error) {
    if (error instanceof SkillError) return reply(error.status, { error: error.code, message: error.message });
    if (error instanceof SkillFormatError) return reply(400, { error: "invalid_skill", message: error.message });
    if (sendBodyError(response, error, cors)) return;
    throw error;
  }
}

function decodeHeader(raw: string | undefined): string {
  if (!raw) return "";
  try {
    return decodeURIComponent(raw).slice(0, 200);
  } catch {
    return raw.slice(0, 200);
  }
}
