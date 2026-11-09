"use client";

/**
 * The side panel's store: state.ts's reducer in a zustand store, kept in this
 * browser (Activity lists per chat, where the person closed it, the width).
 */
import { create } from "zustand";
import { fromStored, initialState, reduce, toStored, type PanelAction, type PanelState } from "./state";

const STORAGE_KEY = "sibyl.sidePanel.v1";

function load(): Partial<PanelState> {
  try {
    return fromStored(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null"));
  } catch {
    return {};
  }
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function save(state: PanelState): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(toStored(state)));
    } catch {
      // Private mode or full storage: the panel still works for this page.
    }
  }, 250);
}

interface SidePanelStore extends PanelState {
  loaded: boolean;
  dispatch(action: PanelAction): void;
  /** Read what this browser kept (after mount, so server and client render alike). */
  hydrate(): void;
}

export const useSidePanelStore = create<SidePanelStore>((set, get) => ({
  ...initialState(),
  loaded: false,
  dispatch(action) {
    const { loaded, dispatch, hydrate, ...current } = get();
    const next = reduce(current, action);
    if (next === current) return;
    set(next);
    if (loaded) save(next);
  },
  hydrate() {
    if (get().loaded) return;
    const stored = load();
    set((state) => ({
      ...state,
      ...stored,
      // Anything already recorded on this page wins over the stored copy.
      history: { ...stored.history, ...state.history },
      dismissed: { ...stored.dismissed, ...state.dismissed },
      loaded: true
    }));
  }
}));
