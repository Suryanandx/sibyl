"use client";

import { useMemo, useState } from "react";
import type { ModelCatalog, SessionSettings } from "@open-gpt-live/protocol";
import { groupByDay, type ConversationSummary } from "../lib/conversations";
import { Icon } from "./Icon";

interface SidebarProps {
  open: boolean;
  catalog: ModelCatalog | null;
  settings: SessionSettings | null;
  conversations: ConversationSummary[];
  activeConversationId: string | null;
  onNewChat: () => void;
  onOpenConversation: (id: string) => void;
  onDeleteConversation: (id: string) => void;
  onApplyPreset: (settings: Partial<SessionSettings>) => void;
  onOpenSettings: () => void;
  onClose: () => void;
}

const PRESET_INITIAL: Record<string, string> = {
  cheapest: "C",
  balanced: "B",
  fastest: "F",
  best: "Q"
};

export function Sidebar(props: SidebarProps) {
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? props.conversations.filter((item) => item.title.toLowerCase().includes(needle))
      : props.conversations;
    return groupByDay(filtered);
  }, [props.conversations, query]);

  const presets = props.catalog?.presets ?? [];
  const isActivePreset = (preset: { settings: Partial<SessionSettings> }) =>
    Boolean(props.settings) &&
    Object.entries(preset.settings).every(
      ([key, value]) => props.settings?.[key as keyof SessionSettings] === value
    );

  return (
    <aside className={`sidebar${props.open ? " open" : ""}`} aria-label="Conversations">
      <div className="sidebarHead">
        <span className="sidebarTitle">Chat</span>
        <button
          type="button"
          className="iconBtn"
          aria-label="Search conversations"
          onClick={() => setSearching((value) => !value)}
        >
          <Icon name="search" />
        </button>
        <button type="button" className="iconBtn mobileOnly" aria-label="Close sidebar" onClick={props.onClose}>
          <Icon name="close" />
        </button>
      </div>

      <button type="button" className="newChat" onClick={props.onNewChat}>
        <Icon name="plus" size={16} />
        New chat
        <Icon name="sparkle" size={15} />
      </button>

      {searching ? (
        <input
          className="sidebarSearch"
          autoFocus
          placeholder="Search conversations"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      ) : null}

      {presets.length > 0 ? (
        <section className="sidebarSection">
          <h3>
            <Icon name="layers" size={14} /> Model presets
          </h3>
          <ul>
            {presets.map((preset) => (
              <li key={preset.id}>
                <button
                  type="button"
                  className={`sidebarItem preset-${preset.id}${isActivePreset(preset) ? " active" : ""}`}
                  onClick={() => props.onApplyPreset(preset.settings)}
                  title={`Use the ${preset.label} models`}
                >
                  <span className="itemBadge">{PRESET_INITIAL[preset.id] ?? preset.label[0]}</span>
                  <span className="itemLabel">{preset.label}</span>
                  {preset.costPer100Turns !== undefined ? (
                    <span className="itemMeta">${preset.costPer100Turns.toFixed(2)}</span>
                  ) : null}
                  {isActivePreset(preset) ? <Icon name="check" size={14} className="itemCheck" /> : null}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="sidebarHistory">
        {groups.length === 0 ? (
          <p className="sidebarEmpty">
            {query ? "No conversations match." : "Your conversations will appear here."}
          </p>
        ) : (
          groups.map((group) => (
            <section className="sidebarSection" key={group.label}>
              <h3>{group.label}</h3>
              <ul>
                {group.items.map((item) => (
                  <li key={item.id} className="historyRow">
                    <button
                      type="button"
                      className={`historyItem${item.id === props.activeConversationId ? " active" : ""}`}
                      onClick={() => props.onOpenConversation(item.id)}
                      title={item.title}
                    >
                      {item.title}
                    </button>
                    <button
                      type="button"
                      className="historyDelete"
                      aria-label={`Delete “${item.title}”`}
                      onClick={() => props.onDeleteConversation(item.id)}
                    >
                      <Icon name="close" size={13} />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>

      <button type="button" className="sidebarFooterBtn" onClick={props.onOpenSettings}>
        <Icon name="sliders" size={16} />
        Models &amp; voice
      </button>
    </aside>
  );
}
