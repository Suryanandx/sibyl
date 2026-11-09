import { describe, expect, it } from "vitest";
import { legacyRedirect } from "../../lib/routes";
import type { SidePanelItem } from "./events";
import {
  activeEntry,
  clampWidth,
  DEFAULT_WIDTH,
  entriesOf,
  fromStored,
  initialState,
  itemFromKey,
  itemKey,
  MAX_ENTRIES,
  MAX_WIDTH,
  MIN_WIDTH,
  pendingId,
  reduce,
  toStored,
  type PanelAction,
  type PanelState
} from "./state";

const computer: SidePanelItem = { kind: "computer", agentId: "agent-1" };
const deck: SidePanelItem = { kind: "slides", artifactId: "deck-1", title: "Q3" };
const visual: SidePanelItem = { kind: "visual", requestId: "req-1" };
const page: SidePanelItem = { kind: "url", url: "https://example.com/a", title: "Example" };

const run = (state: PanelState, ...actions: PanelAction[]) => actions.reduce(reduce, state);
const inChat = (id = "c1") => run(initialState(), { type: "conversation", id });

describe("side panel: open and close", () => {
  it("opens what the person asks for, and remembers it in the chat's Activity list", () => {
    const state = run(inChat(), { type: "open", item: visual, at: 1 }, { type: "open", item: page, at: 2 });
    expect(state.open).toBe(true);
    expect(activeEntry(state)?.item).toEqual(page);
    expect(entriesOf(state).map((entry) => entry.key)).toEqual(["visual:req-1", "url:https://example.com/a"]);
  });

  it("opening the same thing again doesn't add a second entry", () => {
    const state = run(inChat(), { type: "open", item: visual, at: 1 }, { type: "open", item: { ...visual, title: "Chart" }, at: 2 });
    expect(entriesOf(state)).toHaveLength(1);
    expect(entriesOf(state)[0]!.item).toEqual({ ...visual, title: "Chart" });
  });

  it("select switches between entries; unknown keys are ignored", () => {
    const state = run(inChat(), { type: "open", item: visual, at: 1 }, { type: "open", item: page, at: 2 }, { type: "select", key: "visual:req-1" });
    expect(state.activeKey).toBe("visual:req-1");
    expect(reduce(state, { type: "select", key: "visual:nope" })).toBe(state);
  });

  it("toggle reopens the last entry and closing by the person counts as closed for this chat", () => {
    let state = run(inChat(), { type: "open", item: visual, at: 1 }, { type: "toggle" });
    expect(state.open).toBe(false);
    expect(state.dismissed.c1).toBe(true);
    state = reduce(state, { type: "toggle" });
    expect(state.open).toBe(true);
    expect(state.activeKey).toBe("visual:req-1");
    expect(state.dismissed.c1).toBeUndefined();
  });

  it("toggle does nothing when the chat has nothing to show", () => {
    const state = inChat();
    expect(reduce(state, { type: "toggle" })).toBe(state);
  });

  it("removing the shown entry shows the previous one, or closes when none is left", () => {
    let state = run(inChat(), { type: "open", item: visual, at: 1 }, { type: "open", item: page, at: 2 }, { type: "remove", key: "url:https://example.com/a" });
    expect(state.activeKey).toBe("visual:req-1");
    state = reduce(state, { type: "remove", key: "visual:req-1" });
    expect(state.open).toBe(false);
    expect(state.activeKey).toBeNull();
  });

  it("keeps at most MAX_ENTRIES per chat", () => {
    let state = inChat();
    for (let i = 0; i < MAX_ENTRIES + 5; i += 1) state = reduce(state, { type: "open", item: { kind: "visual", requestId: `r${i}` }, at: i });
    expect(entriesOf(state)).toHaveLength(MAX_ENTRIES);
    expect(entriesOf(state)[0]!.key).toBe("visual:r5");
  });
});

describe("side panel: auto-open rules", () => {
  it("what the AI starts opens the panel", () => {
    const state = reduce(inChat(), { type: "open", item: computer, auto: true, at: 1 });
    expect(state.open).toBe(true);
    expect(state.activeKey).toBe("computer:agent-1");
  });

  it("after the person closed it in this chat, AI items only join the list", () => {
    const state = run(inChat(), { type: "open", item: visual, at: 1 }, { type: "close", user: true }, { type: "open", item: computer, auto: true, at: 2 });
    expect(state.open).toBe(false);
    expect(entriesOf(state).map((entry) => entry.key)).toContain("computer:agent-1");
  });

  it("closing from Back/Forward isn't the person dismissing it", () => {
    const state = run(inChat(), { type: "open", item: visual, at: 1 }, { type: "close", user: false }, { type: "open", item: computer, auto: true, at: 2 });
    expect(state.open).toBe(true);
    expect(state.activeKey).toBe("computer:agent-1");
  });

  it("closed in one chat still auto-opens in another", () => {
    let state = run(inChat("c1"), { type: "open", item: visual, at: 1 }, { type: "close", user: true });
    state = run(state, { type: "conversation", id: "c2" }, { type: "open", item: computer, auto: true, at: 2 });
    expect(state.open).toBe(true);
  });

  it("opening something yourself clears the closed mark", () => {
    const state = run(inChat(), { type: "open", item: visual, at: 1 }, { type: "close", user: true }, { type: "open", item: page, at: 2 }, { type: "open", item: computer, auto: true, at: 3 });
    expect(state.dismissed.c1).toBeUndefined();
    expect(state.activeKey).toBe("computer:agent-1");
  });

  it("doesn't pull the person away from another entry for something already listed", () => {
    const state = run(
      inChat(),
      { type: "open", item: computer, auto: true, at: 1 },
      { type: "open", item: visual, at: 2 },
      { type: "open", item: computer, auto: true, at: 3 }
    );
    expect(state.activeKey).toBe("visual:req-1");
  });

  it("a build is a placeholder until its tool call finishes, then becomes the deck", () => {
    const pending: SidePanelItem = { kind: "slides", artifactId: pendingId("call-1"), title: "Building the deck" };
    let state = reduce(inChat(), { type: "open", item: pending, auto: true, status: "running", callId: "call-1", at: 1 });
    expect(activeEntry(state)?.status).toBe("running");
    state = reduce(state, { type: "resolve", callId: "call-1", item: deck, at: 2 });
    expect(state.activeKey).toBe("slides:deck-1");
    expect(activeEntry(state)?.status).toBeUndefined();
    expect(entriesOf(state)).toHaveLength(1);
  });

  it("a revision replaces the same deck already in the list", () => {
    let state = reduce(inChat(), { type: "open", item: deck, at: 1 });
    state = reduce(state, { type: "open", item: { kind: "slides", artifactId: pendingId("c2") }, auto: true, status: "running", callId: "c2", at: 2 });
    state = reduce(state, { type: "resolve", callId: "c2", item: deck, at: 3 });
    expect(entriesOf(state).map((entry) => entry.key)).toEqual(["slides:deck-1"]);
  });

  it("a failed build stays in the list, marked failed", () => {
    let state = reduce(inChat(), { type: "open", item: { kind: "media", uploadId: pendingId("c3"), mediaType: "image" }, auto: true, status: "running", callId: "c3", at: 1 });
    state = reduce(state, { type: "resolve", callId: "c3", item: null, at: 2 });
    expect(activeEntry(state)?.status).toBe("failed");
  });

  it("resolve for a call it never saw changes nothing", () => {
    const state = inChat();
    expect(reduce(state, { type: "resolve", callId: "x", item: deck, at: 1 })).toBe(state);
  });

  it("record adds to the list without opening", () => {
    const state = reduce(inChat(), { type: "record", item: page, at: 1 });
    expect(state.open).toBe(false);
    expect(entriesOf(state)).toHaveLength(1);
  });
});

describe("side panel: conversations", () => {
  it("each chat has its own list; switching closes the panel and restores that chat's list", () => {
    let state = run(inChat("c1"), { type: "open", item: visual, at: 1 });
    state = reduce(state, { type: "conversation", id: "c2" });
    expect(state.open).toBe(false);
    expect(entriesOf(state)).toEqual([]);
    state = reduce(state, { type: "conversation", id: "c1" });
    expect(entriesOf(state).map((entry) => entry.key)).toEqual(["visual:req-1"]);
    expect(state.activeKey).toBe("visual:req-1");
    expect(state.open).toBe(false);
  });

  it("a new chat keeps its list and open panel when its first message gives it an id", () => {
    let state = run(initialState(), { type: "conversation", id: null }, { type: "open", item: computer, auto: true, at: 1 });
    state = reduce(state, { type: "conversation", id: "c9" });
    expect(state.open).toBe(true);
    expect(entriesOf(state).map((entry) => entry.key)).toEqual(["computer:agent-1"]);
    expect(state.history[""]).toBeUndefined();
  });

  it("opening an older chat from a new one drops the new chat's unsaved list", () => {
    let state = run(inChat("old"), { type: "open", item: visual, at: 1 }, { type: "conversation", id: null }, { type: "open", item: page, at: 2 });
    state = reduce(state, { type: "conversation", id: "old" });
    expect(entriesOf(state).map((entry) => entry.key)).toEqual(["visual:req-1"]);
    expect(state.history[""]).toBeUndefined();
  });
});

describe("side panel: address and storage", () => {
  it("keys round-trip for items the key alone describes", () => {
    for (const item of [computer, { kind: "computer", agentId: "a", runId: "r" } as SidePanelItem, { kind: "slides", artifactId: "d" } as SidePanelItem, visual, { kind: "url", url: "https://x.test/?q=1" } as SidePanelItem]) {
      expect(itemFromKey(itemKey(item))).toEqual(item);
    }
  });

  it("keys that need the Activity list (files, media), placeholders and unsafe links don't resolve alone", () => {
    expect(itemFromKey("file:u1")).toBeNull();
    expect(itemFromKey("media:u1")).toBeNull();
    expect(itemFromKey(`slides:${pendingId("c")}`)).toBeNull();
    expect(itemFromKey("url:javascript:alert(1)")).toBeNull();
    expect(itemFromKey("history")).toBeNull();
    expect(itemFromKey("bogus:1")).toBeNull();
  });

  it("show opens a listed entry, or one rebuilt from its key", () => {
    let state = run(inChat(), { type: "open", item: visual, at: 1 }, { type: "close", user: false }, { type: "show", key: "visual:req-1", at: 2 });
    expect(state.open).toBe(true);
    state = reduce(inChat(), { type: "show", key: "computer:agent-7", at: 1 });
    expect(activeEntry(state)?.item).toEqual({ kind: "computer", agentId: "agent-7" });
    const unchanged = inChat();
    expect(reduce(unchanged, { type: "show", key: "file:u1", at: 1 })).toBe(unchanged);
  });

  it("the old ?panel= redirects leave side panel keys alone", () => {
    const at = (url: string) => {
      const parsed = new URL(url, "http://sibyl.test");
      return { pathname: parsed.pathname, search: parsed.search };
    };
    expect(legacyRedirect(at("/c/abc?panel=computer:agent-1"))).toBeNull();
    expect(legacyRedirect(at(`/?panel=${encodeURIComponent("url:https://example.com/")}`))).toBeNull();
    expect(legacyRedirect(at("/c/abc?panel=inbox"))).toEqual({ to: "/inbox", conversationId: "abc" });
  });

  it("width is clamped", () => {
    expect(clampWidth(10)).toBe(MIN_WIDTH);
    expect(clampWidth(5000)).toBe(MAX_WIDTH);
    expect(clampWidth(Number.NaN)).toBe(DEFAULT_WIDTH);
    expect(clampWidth(900, 1000)).toBe(600);
    expect(reduce(inChat(), { type: "width", width: 50 }).width).toBe(MIN_WIDTH);
  });

  it("storage keeps saved chats' finished entries, closed marks and width; not builds in progress or the unsaved chat", () => {
    let state = run(
      inChat("c1"),
      { type: "open", item: visual, at: 1 },
      { type: "open", item: { kind: "slides", artifactId: pendingId("c") }, auto: true, status: "running", callId: "c", at: 2 },
      { type: "close", user: true },
      { type: "width", width: 600 }
    );
    state = { ...state, history: { ...state.history, "": [{ key: "visual:x", item: { kind: "visual", requestId: "x" }, at: 3 }] } };
    const stored = JSON.parse(JSON.stringify(toStored(state)));
    expect(Object.keys(stored.history)).toEqual(["c1"]);
    expect(stored.history.c1.map((entry: { key: string }) => entry.key)).toEqual(["visual:req-1"]);
    const restored = fromStored(stored);
    expect(restored.width).toBe(600);
    expect(restored.dismissed).toEqual({ c1: true });
    expect(restored.history?.c1).toHaveLength(1);
  });

  it("ignores broken stored data", () => {
    expect(fromStored(null)).toEqual({});
    expect(fromStored({ history: { c1: [{ nope: true }], c2: "x" }, dismissed: { c1: "yes" }, width: "wide" })).toEqual({ history: {}, dismissed: {} });
  });
});
