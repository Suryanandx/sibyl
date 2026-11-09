/**
 * Delivery channels for notifications, discovered through one registry.
 *
 * - inbox: always available and always used (registered by the
 *   NotificationService: store + live push).
 * - email: the gateway's one mailer (SIBYL_SMTP_URL) to the recipient's
 *   account email.
 * - slack / teams: registered as unavailable until their connectors land; a
 *   connector calls `registry.register({ channel: "slack", ... })` to replace
 *   the placeholder. Nothing else needs to change.
 */
import type { NotificationChannel, NotificationRecord } from "@open-gpt-live/core";
import type { Mailer } from "./mailer.js";

export interface NotifyRecipient {
  userId?: string;
  email?: string;
  name?: string;
}

export type Availability = { ok: true } | { ok: false; reason: string };

export interface ChannelContext {
  ownerId: string;
  workspaceId: string;
  recipient: NotifyRecipient;
}

export interface Notifier {
  channel: NotificationChannel;
  /** Can this channel deliver to this recipient right now? */
  available(context: ChannelContext): Availability | Promise<Availability>;
  send(delivery: { record: NotificationRecord; recipient: NotifyRecipient }): Promise<void>;
}

export interface ChannelAvailability {
  channel: NotificationChannel;
  available: boolean;
  reason?: string;
}

export class NotifierRegistry {
  private readonly notifiers = new Map<NotificationChannel, Notifier>();

  /** Add or replace the notifier for a channel. Returns a function that restores the previous one. */
  register(notifier: Notifier): () => void {
    const previous = this.notifiers.get(notifier.channel);
    this.notifiers.set(notifier.channel, notifier);
    return () => {
      if (this.notifiers.get(notifier.channel) !== notifier) return;
      if (previous) this.notifiers.set(notifier.channel, previous);
      else this.notifiers.delete(notifier.channel);
    };
  }

  get(channel: NotificationChannel): Notifier | undefined {
    return this.notifiers.get(channel);
  }

  channels(): NotificationChannel[] {
    return [...this.notifiers.keys()];
  }

  async availability(context: ChannelContext): Promise<ChannelAvailability[]> {
    const out: ChannelAvailability[] = [];
    for (const [channel, notifier] of this.notifiers) {
      try {
        const result = await notifier.available(context);
        out.push(result.ok ? { channel, available: true } : { channel, available: false, reason: result.reason });
      } catch (error) {
        out.push({ channel, available: false, reason: errorText(error) });
      }
    }
    return out;
  }
}

/** Placeholder for a channel whose connector isn't installed yet. */
export function unavailableNotifier(channel: NotificationChannel, reason: string): Notifier {
  return {
    channel,
    available: () => ({ ok: false, reason }),
    send: async () => {
      throw new Error(reason);
    }
  };
}

/** Email through the shared mailer; unavailable without SMTP or without the recipient's address. */
export function emailNotifier(options: { mailer: Mailer | undefined; appUrl?: string }): Notifier {
  const { mailer } = options;
  return {
    channel: "email",
    available: ({ recipient }) => {
      if (!mailer) return { ok: false, reason: "Email isn't set up on this server (SIBYL_SMTP_URL)." };
      if (!recipient.email) return { ok: false, reason: recipient.userId ? "Your account has no email address." : "No email address to send this to." };
      return { ok: true };
    },
    async send({ record, recipient }) {
      if (!mailer) throw new Error("Email isn't set up on this server (SIBYL_SMTP_URL).");
      if (!recipient.email) throw new Error("No email address for the recipient.");
      const link = options.appUrl ? `${options.appUrl.replace(/\/+$/, "")}${notificationPath(record)}` : undefined;
      const text = [record.body || record.title, ...(link ? ["", `Open in Sibyl: ${link}`] : [])].join("\n");
      await mailer.send({ to: recipient.email, subject: `Sibyl: ${record.title}`, text });
    }
  };
}

/** Web-app path a notification leads to (the browser has the same mapping in its routes). */
export function notificationPath(record: Pick<NotificationRecord, "kind" | "links">): string {
  const { links } = record;
  if (record.kind === "approval_needed") return "/inbox";
  if (links.meetingId) return `/meetings/${encodeURIComponent(links.meetingId)}`;
  if (links.conversationId) return `/c/${encodeURIComponent(links.conversationId)}`;
  if (links.monitorId) return "/monitors";
  if (links.routineId) return "/routines";
  if (links.agentId) return "/agents";
  if (links.artifactId) return "/library/slides";
  return "/inbox";
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
