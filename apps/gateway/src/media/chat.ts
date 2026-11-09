/**
 * A chat message sent in the composer's Create mode (Image | Video | Audio):
 * the text is the prompt, the person already chose the model and settings
 * and saw the price, so it goes straight to the media service — no chat
 * model in between, no approval card. The turn is recorded like any other
 * (user message + a short reply naming the file ids), so the assistant can
 * refer to the result later ("now animate it").
 *
 * The client sees one tool step ("Creating an image") whose TOOL_FINISHED
 * carries the media card.
 */
import { WS_EVENTS, type MediaCreateSpec, type MediaItemView, type ServerMessage } from "@open-gpt-live/protocol";
import { usd } from "./catalog.js";
import { MediaError, type MediaService } from "./service.js";
import { mediaArtifact } from "./tools.js";

export interface MediaChatTurn {
  media: MediaService;
  requestId: string;
  prompt: string;
  spec: MediaCreateSpec;
  workspaceId: string;
  conversationId: string;
  userId?: string;
  role?: string;
  agentId?: string;
  signal?: AbortSignal;
  send(message: ServerMessage): void;
  /** Record the reply in the history and the stored conversation. */
  reply(text: string): void;
}

const VERB: Record<MediaCreateSpec["kind"], string> = { image: "Creating an image", video: "Creating a video", audio: "Creating audio" };

export async function runMediaChatTurn(turn: MediaChatTurn): Promise<MediaItemView | undefined> {
  const callId = `media-${turn.requestId}`;
  turn.send({ type: WS_EVENTS.TOOL_STARTED, requestId: turn.requestId, callId, toolName: `create_${turn.spec.kind}`, title: VERB[turn.spec.kind] });
  let item: MediaItemView | undefined;
  let text: string;
  try {
    item = await turn.media.create({
      ...turn.spec,
      prompt: turn.prompt,
      workspaceId: turn.workspaceId,
      conversationId: turn.conversationId,
      requestId: turn.requestId,
      ...(turn.userId ? { userId: turn.userId } : {}),
      ...(turn.role ? { role: turn.role } : {}),
      ...(turn.agentId ? { agentId: turn.agentId } : {}),
      ...(turn.signal ? { signal: turn.signal } : {})
    });
    const failed = item.status === "error";
    turn.send({
      type: WS_EVENTS.TOOL_FINISHED,
      requestId: turn.requestId,
      callId,
      status: failed ? "error" : "ok",
      summary: failed ? (item.error ?? "Failed") : `${item.modelName ?? item.model}`,
      artifact: mediaArtifact(item)
    });
    text = replyText(item);
  } catch (error) {
    const message = error instanceof MediaError ? error.message : `Couldn't create it: ${error instanceof Error ? error.message : String(error)}`;
    turn.send({ type: WS_EVENTS.TOOL_FINISHED, requestId: turn.requestId, callId, status: "error", summary: message });
    text = message;
  }
  turn.send({ type: WS_EVENTS.LLM_DELTA, requestId: turn.requestId, delta: text });
  turn.reply(text);
  turn.send({ type: WS_EVENTS.LLM_DONE, requestId: turn.requestId, reason: "stop" });
  return item;
}

/** The short reply under the card; it also tells the assistant the file ids for later turns. */
export function replyText(item: MediaItemView): string {
  const model = item.modelName ?? item.model;
  if (item.status === "error") return `That didn't work: ${item.error ?? "the model returned an error"}. Nothing was charged.`;
  if (item.status === "running" || item.status === "queued") return `Rendering the video with ${model} (about ${usd(item.estimateUsd)}). It appears here when it's ready. (media id ${item.id})`;
  const ids = item.outputs.map((output) => output.uploadId).join(", ");
  const what = item.kind === "image" ? (item.outputs.length > 1 ? `${item.outputs.length} images` : "the image") : item.kind === "video" ? "the video" : "the audio";
  return `Here is ${what}, made with ${model}. (file id${item.outputs.length > 1 ? "s" : ""} ${ids})`;
}
