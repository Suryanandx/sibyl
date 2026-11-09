/**
 * Brain tools: search_knowledge and list_knowledge (read), and
 * save_to_knowledge (write: adds an uploaded file to a base, after approval).
 * Each runs in the caller's workspace and checks knowledge.view / .edit for
 * the principal it runs as (chat user, routine or monitor creator); a call
 * without a principal is refused. When an agent with limited access runs
 * the call, only its knowledge bases are listed, searched or written.
 */
import { authorize, DEFAULT_WORKSPACE_ID, PERMISSIONS, type Permission, type ToolContext, type ToolDefinition } from "@open-gpt-live/core";
import type { KnowledgeHitView } from "@open-gpt-live/protocol";
import { KnowledgeError, type KnowledgeService } from "./service.js";

function denied(context: ToolContext, permission: Permission): string | undefined {
  // Every run carries who it acts for; without one, fail closed.
  if (!context.principal) return "Knowledge can only be used on behalf of a signed-in person.";
  return authorize(context.principal, permission, { workspaceId: context.workspaceId ?? DEFAULT_WORKSPACE_ID })
    ? undefined
    : "You don't have access to this workspace's knowledge.";
}

/** The knowledge bases an agent is limited to (undefined: no extra limit). */
function agentBases(context: ToolContext): ReadonlySet<string> | undefined {
  const ids = context.agent?.knowledgeBaseIds;
  return ids ? new Set(ids) : undefined;
}

function formatHits(hits: KnowledgeHitView[]): string {
  return hits
    .map((hit, index) => `[${index + 1}] ${hit.citation} (${hit.baseName}${hit.url ? `, ${hit.url}` : ""})\n${hit.snippet}`)
    .join("\n\n");
}

export function createKnowledgeTools(knowledge: KnowledgeService): ToolDefinition<any, any>[] {
  const search: ToolDefinition<{ query: string; knowledgeBaseIds?: string[]; limit?: number }, { hits: KnowledgeHitView[] }> = {
    name: "search_knowledge",
    title: "Search knowledge",
    description:
      "Search this workspace's knowledge bases (uploaded files, saved web pages, pasted notes) and return the best matching " +
      "passages with citations. Use it when the user asks about their own documents, policies, notes or anything that may be in " +
      "their knowledge bases. Cite answers as [document › section]. Optionally limit to knowledgeBaseIds from list_knowledge.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords or a short question." },
        knowledgeBaseIds: { type: "array", items: { type: "string" }, description: "Only these bases (default: all in the workspace)." },
        limit: { type: "integer", minimum: 1, maximum: 12, description: "How many passages (default 6)." }
      },
      required: ["query"],
      additionalProperties: false
    },
    effect: "read",
    source: "builtin",
    provider: "knowledge",
    async run(input, context) {
      const refused = denied(context, PERMISSIONS.KNOWLEDGE_VIEW);
      if (refused) return { content: refused, isError: true };
      const query = typeof input?.query === "string" ? input.query : "";
      if (!query.trim()) return { content: "Say what to search for.", isError: true };
      let baseIds = Array.isArray(input?.knowledgeBaseIds) ? input.knowledgeBaseIds.filter((id): id is string => typeof id === "string") : undefined;
      const allowed = agentBases(context);
      if (allowed) {
        const outside = (baseIds ?? []).filter((id) => !allowed.has(id));
        if (outside.length) return { content: `You may not search the knowledge base${outside.length > 1 ? "s" : ""} ${outside.join(", ")}.`, isError: true };
        if (!baseIds?.length) baseIds = [...allowed];
        if (baseIds.length === 0) return { content: "You have no knowledge bases to search.", data: { hits: [] } };
      }
      const limit = typeof input?.limit === "number" ? Math.min(12, Math.max(1, Math.floor(input.limit))) : 6;
      const result = await knowledge.search(context.workspaceId ?? DEFAULT_WORKSPACE_ID, query, {
        ...(baseIds?.length ? { baseIds } : {}),
        limit,
        signal: context.signal
      });
      if (result.hits.length === 0) return { content: `Nothing in the knowledge bases matches "${result.query}".`, data: { hits: [] } };
      return { content: formatHits(result.hits), data: { hits: result.hits } };
    }
  };

  const list: ToolDefinition<Record<string, never>, unknown> = {
    name: "list_knowledge",
    title: "List knowledge bases",
    description: "List this workspace's knowledge bases (id, name, description, number of documents) so you can search the right one.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    effect: "read",
    source: "builtin",
    provider: "knowledge",
    async run(_input, context) {
      const refused = denied(context, PERMISSIONS.KNOWLEDGE_VIEW);
      if (refused) return { content: refused, isError: true };
      const allowed = agentBases(context);
      const bases = (await knowledge.listBases(context.workspaceId ?? DEFAULT_WORKSPACE_ID)).filter((base) => !allowed || allowed.has(base.id));
      if (bases.length === 0) return { content: "This workspace has no knowledge bases yet.", data: { bases } };
      return {
        content: bases
          .map((base) => `- ${base.name} [${base.id}]: ${base.docCount} document(s)${base.auto ? ", searched automatically" : ""}${base.description ? ` — ${base.description}` : ""}`)
          .join("\n"),
        data: { bases }
      };
    }
  };

  const save: ToolDefinition<{ uploadId: string; knowledgeBaseId?: string }, unknown> = {
    name: "save_to_knowledge",
    title: "Save a file to knowledge",
    description:
      "Save a file the user attached in this chat (its upload id, e.g. up_…) into a knowledge base so it can be searched later. " +
      "Without knowledgeBaseId it goes to the workspace's \"Saved files\" base.",
    inputSchema: {
      type: "object",
      properties: {
        uploadId: { type: "string", description: "The attached file's id (up_…)." },
        knowledgeBaseId: { type: "string", description: "Target base id from list_knowledge (optional)." }
      },
      required: ["uploadId"],
      additionalProperties: false
    },
    effect: "write",
    source: "builtin",
    provider: "knowledge",
    async run(input, context) {
      const refused = denied(context, PERMISSIONS.KNOWLEDGE_EDIT);
      if (refused) return { content: refused, isError: true };
      const uploadId = typeof input?.uploadId === "string" ? input.uploadId : "";
      if (!/^up_[a-f0-9]{24}$/.test(uploadId)) return { content: "That is not an attached file id.", isError: true };
      const baseId = typeof input?.knowledgeBaseId === "string" ? input.knowledgeBaseId : undefined;
      const allowed = agentBases(context);
      if (allowed && (!baseId || !allowed.has(baseId))) {
        return { content: "You may only save to one of your own knowledge bases; pass its knowledgeBaseId from list_knowledge.", isError: true };
      }
      try {
        const saved = await knowledge.saveUpload(context.workspaceId ?? DEFAULT_WORKSPACE_ID, uploadId, baseId);
        return { content: `Saved "${saved.doc.title}" to the knowledge base "${saved.base.name}". It is being indexed now.`, data: saved };
      } catch (error) {
        return { content: error instanceof KnowledgeError ? error.message : "The file could not be saved.", isError: true };
      }
    }
  };

  return [search, list, save];
}
