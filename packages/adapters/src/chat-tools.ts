/**
 * Tool-calling chat stream for OpenAI-compatible `/chat/completions`.
 *
 * Separate from `OpenAILLMProvider.streamText` (plain text only): this one
 * sends `tools`, accumulates streamed `tool_calls` deltas by index, and asks
 * for OpenRouter usage accounting (`usage: { include: true }`) so the caller
 * can meter the real cost of every round.
 */
import type { LLMContentPart, ProviderCallOptions } from "./index";

/** A function call the model asked for (arguments are the raw JSON string). */
export interface ChatToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** Messages for a tool-calling conversation (superset of `LLMMessage`). */
export type ToolChatMessage =
  | { role: "system" | "user" | "assistant"; content: string | LLMContentPart[] }
  | { role: "assistant"; content: string | null; toolCalls: ChatToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

/** OpenAI function-tool spec (what `toFunctionTools` in core produces). */
export interface ChatFunctionTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** Same shape as core's `ModelUsage`. */
export interface ChatUsage {
  costUsd?: number;
  promptTokens?: number;
  completionTokens?: number;
}

export type ToolChatEvent =
  | { type: "text"; delta: string }
  | { type: "tool_calls"; calls: ChatToolCall[] }
  | { type: "usage"; usage: ChatUsage };

export interface ToolChatOptions extends ProviderCallOptions {
  tools?: ChatFunctionTool[];
  /** "auto" (default when tools are given) or "none" to force a final answer. */
  toolChoice?: "auto" | "none";
}

export interface ToolChatProvider {
  streamWithTools(messages: ToolChatMessage[], options?: ToolChatOptions): AsyncIterable<ToolChatEvent>;
}

export interface OpenAIToolChatConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  extraHeaders?: Record<string, string>;
  /** Injectable for tests. */
  fetch?: typeof fetch;
}

interface ToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface ToolChatChunk {
  choices?: Array<{
    delta?: { content?: string | null; tool_calls?: ToolCallDelta[] };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number } | null;
  error?: { message?: string };
}

export class OpenAIToolChatClient implements ToolChatProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(config: OpenAIToolChatConfig = {}) {
    this.extraHeaders = config.extraHeaders ?? {};
    this.apiKey = nonEmpty(config.apiKey) ?? nonEmpty(process.env.OPENAI_API_KEY) ?? "";
    this.baseUrl = (nonEmpty(config.baseUrl) ?? nonEmpty(process.env.OPENAI_BASE_URL) ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    this.model = nonEmpty(config.model) ?? nonEmpty(process.env.OPENAI_MODEL) ?? "gpt-4o-mini";
    this.fetchImpl = config.fetch ?? ((input, init) => fetch(input, init));
  }

  async *streamWithTools(messages: ToolChatMessage[], options: ToolChatOptions = {}): AsyncIterable<ToolChatEvent> {
    const tools = options.tools ?? [];
    const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        ...this.extraHeaders,
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        ...options.extraBody,
        model: options.model ?? this.model,
        messages: messages.map(toWireMessage),
        ...(tools.length > 0 ? { tools, tool_choice: options.toolChoice ?? "auto" } : {}),
        stream: true,
        usage: { include: true }
      }),
      signal: options.signal
    });

    if (!response.ok) {
      throw new Error(`OpenAI-compatible API error ${response.status}: ${await response.text()}`);
    }
    if (!response.body) {
      throw new Error("OpenAI-compatible API returned no response body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const pending = new Map<number, ChatToolCall>();
    let buffer = "";
    let finished = false;

    const flushCalls = (): ToolChatEvent | undefined => {
      if (pending.size === 0) return undefined;
      const calls = [...pending.entries()]
        .sort(([a], [b]) => a - b)
        .map(([index, call]) => ({ ...call, id: call.id || `call_${index}` }))
        .filter((call) => call.name);
      pending.clear();
      return calls.length > 0 ? { type: "tool_calls", calls } : undefined;
    };

    try {
      while (!finished) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        for (const event of events) {
          for (const data of dataLines(event)) {
            if (data === "[DONE]") {
              finished = true;
              break;
            }
            const chunk = JSON.parse(data) as ToolChatChunk;
            if (chunk.error) {
              throw new Error(`OpenAI-compatible API error: ${chunk.error.message ?? "unknown"}`);
            }
            for (const out of readChunk(chunk, pending)) yield out;
          }
          if (finished) break;
        }
      }
      // A trailing event without the blank-line terminator.
      if (!finished && buffer.trim()) {
        for (const data of dataLines(buffer)) {
          if (data === "[DONE]") break;
          for (const out of readChunk(JSON.parse(data) as ToolChatChunk, pending)) yield out;
        }
      }
      const calls = flushCalls();
      if (calls) yield calls;
    } catch (error) {
      if (options.signal?.aborted) return;
      throw error;
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }
}

function* readChunk(chunk: ToolChatChunk, pending: Map<number, ChatToolCall>): Generator<ToolChatEvent> {
  const delta = chunk.choices?.[0]?.delta;
  if (delta?.content) yield { type: "text", delta: delta.content };
  for (const part of delta?.tool_calls ?? []) {
    const index = part.index ?? 0;
    const call = pending.get(index) ?? { id: "", name: "", arguments: "" };
    if (part.id) call.id = part.id;
    if (part.function?.name) call.name += part.function.name;
    if (part.function?.arguments) call.arguments += part.function.arguments;
    pending.set(index, call);
  }
  if (chunk.usage) {
    const usage: ChatUsage = {};
    if (typeof chunk.usage.cost === "number") usage.costUsd = chunk.usage.cost;
    if (typeof chunk.usage.prompt_tokens === "number") usage.promptTokens = chunk.usage.prompt_tokens;
    if (typeof chunk.usage.completion_tokens === "number") usage.completionTokens = chunk.usage.completion_tokens;
    yield { type: "usage", usage };
  }
}

function toWireMessage(message: ToolChatMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
  }
  if ("toolCalls" in message) {
    return {
      role: "assistant",
      content: message.content,
      ...(message.toolCalls.length > 0
        ? {
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: call.arguments }
            }))
          }
        : {})
    };
  }
  return { role: message.role, content: message.content };
}

function dataLines(event: string): string[] {
  return event
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter(Boolean);
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value : undefined;
}
