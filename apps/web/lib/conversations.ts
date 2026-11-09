/**
 * Conversations live on the Gateway (server-side store). The browser asks for
 * the list on connect, opens one with `conversation.open` (it becomes the live
 * conversation, with its full context restored), and deletes with
 * `conversation.delete`. These helpers only shape that data for the UI.
 */
import type { ConversationMessageView, ConversationSummary } from "@open-gpt-live/protocol";

export type { ConversationMessageView, ConversationSummary };

export function titleFor(messages: Array<Pick<ConversationMessageView, "role" | "content">>): string {
  const first = messages.find((message) => message.role === "user" && message.content.trim());
  const text = first?.content.replace(/\s+/g, " ").trim() ?? "New conversation";
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

/** Group into Today / Yesterday / Previous 7 days / Older. */
export function groupByDay<T extends { updatedAt: number }>(
  conversations: T[],
  now = Date.now()
): Array<{ label: string; items: T[] }> {
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
export function toMarkdown(
  title: string,
  messages: Array<Pick<ConversationMessageView, "role" | "content" | "ui" | "kind">>
): string {
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
