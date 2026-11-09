/**
 * A local stand-in for LiveKit Inference's speech endpoints (/v1/tts and
 * /v1/stt), speaking the protocol `@livekit/agents` uses. For tests, and to
 * run the gateway's LiveKit Inference path without a LiveKit Cloud project.
 * It checks the bearer token (signed with the API secret, inference grant).
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { TokenVerifier } from "livekit-server-sdk";
import { WebSocketServer, type WebSocket } from "ws";

export interface FakeInferenceOptions {
  apiKey: string;
  apiSecret: string;
  /** What /stt answers (default: "hello from livekit"). */
  transcript?: string;
  /** Delay before the first audio of each generation (ms). */
  ttsDelayMs?: number;
}

export interface FakeInference {
  url: string;
  /** Every client event received, with the path. */
  received: Array<{ path: string; event: Record<string, unknown> }>;
  /** Connections opened per path (TTS sockets are reused). */
  connections: Record<string, number>;
  close(): Promise<void>;
}

export async function startFakeInference(options: FakeInferenceOptions): Promise<FakeInference> {
  const verifier = new TokenVerifier(options.apiKey, options.apiSecret);
  const http: Server = createServer((_request, response) => response.writeHead(404).end());
  const wss = new WebSocketServer({ noServer: true });
  const received: FakeInference["received"] = [];
  const connections: Record<string, number> = {};
  http.on("upgrade", (request, socket, head) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1];
    void (async () => {
      try {
        const claims = (await verifier.verify(token ?? "")) as { inference?: { perform?: boolean } };
        if (!claims.inference?.perform) throw new Error("no inference grant");
      } catch {
        socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
        return;
      }
      if (path !== "/v1/tts" && path !== "/v1/stt") {
        socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        connections[path] = (connections[path] ?? 0) + 1;
        (path === "/v1/tts" ? serveTts : serveStt)(ws, path);
      });
    })();
  });

  const send = (ws: WebSocket, event: Record<string, unknown>) => ws.send(JSON.stringify(event));

  function serveTts(ws: WebSocket, path: string): void {
    let rate = 16_000;
    ws.on("message", (raw) => {
      const event = JSON.parse(raw.toString()) as Record<string, unknown>;
      received.push({ path, event });
      if (event.type === "session.create") {
        rate = Number(event.sample_rate) || rate;
        send(ws, { type: "session.created", session_id: "s1" });
      } else if (event.type === "session.flush") {
        const text = [...received].reverse().find((entry) => entry.path === path && entry.event.type === "input_transcript")?.event.transcript;
        // 50 ms of a quiet tone per character, in three pieces.
        const samples = Math.round((rate * 0.05) * String(text ?? "").trim().length);
        const pcm = Buffer.alloc(samples * 2);
        for (let index = 0; index < samples; index += 1) pcm.writeInt16LE(Math.round(Math.sin(index / 8) * 3000), index * 2);
        const third = Math.ceil(pcm.byteLength / 3 / 2) * 2;
        setTimeout(() => {
          for (let offset = 0; offset < pcm.byteLength; offset += third) {
            send(ws, { type: "output_audio", audio: pcm.subarray(offset, offset + third).toString("base64"), session_id: "s1" });
          }
          send(ws, { type: "done", session_id: "s1" });
        }, options.ttsDelayMs ?? 0);
      } else if (event.type === "session.close") {
        send(ws, { type: "session.closed", session_id: "s1" });
        ws.close();
      }
    });
  }

  function serveStt(ws: WebSocket, path: string): void {
    let bytes = 0;
    ws.on("message", (raw) => {
      const event = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (event.type === "input_audio") bytes += Buffer.from(String(event.audio), "base64").byteLength;
      else received.push({ path, event });
      if (event.type === "session.create") send(ws, { type: "session.created", session_id: "s2" });
      else if (event.type === "session.finalize") {
        received.push({ path, event: { type: "audio_bytes", bytes } });
        send(ws, { type: "interim_transcript", transcript: "hello", session_id: "s2" });
        send(ws, { type: "final_transcript", transcript: options.transcript ?? "hello from livekit", session_id: "s2" });
        send(ws, { type: "session.finalized", session_id: "s2" });
      } else if (event.type === "session.close") ws.close();
    });
  }

  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    received,
    connections,
    close: async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  };
}
