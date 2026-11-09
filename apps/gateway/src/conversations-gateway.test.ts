import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LLMMessage, LLMProvider, STTProvider, TTSProvider } from "@open-gpt-live/adapters";
import { createSqliteStore } from "@open-gpt-live/store";
import {
  WS_EVENTS,
  type ConversationStateMessage,
  type ConversationsListMessage,
  type ModelCatalog,
  type ServerMessage
} from "@open-gpt-live/protocol";
import { test } from "vitest";
import { WebSocket } from "ws";
import { tokensMatch } from "./auth.js";
import { conversationTitle, historyFromMessages } from "./conversations.js";
import { createGatewayServer, type GatewayProviders, type GatewayServerOptions } from "./gateway.js";
import { createTestRuntime, type GatewayRuntime } from "./runtime.js";

const catalog: ModelCatalog = {
  llm: [{ id: "brain/deep", label: "Deep" }],
  stt: [{ id: "stt/x", label: "STT" }],
  tts: [{ id: "tts/plain", label: "Plain", voices: ["a"] }]
};
const liveCatalog: ModelCatalog = { ...catalog, voice: [{ id: "voice/fast", label: "Fast voice" }] };

interface Recorded {
  llm: Array<{ model?: string; messages: LLMMessage[] }>;
}

function providers(reply: (model: string | undefined, call: number) => string, rec: Recorded): GatewayProviders {
  const llm: LLMProvider = {
    async *streamText(messages, options) {
      rec.llm.push({ model: options?.model, messages: structuredClone(messages) });
      const text = reply(options?.model, rec.llm.length);
      for (let i = 0; i < text.length; i += 6) yield { delta: text.slice(i, i + 6) };
    }
  };
  const stt: STTProvider = {
    async transcribe() {
      return { text: "accurate words" };
    }
  };
  const tts: TTSProvider = {
    async *synthesize() {
      yield { audio: new Uint8Array([1]), mimeType: "audio/mpeg", format: "mp3" };
    }
  };
  return { llm, stt, tts };
}

interface Client {
  send(message: unknown): void;
  waitFor<T extends ServerMessage = ServerMessage>(predicate: (message: ServerMessage) => boolean, after?: number): Promise<T>;
  messages: ServerMessage[];
}

async function connect(port: number, query = ""): Promise<{ client: Client; close(): void }> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${query}`);
  const messages: ServerMessage[] = [];
  const waiters: Array<{ predicate: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }> = [];
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString()) as ServerMessage;
    messages.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(message)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const client: Client = {
    send: (message) => socket.send(JSON.stringify(message)),
    waitFor: <T extends ServerMessage>(predicate: (m: ServerMessage) => boolean, after = 0) => {
      const found = messages.slice(after).find(predicate);
      if (found) return Promise.resolve(found as T);
      return Promise.race([
        new Promise<T>((resolve) => waiters.push({ predicate, resolve: resolve as (m: ServerMessage) => void })),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000))
      ]);
    },
    messages
  };
  return { client, close: () => socket.close() };
}

async function withGateway(
  gatewayProviders: GatewayProviders,
  run: (gateway: { port: number; runtime: GatewayRuntime }) => Promise<void>,
  extra: Partial<GatewayServerOptions> = {}
): Promise<void> {
  const runtime = extra.runtime ?? createTestRuntime();
  const gateway = await createGatewayServer({
    providers: gatewayProviders,
    host: "127.0.0.1",
    modelCatalog: catalog,
    ttsSegmentMinLength: 1,
    ...extra,
    runtime
  });
  try {
    await run({ port: gateway.port, runtime });
  } finally {
    await gateway.close();
  }
}

const isList = (m: ServerMessage): boolean => m.type === WS_EVENTS.CONVERSATIONS_LIST;
const isState = (m: ServerMessage): boolean => m.type === WS_EVENTS.CONVERSATION_STATE;
const done = (requestId: string) => (m: ServerMessage) => m.type === WS_EVENTS.TTS_END && m.requestId === requestId;

async function listAfter(client: Client): Promise<ConversationsListMessage> {
  const at = client.messages.length;
  client.send({ type: WS_EVENTS.CONVERSATIONS_REQUEST });
  return client.waitFor<ConversationsListMessage>(isList, at);
}

async function open(client: Client, conversationId?: string): Promise<ConversationStateMessage> {
  const at = client.messages.length;
  client.send({ type: WS_EVENTS.CONVERSATION_OPEN, ...(conversationId ? { conversationId } : {}) });
  return client.waitFor<ConversationStateMessage>(isState, at);
}

test("text turns are saved; reopening a conversation restores its context", async () => {
  const rec: Recorded = { llm: [] };
  const dir = mkdtempSync(join(tmpdir(), "sibyl-gw-"));
  const runtime = createTestRuntime({ store: createSqliteStore({ file: join(dir, "sibyl.db") }) });
  try {
    await withGateway(providers((_m, call) => `Reply number ${call}.`, rec), async ({ port }) => {
      const first = await connect(port);
      await first.client.waitFor((m) => m.type === WS_EVENTS.SESSION_CONFIG);
      assert.deepEqual((await listAfter(first.client)).items, []);
      const fresh = await open(first.client);
      assert.equal(fresh.messages.length, 0);
      assert.equal(fresh.title, "New conversation");

      const longQuestion = `What is   the capital of France?  ${"and more ".repeat(10)}`.trim();
      first.client.send({ type: WS_EVENTS.USER_TEXT, requestId: "t1", text: longQuestion });
      await first.client.waitFor(done("t1"));
      const pushed = await first.client.waitFor<ConversationsListMessage>((m) => isList(m) && (m as ConversationsListMessage).items.length === 1);
      assert.equal(pushed.items[0]!.id, fresh.conversationId);
      assert.equal(pushed.items[0]!.title, conversationTitle(longQuestion));
      assert.equal(pushed.items[0]!.title.length, 60);

      first.client.send({ type: WS_EVENTS.USER_TEXT, requestId: "t2", text: "And Germany?" });
      await first.client.waitFor(done("t2"));
      first.close();

      // A new connection (e.g. after a restart) resumes with full context.
      const second = await connect(port);
      await second.client.waitFor((m) => m.type === WS_EVENTS.SESSION_CONFIG);
      const list = await listAfter(second.client);
      assert.deepEqual(list.items.map((item) => item.id), [fresh.conversationId]);
      const state = await open(second.client, fresh.conversationId);
      assert.deepEqual(
        state.messages.map((m) => [m.role, m.content, m.requestId, m.source]),
        [
          ["user", longQuestion, "t1", "text"],
          ["assistant", "Reply number 1.", "t1", undefined],
          ["user", "And Germany?", "t2", "text"],
          ["assistant", "Reply number 2.", "t2", undefined]
        ]
      );
      assert.equal(state.messages[1]!.model, "brain/deep");

      second.client.send({ type: WS_EVENTS.USER_TEXT, requestId: "t3", text: "And Spain?" });
      await second.client.waitFor(done("t3"));
      const call = rec.llm.at(-1)!;
      assert.equal(call.messages[0]!.role, "system");
      assert.deepEqual(
        call.messages.slice(1).map((m) => m.content),
        [longQuestion, "Reply number 1.", "And Germany?", "Reply number 2.", "And Spain?"]
      );

      // New chat: empty context, and the next turn starts a separate conversation.
      const next = await open(second.client);
      assert.notEqual(next.conversationId, fresh.conversationId);
      second.client.send({ type: WS_EVENTS.USER_TEXT, requestId: "t4", text: "Hello again" });
      await second.client.waitFor(done("t4"));
      assert.deepEqual(rec.llm.at(-1)!.messages.slice(1).map((m) => m.content), ["Hello again"]);
      const both = await listAfter(second.client);
      assert.deepEqual(both.items.map((item) => item.id), [next.conversationId, fresh.conversationId]);
      second.close();
    }, { runtime });
  } finally {
    await runtime.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deleting conversations; deleting the live one starts a fresh one", async () => {
  const rec: Recorded = { llm: [] };
  await withGateway(providers(() => "Okay.", rec), async ({ port, runtime }) => {
    const { client, close } = await connect(port);
    await client.waitFor((m) => m.type === WS_EVENTS.SESSION_CONFIG);
    // Turns are saved even if the client never opened a conversation.
    client.send({ type: WS_EVENTS.USER_TEXT, requestId: "a1", text: "First chat" });
    await client.waitFor(done("a1"));
    const [first] = (await listAfter(client)).items;
    await open(client);
    client.send({ type: WS_EVENTS.USER_TEXT, requestId: "b1", text: "Second chat" });
    await client.waitFor(done("b1"));
    const live = (await listAfter(client)).items[0]!;
    assert.equal(live.title, "Second chat");

    let at = client.messages.length;
    client.send({ type: WS_EVENTS.CONVERSATION_DELETE, conversationId: first!.id });
    // A save finishing in the background can push a list just before the delete
    // lands; wait for the list that reflects the delete.
    const afterDelete = await client.waitFor<ConversationsListMessage>(
      (m) => isList(m) && !(m as ConversationsListMessage).items.some((item) => item.id === first!.id),
      at
    );
    assert.deepEqual(afterDelete.items.map((item) => item.id), [live.id]);
    assert.equal(client.messages.slice(at).some(isState), false);

    at = client.messages.length;
    client.send({ type: WS_EVENTS.CONVERSATION_DELETE, conversationId: live.id });
    const state = await client.waitFor<ConversationStateMessage>(isState, at);
    assert.notEqual(state.conversationId, live.id);
    assert.deepEqual(state.messages, []);
    const emptied = await client.waitFor<ConversationsListMessage>(
      (m) => isList(m) && (m as ConversationsListMessage).items.length === 0,
      at
    );
    assert.deepEqual(emptied.items, []);
    assert.equal(await runtime.store.conversations.get(runtime.ownerId, live.id), undefined);

    client.send({ type: WS_EVENTS.USER_TEXT, requestId: "c1", text: "Third" });
    await client.waitFor(done("c1"));
    assert.deepEqual(rec.llm.at(-1)!.messages.slice(1).map((m) => m.content), ["Third"]);

    at = client.messages.length;
    client.send({ type: WS_EVENTS.CONVERSATION_OPEN, conversationId: "does-not-exist" });
    const error = await client.waitFor((m) => m.type === "error", at);
    assert.match((error as { message: string }).message, /not found/);
    close();
  });
});

test("live voice turn saves the accurate transcript, reply and deep-brain result", async () => {
  const rec: Recorded = { llm: [] };
  const replies: Record<string, string> = {
    "voice/fast": "Let me check.\n@brain Compare laptops",
    "brain/deep": "The Air wins.\n```openui-lang\nroot = Card([])\n```\n"
  };
  await withGateway(
    providers((model) => replies[model ?? ""] ?? "", rec),
    async ({ port, runtime }) => {
      const { client, close } = await connect(port);
      await client.waitFor((m) => m.type === WS_EVENTS.SESSION_CONFIG);
      client.send({ type: WS_EVENTS.VAD_SPEECH_START, requestId: "v1", turnMode: "live", startedAt: 1 });
      client.send({
        type: WS_EVENTS.AUDIO_CHUNK,
        requestId: "v1",
        chunk: Buffer.alloc(4800).toString("base64"),
        mimeType: "audio/pcm;rate=24000",
        sequence: 0,
        turnMode: "live"
      });
      client.send({ type: WS_EVENTS.VAD_SPEECH_END, requestId: "v1", endedAt: 2, reason: "silence", caption: "rough caption" });
      const start = await client.waitFor<Extract<ServerMessage, { type: "brain.start" }>>((m) => m.type === WS_EVENTS.BRAIN_START);
      await client.waitFor((m) => m.type === WS_EVENTS.BRAIN_DONE);
      await client.waitFor(
        (m) => isList(m) && (m as ConversationsListMessage).items.length === 1 && client.messages.filter(isList).length >= 2
      );
      const [summary] = await runtime.store.conversations.list(runtime.ownerId);
      const record = await runtime.store.conversations.get(runtime.ownerId, summary!.id);
      assert.deepEqual(
        record!.messages.map((m) => [m.role, m.content, m.requestId, m.source, m.kind, m.task, m.model]),
        [
          ["user", "accurate words", "v1", "audio", undefined, undefined, undefined],
          ["assistant", "Let me check.", "v1", undefined, undefined, undefined, "voice/fast"],
          ["assistant", "The Air wins.", start.requestId, undefined, "brain", "Compare laptops", "brain/deep"]
        ]
      );
      assert.equal(record!.messages[2]!.ui, "root = Card([])\n");
      assert.equal(record!.title, "accurate words");
      assert.deepEqual(historyFromMessages(record!.messages).map((m) => m.content), [
        "accurate words",
        "Let me check.",
        "[deep brain] The Air wins. (A visual with the details is on the user's screen.)"
      ]);
      close();
    },
    {
      modelCatalog: liveCatalog,
      genUiSystemPrompt: "GENUI",
      live: { voicePrompt: "VOICE", brainPrompt: () => "BRAIN" }
    }
  );
});

test("owner token: upgrades without the right token get 401, /healthz stays open", async () => {
  await withGateway(
    providers(() => "Hi.", { llm: [] }),
    async ({ port }) => {
      const health = await fetch(`http://127.0.0.1:${port}/healthz`);
      assert.equal(health.status, 200);
      assert.equal(((await health.json()) as { ownerLogin: boolean }).ownerLogin, true);

      for (const query of ["", "?token=wrong", "?token=s3cret-tokenx", "?token="]) {
        const status = await new Promise<number>((resolve, reject) => {
          const socket = new WebSocket(`ws://127.0.0.1:${port}${query}`);
          socket.once("unexpected-response", (_req, res) => {
            resolve(res.statusCode ?? 0);
            res.destroy();
          });
          socket.once("open", () => reject(new Error(`opened with ${query}`)));
          socket.on("error", () => undefined);
        });
        assert.equal(status, 401, query);
      }
      const ok = await connect(port, `?token=${encodeURIComponent("s3cret-token")}`);
      await ok.client.waitFor((m) => m.type === WS_EVENTS.SESSION_START);
      ok.close();
    },
    { ownerToken: "s3cret-token" }
  );
  assert.equal(tokensMatch("abc", "abc"), true);
  assert.equal(tokensMatch("abc", undefined), false);
  assert.equal(tokensMatch("", undefined), false);
});
