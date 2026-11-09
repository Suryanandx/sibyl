/**
 * Chat tools of the realtime layer.
 *
 * - place_phone_call: high risk (risk: "high"), so it always shows an
 *   approval card, whatever an agent's autonomy says.
 * - listen_to_stream: a write action too (it starts something that keeps
 *   running and spends on transcription), so it asks first.
 */
import type { ToolDefinition } from "@open-gpt-live/core";
import { RealtimeError, type RealtimeService } from "./service.js";

export function realtimeTools(realtime: RealtimeService): ToolDefinition<any, any>[] {
  const placePhoneCall: ToolDefinition<{ to: string; purpose: string; agentId?: string }> = {
    name: "place_phone_call",
    title: "Place a phone call",
    description:
      "Call a phone number and talk to whoever answers, by voice, for a clear purpose (book, confirm, remind, ask). " +
      "The number must be in E.164 form (+15551234567). The call's transcript is saved as a new chat.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Phone number in E.164 form, e.g. +15551234567." },
        purpose: { type: "string", description: "What the call is for and what to say or find out." },
        agentId: { type: "string", description: "Optional: one of your agents makes the call with its own voice." }
      },
      required: ["to", "purpose"],
      additionalProperties: false
    },
    effect: "write",
    risk: "high",
    source: "builtin",
    provider: "realtime",
    isAvailable: () => realtime.capability().phone,
    async run(input, context) {
      if (!context.principal) return { content: "Phone calls need a signed-in person.", isError: true };
      try {
        const call = await realtime.placeCall({
          principal: context.principal,
          workspaceId: context.workspaceId ?? "default",
          to: String(input.to ?? "").trim(),
          purpose: String(input.purpose ?? "").trim() || "Introduce yourself and ask how you can help.",
          ...(typeof input.agentId === "string" && input.agentId ? { agentId: input.agentId } : {})
        });
        return { content: `Calling now. The conversation is saved as a chat (id ${call.conversationId}).`, data: call };
      } catch (error) {
        return { content: error instanceof RealtimeError ? error.message : `The call could not be placed: ${error instanceof Error ? error.message : String(error)}`, isError: true };
      }
    }
  };

  const listenToStream: ToolDefinition<{ url: string; name?: string }> = {
    name: "listen_to_stream",
    title: "Listen to a stream and take notes",
    description:
      "Join a live audio/video stream (a direct live HLS, RTMP or SRT URL — not a YouTube page, not a finished file) and write down what is said " +
      "into a new chat, so it can be summarised later.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Direct live media URL (https://…/live/index.m3u8, rtmp://…, srt://…)." },
        name: { type: "string", description: "Short name for the notes, e.g. 'Q3 all-hands'." }
      },
      required: ["url"],
      additionalProperties: false
    },
    effect: "write",
    source: "builtin",
    provider: "realtime",
    async run(input, context) {
      if (!context.principal) return { content: "Listening to a stream needs a signed-in person.", isError: true };
      try {
        const stream = await realtime.createStream({
          principal: context.principal,
          workspaceId: context.workspaceId ?? "default",
          name: String(input.name ?? "").trim() || "Stream notes",
          input: "url",
          url: String(input.url ?? "").trim()
        });
        return { content: `Listening. Notes go to a new chat (id ${stream.conversationId ?? "pending"}).`, data: stream };
      } catch (error) {
        return { content: error instanceof RealtimeError ? error.message : `Could not join the stream: ${error instanceof Error ? error.message : String(error)}`, isError: true };
      }
    }
  };

  return [placePhoneCall, listenToStream];
}
