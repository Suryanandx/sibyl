/**
 * Tools that exist only while an agent runs (never registered globally):
 * recall past runs and memory, load one of its skills, search the knowledge
 * it may read, and remember something (as a proposal when learning asks first).
 */
import type { AgentRecord, SkillRecord, ToolDefinition } from "@open-gpt-live/core";

export const AGENT_TOOL_NAMES: ReadonlySet<string> = new Set(["agent_recall", "agent_skill", "agent_knowledge_search", "agent_remember"]);

export interface AgentToolsInput {
  agent: AgentRecord;
  skills: SkillRecord[];
  knowledgeBaseIds: string[];
  /** Save (or propose) a memory line; returns what happened, for the model. */
  remember(text: string, runId: string): Promise<string>;
}

export function createAgentTools(input: AgentToolsInput): ToolDefinition<any, any>[] {
  const { agent } = input;
  const tools: ToolDefinition<any, any>[] = [
    {
      name: "agent_recall",
      title: "Recall past work",
      description: `Search ${agent.name}'s memory and log of past runs (what was asked, what was done) for something similar.`,
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", description: "Keywords to look for." } },
        required: ["query"],
        additionalProperties: false
      },
      effect: "read",
      source: "agent",
      provider: "agent",
      async run(args: { query?: unknown }, context) {
        const query = typeof args.query === "string" ? args.query : "";
        const hits = await context.store.agentMemory.search(context.ownerId, agent.id, query, 6);
        if (hits.length === 0) return { content: "Nothing similar in memory yet." };
        return {
          content: hits
            .map((hit) => `- [${hit.kind === "run" ? "past run" : "memory"} ${new Date(hit.updatedAt).toISOString().slice(0, 10)}] ${hit.text}`)
            .join("\n")
        };
      }
    }
  ];

  if (input.skills.length) {
    tools.push({
      name: "agent_skill",
      title: "Use a skill",
      description: `Load the full steps of one of ${agent.name}'s skills by name.`,
      inputSchema: {
        type: "object",
        properties: { name: { type: "string", enum: input.skills.map((skill) => skill.name) } },
        required: ["name"],
        additionalProperties: false
      },
      effect: "read",
      source: "agent",
      provider: "agent",
      async run(args: { name?: unknown }) {
        const skill = input.skills.find((s) => s.name === args.name);
        if (!skill) return { content: `No skill "${String(args.name)}". Use one of: ${input.skills.map((s) => s.name).join(", ")}.`, isError: true };
        const files = (skill.files ?? []).map((file) => `\n\n--- ${file.name} ---\n${file.content}`).join("");
        return { content: `# ${skill.title}\n\n${skill.instructions}${files}` };
      }
    });
  }

  if (input.knowledgeBaseIds.length) {
    tools.push({
      name: "agent_knowledge_search",
      title: "Search knowledge",
      description: `Keyword search in the knowledge bases ${agent.name} may read. Returns passages with their source.`,
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false
      },
      effect: "read",
      source: "agent",
      provider: "agent",
      async run(args: { query?: unknown }, context) {
        const query = typeof args.query === "string" ? args.query : "";
        const hits = await context.store.knowledge.search(context.ownerId, input.knowledgeBaseIds, query, 6);
        if (hits.length === 0) return { content: "No matching passages." };
        const docs = new Map<string, string>();
        for (const hit of hits) {
          if (!docs.has(hit.chunk.docId)) docs.set(hit.chunk.docId, (await context.store.knowledge.getDoc(context.ownerId, hit.chunk.docId))?.title ?? "document");
        }
        return {
          content: hits
            .map((hit, i) => `[${i + 1}] ${docs.get(hit.chunk.docId)}${hit.chunk.label ? ` — ${hit.chunk.label}` : ""}\n${hit.chunk.text.slice(0, 1_200)}`)
            .join("\n\n")
        };
      }
    });
  }

  if (agent.learning !== "off") {
    tools.push({
      name: "agent_remember",
      title: "Remember",
      description:
        `Save one short, durable fact for ${agent.name} to remember next time (a preference, a name, how the team does something). ` +
        "Not for one-off details." +
        (agent.learning === "ask_first" ? " The user reviews it before it is kept." : ""),
      inputSchema: {
        type: "object",
        properties: { fact: { type: "string", description: "One sentence." } },
        required: ["fact"],
        additionalProperties: false
      },
      effect: "read",
      source: "agent",
      provider: "agent",
      async run(args: { fact?: unknown }, context) {
        const fact = typeof args.fact === "string" ? args.fact.trim().slice(0, 600) : "";
        if (!fact) return { content: "Say what to remember.", isError: true };
        return { content: await input.remember(fact, context.runId) };
      }
    });
  }
  return tools;
}
