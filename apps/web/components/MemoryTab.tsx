"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { gatewayJson } from "./AttachmentClient";
import { Icon } from "./Icon";

interface MemoryItem {
  id: string;
  text: string;
  pinned?: boolean;
  createdAt: number;
  updatedAt: number;
}

interface MemoryState {
  available: boolean;
  enabled: boolean;
  items: MemoryItem[];
}

const MAX_CHARS = 300;

/** Settings → Memory: what Sibyl remembers across chats, fully user-controlled. */
export function MemoryTab() {
  const [state, setState] = useState<MemoryState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await gatewayJson<MemoryState>("/api/memory"));
      setError(null);
    } catch (cause) {
      setError(`Couldn't load memory: ${(cause as Error).message}`);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<unknown>): Promise<boolean> {
    setBusy(true);
    try {
      await action();
      await load();
      return true;
    } catch (cause) {
      setError((cause as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function add(event: FormEvent): Promise<void> {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    if (await run(() => gatewayJson("/api/memory", { method: "POST", body: { text } }))) setDraft("");
  }

  async function saveEdit(): Promise<void> {
    if (!editing) return;
    const { id, text } = editing;
    if (await run(() => gatewayJson(`/api/memory/${encodeURIComponent(id)}`, { method: "PATCH", body: { text } }))) setEditing(null);
  }

  if (!state) {
    return <p className="muted center">{error ?? "Loading memory…"}</p>;
  }

  if (!state.available) {
    return (
      <div className="fieldStack">
        <p className="memoryNotice">Memory is turned off on this Sibyl (SIBYL_MEMORY=false). Ask whoever runs it to turn it on.</p>
      </div>
    );
  }

  return (
    <div className="fieldStack memoryTab">
      <label className="toggleRow">
        <span>
          <span className="fieldLabel">Remember things across chats</span>
          <span className="fieldHint">
            When you say &ldquo;remember that…&rdquo;, Sibyl saves a short fact here and uses it in every chat and voice
            conversation. Passwords, keys and card numbers are never stored.
          </span>
        </span>
        <input
          type="checkbox"
          role="switch"
          checked={state.enabled}
          disabled={busy}
          onChange={(event) => {
            const enabled = event.target.checked;
            void run(() => gatewayJson("/api/memory/settings", { method: "PUT", body: { enabled } }));
          }}
        />
        <span className="switch" aria-hidden />
      </label>

      {error ? (
        <p className="memoryError" role="alert">
          {error}
        </p>
      ) : null}

      <form className="memoryAdd" onSubmit={(event) => void add(event)}>
        <input
          className="memoryInput"
          placeholder="Add a fact, e.g. “I prefer metric units”"
          maxLength={MAX_CHARS}
          value={draft}
          disabled={busy || !state.enabled}
          onChange={(event) => setDraft(event.target.value)}
          aria-label="New memory"
        />
        <button type="submit" className="darkBtn" disabled={busy || !state.enabled || !draft.trim()}>
          <Icon name="plus" size={15} />
          Add
        </button>
      </form>

      {state.items.length === 0 ? (
        <p className="muted center memoryEmpty">Nothing remembered yet.</p>
      ) : (
        <ul className={`memoryList${state.enabled ? "" : " off"}`}>
          {state.items.map((item) => (
            <li key={item.id} className={`memoryItem${item.pinned ? " pinned" : ""}`}>
              {editing?.id === item.id ? (
                <form
                  className="memoryEdit"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void saveEdit();
                  }}
                >
                  <input
                    className="memoryInput"
                    autoFocus
                    maxLength={MAX_CHARS}
                    value={editing.text}
                    onChange={(event) => setEditing({ id: item.id, text: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") setEditing(null);
                    }}
                    aria-label="Edit memory"
                  />
                  <button type="submit" className="iconBtn" aria-label="Save" disabled={busy || !editing.text.trim()}>
                    <Icon name="check" size={16} />
                  </button>
                  <button type="button" className="iconBtn" aria-label="Cancel" onClick={() => setEditing(null)}>
                    <Icon name="close" size={16} />
                  </button>
                </form>
              ) : (
                <>
                  <span className="memoryText">{item.text}</span>
                  <span className="memoryActions">
                    <button
                      type="button"
                      className={`memoryPin${item.pinned ? " on" : ""}`}
                      aria-pressed={Boolean(item.pinned)}
                      title={item.pinned ? "Unpin" : "Pin (always included first)"}
                      disabled={busy}
                      onClick={() =>
                        void run(() =>
                          gatewayJson(`/api/memory/${encodeURIComponent(item.id)}`, { method: "PATCH", body: { pinned: !item.pinned } })
                        )
                      }
                    >
                      {item.pinned ? "Pinned" : "Pin"}
                    </button>
                    <button
                      type="button"
                      className="iconBtn"
                      aria-label={`Edit “${item.text}”`}
                      disabled={busy}
                      onClick={() => setEditing({ id: item.id, text: item.text })}
                    >
                      <Icon name="pencil" size={15} />
                    </button>
                    <button
                      type="button"
                      className="iconBtn"
                      aria-label={`Delete “${item.text}”`}
                      disabled={busy}
                      onClick={() => void run(() => gatewayJson(`/api/memory/${encodeURIComponent(item.id)}`, { method: "DELETE" }))}
                    >
                      <Icon name="close" size={15} />
                    </button>
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {state.items.length > 0 ? (
        <div className="memoryFooter">
          <span className="fieldHint">
            {state.items.length} fact{state.items.length === 1 ? "" : "s"} · pinned first, then most recent
          </span>
          {confirmClear ? (
            <span className="memoryConfirm">
              <button type="button" className="ghostBtn" onClick={() => setConfirmClear(false)}>
                Keep
              </button>
              <button
                type="button"
                className="darkBtn danger"
                disabled={busy}
                onClick={() => void run(() => gatewayJson("/api/memory", { method: "DELETE" })).then(() => setConfirmClear(false))}
              >
                Forget everything
              </button>
            </span>
          ) : (
            <button type="button" className="ghostBtn" onClick={() => setConfirmClear(true)}>
              Forget everything…
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** Small chip under a reply when Sibyl saved something to memory. */
export function MemorySavedChip({ summary }: { summary?: string }) {
  return (
    <span className="memorySavedChip" title={summary}>
      <Icon name="check" size={13} />
      Saved to memory
    </span>
  );
}
