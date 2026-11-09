/**
 * What the panel needs from the chat on screen: each visual's OpenUI source
 * (by turn) and each deck a tool produced (by id). Built from the chat's own
 * messages, so the panel shows exactly what the conversation shows.
 */
import type { ToolArtifactView } from "@open-gpt-live/protocol";

export interface PanelVisual {
  source: string;
  streaming: boolean;
  /** The newest reply: its buttons and forms still answer. */
  latest: boolean;
}

export interface SidePanelSources {
  visuals: Record<string, PanelVisual>;
  decks: Record<string, ToolArtifactView>;
}

/** The parts of a chat message the panel reads. */
export interface PanelSourceMessage {
  id: string;
  role: "user" | "assistant";
  requestId: string;
  ui?: string;
  done?: boolean;
  tools?: Array<{ artifact?: ToolArtifactView }>;
}

export function sidePanelSources(messages: readonly PanelSourceMessage[]): SidePanelSources {
  const visuals: Record<string, PanelVisual> = {};
  const decks: Record<string, ToolArtifactView> = {};
  let lastAssistant: string | undefined;
  for (const message of messages) if (message.role === "assistant") lastAssistant = message.id;
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    if (message.ui?.trim()) {
      // A turn can stream a visual from the voice reply and from deep work: the later one wins.
      visuals[message.requestId] = { source: message.ui, streaming: !message.done, latest: message.id === lastAssistant };
    }
    for (const tool of message.tools ?? []) {
      if (tool.artifact?.kind === "slides") decks[tool.artifact.id] = tool.artifact;
    }
  }
  return { visuals, decks };
}
