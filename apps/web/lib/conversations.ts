/**
 * Past conversations, kept in this browser only (localStorage). Each live
 * session on the Gateway is fresh; saved conversations can be reopened to read
 * (including their visuals) and start a new chat from.
 */
export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  requestId: string;
  source?: "text" | "audio" | "ui";
  ui?: string;
  kind?: "brain";
  task?: string;
  model?: string;
}

export interface StoredConversation {
  id: string;
  title: string;
  updatedAt: number;
  messages: StoredMessage[];
}

const KEY = "sibyl.conversations.v1";
const MAX_CONVERSATIONS = 50;

export function loadConversations(): StoredConversation[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as StoredConversation[]) : [];
    return Array.isArray(parsed) ? parsed.sort((a, b) => b.updatedAt - a.updatedAt) : [];
  } catch {
    return [];
  }
}

export function saveConversation(conversation: StoredConversation): StoredConversation[] {
  const all = loadConversations().filter((item) => item.id !== conversation.id);
  const next = [conversation, ...all].slice(0, MAX_CONVERSATIONS);
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage full or blocked: history is a convenience only.
  }
  return next;
}

export function deleteConversation(id: string): StoredConversation[] {
  const next = loadConversations().filter((item) => item.id !== id);
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
  return next;
}

export function titleFor(messages: StoredMessage[]): string {
  const first = messages.find((message) => message.role === "user" && message.content.trim());
  const text = first?.content.replace(/\s+/g, " ").trim() ?? "New conversation";
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

/** Group into Today / Yesterday / Previous 7 days / Older. */
export function groupByDay(
  conversations: StoredConversation[],
  now = Date.now()
): Array<{ label: string; items: StoredConversation[] }> {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const today = startOfToday.getTime();
  const day = 86_400_000;
  const groups = [
    { label: "Today", test: (t: number) => t >= today },
    { label: "Yesterday", test: (t: number) => t >= today - day && t < today },
    { label: "Previous 7 days", test: (t: number) => t >= today - 7 * day && t < today - day },
    { label: "Older", test: (t: number) => t < today - 7 * day }
  ];
  return groups
    .map((group) => ({
      label: group.label,
      items: conversations.filter((item) => group.test(item.updatedAt))
    }))
    .filter((group) => group.items.length > 0);
}

/** Markdown export of a conversation (used by Share). */
export function toMarkdown(title: string, messages: StoredMessage[]): string {
  const lines = [`# ${title}`, "", `_Exported from Sibyl on ${new Date().toLocaleString()}_`, ""];
  for (const message of messages) {
    if (!message.content.trim() && !message.ui) continue;
    const who = message.role === "user" ? "You" : message.kind === "brain" ? "Sibyl (deep work)" : "Sibyl";
    lines.push(`**${who}:** ${message.content.trim()}`);
    if (message.ui?.trim()) {
      lines.push("", "```openui-lang", message.ui.trim(), "```");
    }
    lines.push("");
  }
  return lines.join("\n");
}
