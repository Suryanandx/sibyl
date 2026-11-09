import { describe, expect, it } from "vitest";
import { AGENT_EVENTS, WS_EVENTS, type ToolArtifactView } from "@open-gpt-live/protocol";
import { autoOpenAction, createAutoOpenMemory, mediaTypeOfTool } from "./auto-open";
import { filePreviewOf, itemLabel, parseCsv } from "./preview";
import { sidePanelSources } from "./sources";
import { initialState, pendingId, reduce, type PanelAction } from "./state";

const started = (toolName: string, callId = "call-1", requestId = "req-1") => ({ type: WS_EVENTS.TOOL_STARTED, requestId, callId, toolName, title: toolName });
const finished = (callId: string, extra: Record<string, unknown> = {}) => ({ type: WS_EVENTS.TOOL_FINISHED, requestId: "req-1", callId, status: "ok", ...extra });
const deck: ToolArtifactView = { id: "deck-1", kind: "slides", title: "Q3 review", version: 1, editUrl: "/slides/presentation?id=deck-1" };

describe("auto-open from socket events", () => {
  it("opens the agent's computer on the first computer step of a turn, once", () => {
    const memory = createAutoOpenMemory();
    expect(autoOpenAction({ type: AGENT_EVENTS.TURN, requestId: "req-1", agentId: "agent-1" }, memory, 1)).toBeNull();
    expect(autoOpenAction(started("computer_open"), memory, 2)).toEqual({ type: "open", auto: true, item: { kind: "computer", agentId: "agent-1" }, at: 2 });
    expect(autoOpenAction(started("computer_click", "call-2"), memory, 3)).toBeNull();
  });

  it("needs to know whose turn it is (no agent: no computer)", () => {
    expect(autoOpenAction(started("computer_open"), createAutoOpenMemory(), 1)).toBeNull();
  });

  it("a deck build opens a placeholder that becomes the deck", () => {
    const memory = createAutoOpenMemory();
    const start = autoOpenAction(started("create_slides"), memory, 1);
    expect(start).toMatchObject({ type: "open", auto: true, status: "running", callId: "call-1", item: { kind: "slides", artifactId: pendingId("call-1") } });
    const done = autoOpenAction(finished("call-1", { artifact: deck }), memory, 2);
    expect(done).toEqual({ type: "resolve", callId: "call-1", item: { kind: "slides", artifactId: "deck-1", title: "Q3 review" }, artifact: deck, at: 2 });

    let state = reduce(initialState(), { type: "conversation", id: "c1" });
    state = [start!, done!].reduce(reduce, state);
    expect(state.open).toBe(true);
    expect(state.activeKey).toBe("slides:deck-1");
  });

  it("a build that fails resolves to failed", () => {
    const memory = createAutoOpenMemory();
    autoOpenAction(started("revise_slides"), memory, 1);
    expect(autoOpenAction({ ...finished("call-1"), status: "error" }, memory, 2)).toEqual({ type: "resolve", callId: "call-1", item: null, at: 2 });
  });

  it("media jobs open a placeholder and resolve to the file they return", () => {
    const memory = createAutoOpenMemory();
    expect(autoOpenAction(started("create_video"), memory, 1)).toMatchObject({ item: { kind: "media", mediaType: "video", uploadId: pendingId("call-1") } });
    const file: ToolArtifactView = { id: "up-9", kind: "file", title: "Sunset", version: 1 };
    expect(autoOpenAction(finished("call-1", { artifact: file }), memory, 2)).toEqual({
      type: "resolve",
      callId: "call-1",
      item: { kind: "media", uploadId: "up-9", mediaType: "video", title: "Sunset" },
      at: 2
    });
  });

  it("a media library item resolves to its first file and keeps its id for render progress", () => {
    const memory = createAutoOpenMemory();
    autoOpenAction(started("create_image"), memory, 1);
    const media = { id: "md_1", kind: "image", status: "done", model: "m", prompt: "p", settings: {}, references: [], outputs: [{ uploadId: "up_2", mime: "image/png", size: 1, url: "/api/uploads/up_2" }], estimateUsd: 0, createdAt: 1, updatedAt: 1 } as const;
    const artifact: ToolArtifactView = { id: "md_1", kind: "media", title: "Fox", version: 1, media: { ...media, references: [], outputs: [...media.outputs] } };
    expect(autoOpenAction(finished("call-1", { artifact }), memory, 2)).toMatchObject({ type: "resolve", item: { kind: "media", uploadId: "up_2", jobId: "md_1", mediaType: "image" } });
  });

  it("a deck from a call it didn't see start still opens", () => {
    expect(autoOpenAction(finished("other", { artifact: deck }), createAutoOpenMemory(), 1)).toMatchObject({ type: "open", auto: true, item: { kind: "slides", artifactId: "deck-1" } });
  });

  it("a page the AI read joins the list without opening", () => {
    const action = autoOpenAction(finished("call-5", { link: { url: "https://example.com/", title: "Example" } }), createAutoOpenMemory(), 1) as PanelAction;
    expect(action).toEqual({ type: "record", item: { kind: "url", url: "https://example.com/", title: "Example" }, at: 1 });
  });

  it("ignores everything else", () => {
    const memory = createAutoOpenMemory();
    expect(autoOpenAction(started("web_search"), memory, 1)).toBeNull();
    expect(autoOpenAction(finished("call-1"), memory, 1)).toBeNull();
    expect(autoOpenAction({ type: "usage.update" }, memory, 1)).toBeNull();
  });

  it("knows which tools make media", () => {
    expect(mediaTypeOfTool("create_image")).toBe("image");
    expect(mediaTypeOfTool("generate_images")).toBe("image");
    expect(mediaTypeOfTool("create_video")).toBe("video");
    expect(mediaTypeOfTool("create_music")).toBe("audio");
    expect(mediaTypeOfTool("create_speech")).toBe("audio");
    expect(mediaTypeOfTool("create_slides")).toBeNull();
    expect(mediaTypeOfTool("create_routine")).toBeNull();
  });
});

describe("previews", () => {
  it("chooses how a file is shown", () => {
    expect(filePreviewOf("image/png")).toBe("image");
    expect(filePreviewOf("application/pdf")).toBe("pdf");
    expect(filePreviewOf("application/octet-stream", "notes.md")).toBe("markdown");
    expect(filePreviewOf("text/csv; charset=utf-8")).toBe("csv");
    expect(filePreviewOf("text/plain")).toBe("text");
    expect(filePreviewOf("application/json")).toBe("text");
    expect(filePreviewOf("video/mp4")).toBe("video");
    expect(filePreviewOf("audio/mpeg")).toBe("audio");
    expect(filePreviewOf("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "a.docx")).toBe("download");
    expect(filePreviewOf("text/html")).toBe("text");
  });

  it("reads CSV with quotes and stops at the row limit", () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\n\n3,4').rows).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
      ["3", "4"]
    ]);
    const many = Array.from({ length: 10 }, (_, i) => `${i},${i}`).join("\n");
    expect(parseCsv(many, 3)).toEqual({ rows: [["0", "0"], ["1", "1"], ["2", "2"]], more: true });
  });

  it("names entries", () => {
    expect(itemLabel({ kind: "computer", agentId: "a" }, "Ada")).toBe("Ada's computer");
    expect(itemLabel({ kind: "url", url: "https://www.example.com/x" })).toBe("example.com");
    expect(itemLabel({ kind: "media", uploadId: "u", mediaType: "audio" })).toBe("Audio");
    expect(itemLabel({ kind: "file", uploadId: "u", name: "a.pdf", mime: "application/pdf" })).toBe("a.pdf");
  });
});

describe("sources from the chat", () => {
  it("collects visuals by turn and decks by id", () => {
    const sources = sidePanelSources([
      { id: "u1", role: "user", requestId: "r1" },
      { id: "a1", role: "assistant", requestId: "r1", ui: "root = Card()", done: true, tools: [{ artifact: deck }] },
      { id: "a2", role: "assistant", requestId: "r2", ui: "root = Table()", done: false }
    ]);
    expect(sources.visuals.r1).toEqual({ source: "root = Card()", streaming: false, latest: false });
    expect(sources.visuals.r2).toEqual({ source: "root = Table()", streaming: true, latest: true });
    expect(sources.decks["deck-1"]).toBe(deck);
  });
});
