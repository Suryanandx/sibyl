/**
 * Notifications as one service on the runtime: the single publish path for
 * everything Sibyl tells people about.
 *
 * `notify(input)` stores a NotificationRecord (the inbox), pushes it live to
 * every connected member who may see it, then delivers it through the other
 * channels that were asked for (email via the one mailer; Slack and Teams once
 * their connectors register). Routines, monitors, agents and identity publish
 * here; nothing else stores or pushes notifications.
 *
 * Who sees a notification: it must be in the viewer's current workspace, the
 * viewer must hold the source's permission there (routines.use for routine
 * and approval notices, monitors.use for monitors, …), and when it has a
 * recipient it must be them (the org owner acting through the owner token or
 * local mode sees everything, as everywhere else).
 *
 * Read state: a notice addressed to one person is read once; a workspace-wide
 * notice is read per person (each viewer has their own unread count).
 *
 * Retention: notices older than SIBYL_NOTIFICATION_RETENTION_DAYS (default
 * 90) are deleted by a job on the shared scheduler (`retentionJob`).
 */
import { randomUUID } from "node:crypto";
import {
  DEFAULT_WORKSPACE_ID,
  NOTIFICATION_KINDS,
  PERMISSIONS,
  authorize,
  matchesNotificationQuery,
  type NotificationChannel,
  type NotificationCursor,
  type NotificationKind,
  type NotificationLinks,
  type NotificationQuery,
  type NotificationRecord,
  type Permission,
  type Principal,
  type Store
} from "@open-gpt-live/core";
import {
  NOTIFICATION_EVENTS,
  type NotificationUnreadView,
  type NotificationView,
  type NotificationsListMessage,
  type NotificationsStateMessage,
  type ServerMessage
} from "@open-gpt-live/protocol";
import type { ScheduledJobType } from "../routines/scheduler.js";
import type { Mailer } from "./mailer.js";
import { NotifierRegistry, emailNotifier, errorText, unavailableNotifier, type ChannelAvailability, type NotifyRecipient } from "./notifiers.js";

type Log = (event: string, fields?: Record<string, unknown>) => void;

/** The permission a viewer needs in the workspace to see a notification of each kind. */
export const NOTIFICATION_SOURCE_PERMISSION: Readonly<Record<NotificationKind, Permission>> = {
  approval_needed: PERMISSIONS.ROUTINES_USE,
  routine_finished: PERMISSIONS.ROUTINES_USE,
  routine_failed: PERMISSIONS.ROUTINES_USE,
  budget_blocked: PERMISSIONS.ROUTINES_USE,
  monitor_fired: PERMISSIONS.MONITORS_USE,
  monitor_paused: PERMISSIONS.MONITORS_USE,
  agent_action: PERMISSIONS.AGENTS_USE,
  deck_ready: PERMISSIONS.SLIDES_USE,
  invite_accepted: PERMISSIONS.MEMBERS_INVITE,
  meeting_notes: PERMISSIONS.CHAT_USE,
  // A message left on the phone line: the people who see the line's calls (owners and admins).
  voicemail: PERMISSIONS.CHAT_VIEW_ALL
};

export const DEFAULT_PAGE_SIZE = 30;
export const DEFAULT_RETENTION_DAYS = 90;
/** How often the retention job runs. */
export const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const TITLE_MAX = 200;
const BODY_MAX = 4_000;
const READ_CHUNK = 500;
/** Creator ids that stand for the org owner acting without an account (owner token or local mode). */
const ORG_OWNER_IDS: ReadonlySet<string> = new Set(["owner", "token", "local"]);

/** What a publisher hands to notify(). */
export interface NotificationInput {
  kind: NotificationKind;
  /** Default: the default workspace. */
  workspaceId?: string;
  /** The one person it is for (absent: everyone with access to the source). */
  recipientUserId?: string;
  title: string;
  body?: string;
  links?: NotificationLinks;
}

export interface NotifyOptions {
  /** Channels beyond the inbox (which is always used). */
  channels?: readonly NotificationChannel[];
}

export interface Delivery {
  channel: NotificationChannel;
  status: "sent" | "failed" | "unavailable";
  detail?: string;
}

export interface NotifyResult {
  record: NotificationRecord;
  /** One entry per channel, the inbox first. */
  deliveries: Delivery[];
}

/** Who is looking: a connection's principal in its current workspace. */
export interface Viewer {
  principal: Principal;
  workspaceId: string;
}

export interface NotificationSubscriber {
  send(message: ServerMessage): void;
  principal(): Principal;
  workspaceId(): string;
}

export interface NotificationServiceOptions {
  store: Store;
  ownerId: string;
  env: NodeJS.ProcessEnv;
  log: Log;
  /** The gateway's one mailer (also used for invitations); undefined: no email. */
  mailer?: Mailer;
  createId?(): string;
  now?(): number;
}

export class NotificationService {
  readonly notifiers = new NotifierRegistry();
  readonly mailer: Mailer | undefined;
  /** Deletes notices past the retention period; runs on the routine scheduler. */
  readonly retentionJob: ScheduledJobType;
  private nextPruneAt = 0;
  private readonly subscribers = new Set<NotificationSubscriber>();
  private readonly createId: () => string;
  private readonly now: () => number;

  constructor(private readonly options: NotificationServiceOptions) {
    this.mailer = options.mailer;
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? Date.now;
    this.notifiers.register({
      channel: "inbox",
      available: () => ({ ok: true }),
      send: async ({ record }) => {
        await this.options.store.notifications.insert(record);
        await this.push(record);
      }
    });
    const appUrl = options.env.SIBYL_APP_URL?.trim();
    this.notifiers.register(emailNotifier({ mailer: options.mailer, ...(appUrl ? { appUrl } : {}) }));
    this.notifiers.register(unavailableNotifier("slack", "Slack isn't connected yet. Connect it in Integrations to deliver here."));
    this.notifiers.register(unavailableNotifier("teams", "Microsoft Teams isn't connected yet. Connect Microsoft 365 in Integrations to deliver here."));
    this.retentionJob = this.createRetentionJob();
  }

  /* ───────────── retention ───────────── */

  /** Days notices are kept (SIBYL_NOTIFICATION_RETENTION_DAYS; 0 or less keeps them forever). */
  retentionDays(): number {
    const raw = this.options.env.SIBYL_NOTIFICATION_RETENTION_DAYS?.trim();
    if (!raw) return DEFAULT_RETENTION_DAYS;
    const days = Number(raw);
    return Number.isFinite(days) ? days : DEFAULT_RETENTION_DAYS;
  }

  /** Delete notices older than the retention period; returns how many went. */
  async prune(now = this.now()): Promise<number> {
    const days = this.retentionDays();
    if (days <= 0) return 0;
    const removed = await this.options.store.notifications.prune(this.options.ownerId, Math.floor(now - days * DAY_MS));
    if (removed > 0) this.options.log("notification.pruned", { removed, retentionDays: days });
    return removed;
  }

  /** One job, due every RETENTION_INTERVAL_MS (the first run soon after start). */
  private createRetentionJob(): ScheduledJobType {
    const job = { id: "notifications-retention" };
    return {
      kind: "notification_retention",
      maxConcurrency: 1,
      due: async (now) => (now >= this.nextPruneAt ? [job] : []),
      claim: async (_job, now) => {
        if (now < this.nextPruneAt) return undefined;
        this.nextPruneAt = now + RETENTION_INTERVAL_MS;
        return job;
      },
      renew: async () => undefined,
      run: async () => {
        await this.prune();
      },
      release: async () => undefined
    };
  }

  /* ───────────── publish ───────────── */

  /**
   * The one publish path: store + live push (inbox), then the other channels
   * asked for. Never throws for a channel that fails; the result says how
   * each one went.
   */
  async notify(input: NotificationInput, options: NotifyOptions = {}): Promise<NotifyResult> {
    const record: NotificationRecord = {
      id: this.createId(),
      ownerId: this.options.ownerId,
      workspaceId: input.workspaceId || DEFAULT_WORKSPACE_ID,
      ...(input.recipientUserId ? { recipientUserId: input.recipientUserId } : {}),
      kind: input.kind,
      title: clip(input.title, TITLE_MAX),
      body: clip(input.body ?? "", BODY_MAX),
      links: definedLinks(input.links ?? {}),
      createdAt: Math.floor(this.now())
    };
    const channels: NotificationChannel[] = ["inbox", ...new Set((options.channels ?? []).filter((channel) => channel !== "inbox"))];
    const recipient = channels.length > 1 ? await this.recipientOf(record.recipientUserId) : {};
    const deliveries: Delivery[] = [];
    for (const channel of channels) deliveries.push(await this.deliver(channel, record, recipient));
    this.options.log("notification.published", { id: record.id, kind: record.kind, deliveries: deliveries.map((d) => `${d.channel}:${d.status}`) });
    return { record, deliveries };
  }

  /** notify() for callers that don't wait (failures are logged). */
  publish(input: NotificationInput, options?: NotifyOptions): void {
    void this.notify(input, options).catch((error: unknown) => this.options.log("notification.publish_failed", { kind: input.kind, error: errorText(error) }));
  }

  private async deliver(channel: NotificationChannel, record: NotificationRecord, recipient: NotifyRecipient): Promise<Delivery> {
    const notifier = this.notifiers.get(channel);
    if (!notifier) return { channel, status: "unavailable", detail: `${channel} isn't available.` };
    try {
      const availability = await notifier.available({ ownerId: record.ownerId, workspaceId: record.workspaceId, recipient });
      if (!availability.ok) return { channel, status: "unavailable", detail: availability.reason };
      await notifier.send({ record, recipient });
      return { channel, status: "sent" };
    } catch (error) {
      this.options.log("notification.delivery_failed", { id: record.id, channel, error: errorText(error) });
      if (channel === "inbox") throw error;
      return { channel, status: "failed", detail: errorText(error).slice(0, 200) };
    }
  }

  /** Channels and whether they can reach this recipient (for pickers such as a monitor's actions). */
  channelOptions(context: { workspaceId: string; recipient: NotifyRecipient }): Promise<ChannelAvailability[]> {
    return this.notifiers.availability({ ownerId: this.options.ownerId, ...context });
  }

  /** Where a recipient's email goes: their account email; the org owner's from SIBYL_NOTIFY_EMAIL (or SIBYL_MONITOR_EMAIL). */
  async recipientOf(userId: string | undefined): Promise<NotifyRecipient> {
    if (!userId) return {};
    if (ORG_OWNER_IDS.has(userId)) {
      const email = this.ownerEmail();
      return email ? { email } : {};
    }
    const user = await this.options.store.identity.users.get(this.options.ownerId, userId).catch(() => undefined);
    return user ? { userId: user.id, email: user.email, name: user.name } : { userId };
  }

  /** The recipient a principal stands for (for channel pickers). */
  recipientFor(principal: Principal): NotifyRecipient {
    if (principal.kind === "user") return { ...(principal.userId ? { userId: principal.userId } : {}), ...(principal.email ? { email: principal.email } : {}) };
    const email = this.ownerEmail();
    return email ? { email } : {};
  }

  private ownerEmail(): string | undefined {
    return this.options.env.SIBYL_NOTIFY_EMAIL?.trim() || this.options.env.SIBYL_MONITOR_EMAIL?.trim() || undefined;
  }

  /* ───────────── read ───────────── */

  /** A page of the viewer's notifications (newest first) and their unread counts. */
  async list(viewer: Viewer, request: { cursor?: string; limit?: number; kinds?: readonly NotificationKind[] } = {}): Promise<Omit<NotificationsListMessage, "type">> {
    const base = viewerQuery(viewer);
    const kinds = request.kinds ? base.kinds!.filter((kind) => request.kinds!.includes(kind)) : base.kinds!;
    const limit = Math.min(Math.max(request.limit ?? DEFAULT_PAGE_SIZE, 1), 100);
    const before = request.cursor ? decodeCursor(request.cursor) : undefined;
    const records = await this.options.store.notifications.list(this.options.ownerId, { ...base, kinds, ...(before ? { before } : {}), limit: limit + 1 });
    const page = records.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toNotificationView),
      unread: await this.unread(viewer),
      ...(request.cursor ? { cursor: request.cursor } : {}),
      ...(request.kinds ? { kinds: [...request.kinds] } : {}),
      ...(records.length > limit && last ? { nextCursor: encodeCursor(last) } : {})
    };
  }

  async unread(viewer: Viewer): Promise<NotificationUnreadView> {
    const byKind = await this.options.store.notifications.countUnread(this.options.ownerId, viewerQuery(viewer));
    return { total: Object.values(byKind).reduce((sum, n) => sum + (n ?? 0), 0), byKind };
  }

  /**
   * Mark one notification (that the viewer can see) or all of theirs read.
   * Every connected member who can see a changed notification gets
   * notifications.state. Returns false when the notification isn't theirs.
   */
  async markRead(viewer: Viewer, target: { id: string } | { all: true }): Promise<boolean> {
    const base = viewerQuery(viewer);
    if ("id" in target) {
      const record = await this.options.store.notifications.get(this.options.ownerId, target.id);
      if (!record || !matchesNotificationQuery(record, base)) return false;
    }
    const readAt = Math.floor(this.now());
    const ids = await this.options.store.notifications.markRead(this.options.ownerId, "id" in target ? { ...base, ids: [target.id] } : base, readAt);
    // Read for this person: only their own connections change (others keep their unread state).
    await this.pushRead(ids, readAt, { reader: viewer, all: "all" in target });
    return true;
  }

  /** An approval was decided (or expired): its approval_needed notification is read for everyone. */
  async resolveApproval(approvalId: string): Promise<void> {
    const readAt = Math.floor(this.now());
    const ids = await this.options.store.notifications.markRead(this.options.ownerId, { approvalId }, readAt);
    await this.pushRead(ids, readAt);
  }

  /* ───────────── live ───────────── */

  /** A connection's live feed; principal and workspace are read on every push, so changes apply at once. */
  subscribe(subscriber: NotificationSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  /** Stop pushing (shutdown). */
  close(): void {
    this.subscribers.clear();
  }

  private async push(record: NotificationRecord): Promise<void> {
    const notification = toNotificationView(record);
    await this.eachViewer(async (viewer, send) => {
      if (!canSee(viewer, record)) return;
      send({ type: NOTIFICATION_EVENTS.NOTIFICATION, notification, unread: await this.unread(viewer) });
    });
  }

  /** Tell connections about read changes: everyone who can see them, or (`only.reader`) that person's connections. */
  private async pushRead(ids: string[], readAt: number, only?: { reader: Viewer; all: boolean }): Promise<void> {
    const allFor = only?.all ? only.reader : undefined;
    if (ids.length === 0 && !allFor) return;
    const records: NotificationRecord[] = [];
    for (let i = 0; i < ids.length; i += READ_CHUNK) {
      const chunk = ids.slice(i, i + READ_CHUNK);
      records.push(...(await this.options.store.notifications.list(this.options.ownerId, { ids: chunk, limit: chunk.length })));
    }
    await this.eachViewer(async (viewer, send) => {
      if (only && readerOf(viewer) !== readerOf(only.reader)) return;
      const all = Boolean(allFor && sameViewer(viewer, allFor));
      const visible = records.filter((record) => canSee(viewer, record)).map((record) => record.id);
      if (!all && visible.length === 0) return;
      const message: NotificationsStateMessage = { type: NOTIFICATION_EVENTS.STATE, ids: visible, all, readAt, unread: await this.unread(viewer) };
      send(message);
    });
  }

  private async eachViewer(fn: (viewer: Viewer, send: (message: ServerMessage) => void) => Promise<void>): Promise<void> {
    await Promise.all(
      [...this.subscribers].map(async (subscriber) => {
        try {
          await fn({ principal: subscriber.principal(), workspaceId: subscriber.workspaceId() }, (message) => subscriber.send(message));
        } catch {
          // A closing socket; it unsubscribes on close.
        }
      })
    );
  }
}

/* ───────────── visibility ───────────── */

/** Kinds whose source the viewer may see in their workspace. */
export function visibleKinds(viewer: Viewer): NotificationKind[] {
  return NOTIFICATION_KINDS.filter((kind) => authorize(viewer.principal, NOTIFICATION_SOURCE_PERMISSION[kind], { workspaceId: viewer.workspaceId }));
}

/** Whose read state a viewer sees: their user id, or "owner" for the owner token and local mode. */
export function readerOf(viewer: Viewer): string {
  return viewer.principal.kind === "user" ? viewer.principal.userId ?? "" : "owner";
}

/** The store query for "what this viewer may see" (with their own read state). */
export function viewerQuery(viewer: Viewer): NotificationQuery {
  return {
    workspaceId: viewer.workspaceId,
    kinds: visibleKinds(viewer),
    // People see notifications for everyone plus their own; the org owner (token/local) sees all.
    ...(viewer.principal.kind === "user" ? { recipient: viewer.principal.userId ?? "" } : {}),
    reader: readerOf(viewer)
  };
}

export function canSee(viewer: Viewer, record: NotificationRecord): boolean {
  return matchesNotificationQuery(record, viewerQuery(viewer));
}

function sameViewer(a: Viewer, b: Viewer): boolean {
  return a.workspaceId === b.workspaceId && a.principal.kind === b.principal.kind && a.principal.userId === b.principal.userId;
}

/* ───────────── views ───────────── */

export function toNotificationView(record: NotificationRecord): NotificationView {
  return {
    id: record.id,
    kind: record.kind,
    title: record.title,
    body: record.body,
    links: { ...record.links },
    createdAt: record.createdAt,
    ...(record.readAt !== undefined ? { readAt: record.readAt } : {})
  };
}

export function encodeCursor(record: Pick<NotificationRecord, "createdAt" | "id">): string {
  return `${Math.floor(record.createdAt)}:${record.id}`;
}

export function decodeCursor(cursor: string): NotificationCursor | undefined {
  const at = cursor.indexOf(":");
  if (at <= 0) return undefined;
  const createdAt = Number(cursor.slice(0, at));
  const id = cursor.slice(at + 1);
  return Number.isFinite(createdAt) && id ? { createdAt, id } : undefined;
}

function definedLinks(links: NotificationLinks): NotificationLinks {
  const out: NotificationLinks = {};
  for (const [key, value] of Object.entries(links) as Array<[keyof NotificationLinks, string | undefined]>) {
    if (typeof value === "string" && value) out[key] = value;
  }
  return out;
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}
