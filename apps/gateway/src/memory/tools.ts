/**
 * Memory tools for the brain: remember / forget / recall.
 *
 * All three are "read" effect: they only touch the user's own memory list,
 * and `remember` is restricted (by description and by validation) to facts
 * the user explicitly stated — never secrets.
 */
import type { ToolContext, ToolDefinition } from "@open-gpt-live/core";
import { MemoryError, MemoryService, type MemoryItem } from "./store.js";

type Env = NodeJS.ProcessEnv;

function service(context: ToolContext, env: Env): MemoryService {
  return new MemoryService({
    store: context.store,
    ownerId: context.ownerId,
    env,
    ...(context.principal ? { principal: context.principal } : {}),
    ...(context.workspaceId ? { workspaceId: context.workspaceId } : {})
  });
}

async function ensureEnabled(memory: MemoryService): Promise<string | undefined> {
  if (!memory.available) return "Memory is turned off on this Sibyl (SIBYL_MEMORY=false).";
  if (!(await memory.enabled())) return "The user turned memory off (Settings → Memory). Nothing was saved or read.";
  return undefined;
}

function line(item: MemoryItem): string {
  return `- [${item.id}] ${item.text}${item.pinned ? " (pinned)" : ""}`;
}

export function createMemoryTools(env: Env = process.env): ToolDefinition<any, any>[] {
  const remember: ToolDefinition<{ fact: string; pinned?: boolean }, { item: MemoryItem }> = {
    name: "remember",
    title: "Save to memory",
    description:
      "Save one short fact about the user to long-term memory so you know it in future chats " +
      "(e.g. \"Prefers metric units\", \"Works at Acme as a designer\"). Only use this for something the user " +
      "explicitly told you about themselves and asked or clearly wants you to remember. Never store passwords, " +
      "keys, tokens, card or account numbers, or other secrets (they are refused). Write the fact in third person, one sentence.",
    inputSchema: {
      type: "object",
      properties: {
        fact: { type: "string", description: "The fact, one short sentence (≤ 300 characters)." },
        pinned: { type: "boolean", description: "Pin it so it is always included first." }
      },
      required: ["fact"],
      additionalProperties: false
    },
    effect: "read",
    source: "builtin",
    provider: "memory",
    async run(input, context) {
      const memory = service(context, env);
      const off = await ensureEnabled(memory);
      if (off) return { content: off, isError: true };
      try {
        const item = await memory.add(input?.fact, { pinned: input?.pinned === true });
        return { content: `Saved to memory: ${item.text}`, data: { item } };
      } catch (error) {
        const message = error instanceof MemoryError ? error.message : String(error);
        return { content: `Not saved: ${message}`, isError: true };
      }
    }
  };

  const forget: ToolDefinition<{ query: string }, { removed: MemoryItem[] }> = {
    name: "forget",
    title: "Forget from memory",
    description:
      "Remove facts from the user's long-term memory when they ask you to forget something. " +
      "Pass a memory id (from recall) or words that appear in the fact; every matching fact is removed.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Memory id, or text contained in the fact(s) to remove." } },
      required: ["query"],
      additionalProperties: false
    },
    effect: "read",
    source: "builtin",
    provider: "memory",
    async run(input, context) {
      const memory = service(context, env);
      if (!memory.available) return { content: "Memory is turned off on this Sibyl.", isError: true };
      const query = typeof input?.query === "string" ? input.query : "";
      if (!query.trim()) return { content: "Say what to forget.", isError: true };
      const removed = await memory.forget(query);
      if (removed.length === 0) return { content: `Nothing in memory matches "${query}".`, data: { removed } };
      return { content: `Forgot ${removed.length} fact(s):\n${removed.map(line).join("\n")}`, data: { removed } };
    }
  };

  const recall: ToolDefinition<{ query?: string }, { items: MemoryItem[] }> = {
    name: "recall",
    title: "Check memory",
    description:
      "List what you remember about the user (optionally only facts containing `query`). " +
      "The most important facts are already in your instructions; use this to see everything or to find an id to forget.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Optional text to filter by." } },
      additionalProperties: false
    },
    effect: "read",
    source: "builtin",
    provider: "memory",
    async run(input, context) {
      const memory = service(context, env);
      const off = await ensureEnabled(memory);
      if (off) return { content: off, isError: true };
      const needle = typeof input?.query === "string" ? input.query.trim().toLowerCase() : "";
      const items = (await memory.list()).filter((item) => !needle || item.text.toLowerCase().includes(needle));
      if (items.length === 0) return { content: needle ? `Nothing in memory matches "${needle}".` : "Memory is empty.", data: { items } };
      return { content: items.map(line).join("\n"), data: { items } };
    }
  };

  return [remember, forget, recall];
}
