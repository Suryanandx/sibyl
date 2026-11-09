"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { errorText, gatewayRequest } from "../lib/gateway-http";
import { Icon } from "./Icon";
import { Button, Card, CardHeader, Checkbox, EmptyState, Input, Muted, Notice, Row, Spacer, Stack, cx } from "./ui";
import styles from "./settings/settings.module.css";

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
      setState(await gatewayRequest<MemoryState>("/api/memory"));
      setError(null);
    } catch (cause) {
      setError(`Couldn't load memory: ${errorText(cause)}`);
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
      setError(errorText(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function add(event: FormEvent): Promise<void> {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    if (await run(() => gatewayRequest("/api/memory", { method: "POST", body: { text } }))) setDraft("");
  }

  async function saveEdit(): Promise<void> {
    if (!editing) return;
    const { id, text } = editing;
    if (await run(() => gatewayRequest(`/api/memory/${encodeURIComponent(id)}`, { method: "PATCH", body: { text } }))) setEditing(null);
  }

  if (!state) {
    return error ? <Notice tone="danger">{error}</Notice> : <Muted>Loading memory…</Muted>;
  }

  if (!state.available) {
    return <Notice tone="warning">Memory is turned off on this Sibyl (SIBYL_MEMORY=false). Ask whoever runs it to turn it on.</Notice>;
  }

  const itemPath = (id: string) => `/api/memory/${encodeURIComponent(id)}`;

  return (
    <Stack>
      <Card>
        <Checkbox
          label={<strong>Remember things across chats</strong>}
          checked={state.enabled}
          disabled={busy}
          onChange={(event) => {
            const enabled = event.target.checked;
            void run(() => gatewayRequest("/api/memory/settings", { method: "PUT", body: { enabled } }));
          }}
        />
        <Muted>
          When you say &ldquo;remember that…&rdquo;, Sibyl saves a short fact here and uses it in every chat and voice conversation. Passwords, keys and
          card numbers are never stored.
        </Muted>
      </Card>

      {error ? <Notice tone="danger">{error}</Notice> : null}

      <form className={styles.inline} onSubmit={(event) => void add(event)}>
        <Input
          placeholder="Add a fact, e.g. “I prefer metric units”"
          maxLength={MAX_CHARS}
          value={draft}
          disabled={busy || !state.enabled}
          onChange={(event) => setDraft(event.target.value)}
          aria-label="New memory"
        />
        <Button type="submit" variant="primary" disabled={busy || !state.enabled || !draft.trim()}>
          <Icon name="plus" size={15} />
          Add
        </Button>
      </form>

      {state.items.length === 0 ? (
        <EmptyState compact title="Nothing remembered yet" />
      ) : (
        <Card>
          <CardHeader
            title="Remembered"
            meta={`${state.items.length} fact${state.items.length === 1 ? "" : "s"} · pinned first, then most recent`}
          />
          <ul className={cx(styles.rows, !state.enabled && styles.off)}>
            {state.items.map((item) => (
              <li key={item.id} className={styles.row}>
                {editing?.id === item.id ? (
                  <form
                    className={cx(styles.inline, styles.rowMain)}
                    style={{ flexDirection: "row" }}
                    onSubmit={(event) => {
                      event.preventDefault();
                      void saveEdit();
                    }}
                  >
                    <Input
                      autoFocus
                      maxLength={MAX_CHARS}
                      value={editing.text}
                      onChange={(event) => setEditing({ id: item.id, text: event.target.value })}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") setEditing(null);
                      }}
                      aria-label="Edit memory"
                    />
                    <Button type="submit" variant="ghost" iconOnly aria-label="Save" disabled={busy || !editing.text.trim()}>
                      <Icon name="check" size={16} />
                    </Button>
                    <Button variant="ghost" iconOnly aria-label="Cancel" onClick={() => setEditing(null)}>
                      <Icon name="close" size={16} />
                    </Button>
                  </form>
                ) : (
                  <>
                    <span className={styles.rowMain}>{item.text}</span>
                    <span className={styles.rowEnd}>
                      <Button
                        variant={item.pinned ? "secondary" : "ghost"}
                        size="sm"
                        aria-pressed={Boolean(item.pinned)}
                        title={item.pinned ? "Unpin" : "Pin (always included first)"}
                        disabled={busy}
                        onClick={() => void run(() => gatewayRequest(itemPath(item.id), { method: "PATCH", body: { pinned: !item.pinned } }))}
                      >
                        {item.pinned ? "Pinned" : "Pin"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        iconOnly
                        aria-label={`Edit “${item.text}”`}
                        disabled={busy}
                        onClick={() => setEditing({ id: item.id, text: item.text })}
                      >
                        <Icon name="pencil" size={15} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        iconOnly
                        aria-label={`Delete “${item.text}”`}
                        disabled={busy}
                        onClick={() => void run(() => gatewayRequest(itemPath(item.id), { method: "DELETE" }))}
                      >
                        <Icon name="close" size={15} />
                      </Button>
                    </span>
                  </>
                )}
              </li>
            ))}
          </ul>
          <Row>
            <Spacer />
            {confirmClear ? (
              <>
                <Button variant="ghost" onClick={() => setConfirmClear(false)}>
                  Keep
                </Button>
                <Button
                  variant="danger"
                  disabled={busy}
                  onClick={() => void run(() => gatewayRequest("/api/memory", { method: "DELETE" })).then(() => setConfirmClear(false))}
                >
                  Forget everything
                </Button>
              </>
            ) : (
              <Button variant="danger" size="sm" onClick={() => setConfirmClear(true)}>
                Forget everything…
              </Button>
            )}
          </Row>
        </Card>
      )}
    </Stack>
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
