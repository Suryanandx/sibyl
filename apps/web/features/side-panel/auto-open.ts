/**
 * What the AI starts that the side panel follows, from the shared socket:
 *
 * - an agent's computer: the first `computer_*` tool call of a turn;
 * - a deck: `create_slides` / `revise_slides` start (a placeholder that turns
 *   into the deck when the call finishes);
 * - a media job: `create_image` / `create_video` / `create_audio` (also
 *   `generate_*`, music, speech, sound) start, the same way, becoming the
 *   media item when the call returns its file;
 * - a page the AI read (`read_webpage`): added to the Activity list only.
 */
import { AGENT_EVENTS, WS_EVENTS, type ToolArtifactView, type ToolLinkView } from "@open-gpt-live/protocol";
import { isComputerTool } from "../computers/format";
import type { SidePanelItem } from "./events";
import { pendingId, type PanelAction } from "./state";

const SLIDES_TOOLS = new Set(["create_slides", "revise_slides"]);
const MEDIA_TOOL = /^(?:create|generate)_(image|picture|photo|video|clip|audio|music|song|speech|voice|sound)s?$/;

/** The media type a create_* tool makes, or null when it isn't a media tool. */
export function mediaTypeOfTool(toolName: string): "image" | "video" | "audio" | null {
  const what = MEDIA_TOOL.exec(toolName)?.[1];
  if (!what) return null;
  if (what === "image" || what === "picture" || what === "photo") return "image";
  if (what === "video" || what === "clip") return "video";
  return "audio";
}

/** The socket messages this module reads (structural, so tests can make them). */
export type AutoOpenMessage =
  | { type: typeof WS_EVENTS.TOOL_STARTED; requestId: string; callId: string; toolName: string; title: string }
  | { type: typeof WS_EVENTS.TOOL_FINISHED; requestId: string; callId: string; status: string; artifact?: ToolArtifactView; link?: ToolLinkView }
  | { type: typeof AGENT_EVENTS.TURN; requestId: string; agentId: string }
  | { type: string };

/** Per-page memory the mapping needs: which agent answers which turn, and what each building call makes. */
export interface AutoOpenMemory {
  agents: Map<string, string>;
  building: Map<string, { kind: "slides" } | { kind: "media"; mediaType: "image" | "video" | "audio"; title: string }>;
  /** Turns whose computer was already shown (one auto-open per turn). */
  computerTurns: Set<string>;
}

export function createAutoOpenMemory(): AutoOpenMemory {
  return { agents: new Map(), building: new Map(), computerTurns: new Set() };
}

const KEEP = 200;
function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.set(key, value);
  if (map.size > KEEP) map.delete(map.keys().next().value as K);
}

/** The panel action a socket message calls for, or null. */
export function autoOpenAction(message: AutoOpenMessage, memory: AutoOpenMemory, at: number): PanelAction | null {
  if (message.type === AGENT_EVENTS.TURN && "agentId" in message) {
    remember(memory.agents, message.requestId, message.agentId);
    return null;
  }
  if (message.type === WS_EVENTS.TOOL_STARTED && "toolName" in message) {
    const { toolName, callId, requestId, title } = message;
    if (isComputerTool(toolName)) {
      const agentId = memory.agents.get(requestId);
      if (!agentId || memory.computerTurns.has(requestId)) return null;
      memory.computerTurns.add(requestId);
      if (memory.computerTurns.size > KEEP) memory.computerTurns.delete(memory.computerTurns.values().next().value as string);
      return { type: "open", auto: true, item: { kind: "computer", agentId }, at };
    }
    if (SLIDES_TOOLS.has(toolName)) {
      remember(memory.building, callId, { kind: "slides" });
      return {
        type: "open",
        auto: true,
        status: "running",
        callId,
        item: { kind: "slides", artifactId: pendingId(callId), title: toolName === "revise_slides" ? "Revising the deck" : "Building the deck" },
        at
      };
    }
    const mediaType = mediaTypeOfTool(toolName);
    if (mediaType) {
      remember(memory.building, callId, { kind: "media", mediaType, title });
      return { type: "open", auto: true, status: "running", callId, item: { kind: "media", uploadId: pendingId(callId), mediaType, title }, at };
    }
    return null;
  }
  if (message.type === WS_EVENTS.TOOL_FINISHED && "callId" in message && "status" in message) {
    const finished = message as Extract<AutoOpenMessage, { type: typeof WS_EVENTS.TOOL_FINISHED }>;
    const building = memory.building.get(finished.callId);
    if (building) {
      memory.building.delete(finished.callId);
      const artifact = finished.status === "ok" ? finished.artifact : undefined;
      let item: SidePanelItem | null = null;
      if (building.kind === "slides" && artifact?.kind === "slides") item = { kind: "slides", artifactId: artifact.id, title: artifact.title };
      // A media artifact is the library item (md_…): its first file, and the item id for progress while a video renders.
      else if (building.kind === "media" && artifact) {
        const uploadId = artifact.kind === "media" ? (artifact.media?.outputs[0]?.uploadId ?? "") : artifact.id;
        item = { kind: "media", uploadId, mediaType: building.mediaType, title: artifact.title || building.title, ...(artifact.kind === "media" ? { jobId: artifact.id } : {}) };
      }
      return { type: "resolve", callId: finished.callId, item, ...(artifact?.kind === "slides" ? { artifact } : {}), at };
    }
    // A deck from a call this page didn't see start (e.g. reconnected mid-build).
    if (finished.status === "ok" && finished.artifact?.kind === "slides") {
      return { type: "open", auto: true, item: { kind: "slides", artifactId: finished.artifact.id, title: finished.artifact.title }, artifact: finished.artifact, at };
    }
    if (finished.status === "ok" && finished.link) {
      return { type: "record", item: { kind: "url", url: finished.link.url, ...(finished.link.title ? { title: finished.link.title } : {}) }, at };
    }
  }
  return null;
}
