import { DEFAULT_WORKSPACE_ID, createMemoryStore, ownerPrincipal, type Principal, type Role, type Store } from "@open-gpt-live/core";
import { NOTIFICATION_EVENTS, parseClientMessage, parseServerMessage, type ServerMessage } from "@open-gpt-live/protocol";
import { describe, expect, test } from "vitest";
import { inviteMailer } from "../identity/mail.js";
import { IdentityService } from "../identity/service.js";
import { installNotifications, inviteAcceptedNotice, notificationPath, type MailMessage } from "./index.js";
import { handleNotificationsMessage } from "./ws.js";

const OWNER = "owner";

function setup(env: NodeJS.ProcessEnv = {}) {
  let now = 1_000;
  let id = 0;
  const store = createMemoryStore();
  const mail: MailMessage[] = [];
  const notifications = installNotifications({
    store,
    ownerId: OWNER,
    env,
    log: () => undefined,
    createId: () => `n${++id}`,
    now: () => now,
    // The shared mailer's SMTP transport, faked.
    ...(env.SIBYL_SMTP_URL ? { transport: async () => ({ sendMail: async (message: MailMessage & { from: string }) => void mail.push(message) }) } : {})
  });
  return { store, notifications, mail, tick: (ms = 1) => void (now += ms) };
}

const person = (userId: string, roles: Record<string, Role>): Principal => ({ kind: "user", orgId: OWNER, userId, email: `${userId}@x.test`, workspaceRoles: roles });
const owner = ownerPrincipal(OWNER, "local");

/** A connected tab: its messages, as the gateway would send them. */
function connect(notifications: ReturnType<typeof setup>["notifications"], principal: Principal, workspaceId = DEFAULT_WORKSPACE_ID) {
  const messages: ServerMessage[] = [];
  notifications.subscribe({ send: (m) => void messages.push(m), principal: () => principal, workspaceId: () => workspaceId });
  const live = () => messages.filter((m): m is Extract<ServerMessage, { type: "notification" }> => m.type === NOTIFICATION_EVENTS.NOTIFICATION).map((m) => m.notification.kind);
  const states = () => messages.filter((m): m is Extract<ServerMessage, { type: "notifications.state" }> => m.type === NOTIFICATION_EVENTS.STATE);
  return { messages, live, states };
}

async function addUser(store: Store, id: string) {
  await store.identity.users.upsert({ id, orgId: OWNER, email: `${id}@x.test`, name: id, passwordHash: "x", createdAt: 1 } as never);
}

describe("publishing", () => {
  test("stores one record and pushes it only to members allowed to see it", async () => {
    const { store, notifications } = setup();
    const tabs = {
      owner: connect(notifications, owner),
      alice: connect(notifications, person("alice", { default: "member" })),
      vera: connect(notifications, person("vera", { default: "viewer" })),
      bob: connect(notifications, person("bob", { default: "member" })),
      adam: connect(notifications, person("adam", { default: "admin" })),
      dana: connect(notifications, person("dana", { default: "member", ws2: "member" }), "ws2")
    };
    await notifications.notify({ kind: "routine_finished", title: "Daily news", body: "“Daily news” finished.", links: { routineId: "r1" } });
    await notifications.notify({ kind: "monitor_fired", recipientUserId: "alice", title: "1 new match", links: { monitorId: "m1" } });
    await notifications.notify({ kind: "invite_accepted", title: "Max joined" });
    await notifications.notify({ kind: "agent_action", recipientUserId: "bob", title: "Dot sent an email", links: { agentId: "a1" } });
    await notifications.notify({ kind: "deck_ready", workspaceId: "ws2", title: "Deck ready", links: { artifactId: "d1" } });

    expect(await store.notifications.list(OWNER)).toHaveLength(5);
    expect(tabs.owner.live()).toEqual(["routine_finished", "monitor_fired", "invite_accepted", "agent_action"]);
    expect(tabs.alice.live()).toEqual(["routine_finished", "monitor_fired"]);
    expect(tabs.vera.live()).toEqual(["routine_finished"]); // viewers see routine notices, not others' monitors
    expect(tabs.bob.live()).toEqual(["routine_finished", "agent_action"]);
    expect(tabs.adam.live()).toEqual(["routine_finished", "invite_accepted"]); // members.invite: admins
    expect(tabs.dana.live()).toEqual(["deck_ready"]); // only their current workspace
    const last = tabs.alice.messages.at(-1) as Extract<ServerMessage, { type: "notification" }>;
    expect(last.unread).toEqual({ total: 2, byKind: { routine_finished: 1, monitor_fired: 1 } });
    expect(parseServerMessage(last).success).toBe(true);
  });

  test("an accepted invitation tells the inviter", async () => {
    const { store, notifications } = setup();
    const identity = new IdentityService({ store, orgId: OWNER, onInviteAccepted: (event) => notifications.publish(inviteAcceptedNotice(event)) });
    const setupOwner = await identity.setup({ email: "olive@x.test", name: "Olive", password: "correct horse battery" }, { ownerTokenOk: false });
    const auth = (await identity.resolveSession(setupOwner.token))!;
    const { url } = await identity.createInvite(auth.principal, { workspaceId: DEFAULT_WORKSPACE_ID, role: "admin" }, "http://app");
    await identity.acceptInvite(url.split("/invite/")[1]!, { name: "Max", email: "max@x.test", password: "correct horse battery" }, undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const [stored] = await store.notifications.list(OWNER);
    expect(stored).toMatchObject({ kind: "invite_accepted", recipientUserId: setupOwner.user.id, title: expect.stringMatching(/^Max joined /), body: expect.stringContaining("as an admin") });
  });

  test("email goes through the one mailer (shared with invitations); other channels report why not", async () => {
    const { store, notifications, mail } = setup({ SIBYL_SMTP_URL: "smtp://x", SIBYL_APP_URL: "https://sibyl.test/" });
    await addUser(store, "alice");
    const result = await notifications.notify(
      { kind: "monitor_fired", recipientUserId: "alice", title: "1 new match for “Deals”: Acme.", body: "- Acme\n  https://crm.test/d1", links: { monitorId: "m1" } },
      { channels: ["email", "slack"] }
    );
    expect(result.deliveries).toEqual([
      { channel: "inbox", status: "sent" },
      { channel: "email", status: "sent" },
      { channel: "slack", status: "unavailable", detail: expect.stringMatching(/Slack/) }
    ]);
    expect(mail).toEqual([
      expect.objectContaining({ to: "alice@x.test", subject: "Sibyl: 1 new match for “Deals”: Acme.", text: expect.stringContaining("https://crm.test/d1") })
    ]);
    expect(mail[0]!.text).toContain("Open in Sibyl: https://sibyl.test/monitors");

    await inviteMailer(notifications.mailer)!.sendInvite({ to: "z@x.test", inviterName: "Olive", workspaceName: "Sales", role: "admin", url: "https://sibyl.test/invite/t", expiresAt: Date.now() + 86_400_000 });
    expect(mail[1]).toMatchObject({ to: "z@x.test", subject: "Olive invited you to Sales on Sibyl", text: expect.stringContaining("as an admin") });

    // Everyone-notices have no single address; without SMTP email is unavailable.
    expect((await notifications.notify({ kind: "routine_finished", title: "x" }, { channels: ["email"] })).deliveries[1]).toMatchObject({ status: "unavailable" });
    const bare = setup();
    expect(bare.notifications.mailer).toBeUndefined();
    expect(inviteMailer(bare.notifications.mailer)).toBeUndefined();
    expect((await bare.notifications.notify({ kind: "monitor_fired", recipientUserId: "owner", title: "x" }, { channels: ["email"] })).deliveries[1]).toMatchObject({
      status: "unavailable",
      detail: expect.stringContaining("SIBYL_SMTP_URL")
    });
  });
});

describe("reading", () => {
  test("pages newest first with a cursor and a kind filter, scoped to the viewer", async () => {
    const { notifications } = setup();
    for (const n of [1, 2, 3, 4]) await notifications.notify({ kind: n % 2 ? "routine_finished" : "routine_failed", title: `r${n}` }); // same millisecond
    await notifications.notify({ kind: "agent_action", recipientUserId: "bob", title: "bob's" });
    const alice = { principal: person("alice", { default: "member" }), workspaceId: DEFAULT_WORKSPACE_ID };
    const first = await notifications.list(alice, { limit: 3 });
    expect(first.items.map((n) => n.title)).toEqual(["r4", "r3", "r2"]);
    expect(first.unread).toEqual({ total: 4, byKind: { routine_finished: 2, routine_failed: 2 } });
    const second = await notifications.list(alice, { limit: 3, cursor: first.nextCursor! });
    expect(second.items.map((n) => n.title)).toEqual(["r1"]);
    expect(second.nextCursor).toBeUndefined();
    expect((await notifications.list(alice, { kinds: ["routine_failed"] })).items.map((n) => n.title)).toEqual(["r4", "r2"]);
    expect((await notifications.list({ principal: owner, workspaceId: DEFAULT_WORKSPACE_ID })).items).toHaveLength(5);
  });

  test("marks one or all read, per person for workspace-wide notices; others' can't be marked; only the reader's tabs are told", async () => {
    const { store, notifications, tick } = setup();
    const shared = (await notifications.notify({ kind: "routine_finished", title: "shared" })).record;
    const mine = (await notifications.notify({ kind: "monitor_fired", recipientUserId: "alice", title: "mine" })).record;
    const bobs = (await notifications.notify({ kind: "agent_action", recipientUserId: "bob", title: "bob's" })).record;
    const alicePrincipal = person("alice", { default: "member" });
    const bobPrincipal = person("bob", { default: "member" });
    const alice = { principal: alicePrincipal, workspaceId: DEFAULT_WORKSPACE_ID };
    const bob = { principal: bobPrincipal, workspaceId: DEFAULT_WORKSPACE_ID };
    const aliceTab = connect(notifications, alicePrincipal);
    const aliceOtherTab = connect(notifications, alicePrincipal);
    const bobTab = connect(notifications, bobPrincipal);
    tick();

    expect(await notifications.markRead(alice, { id: bobs.id })).toBe(false);
    expect((await store.notifications.get(OWNER, bobs.id))?.readAt).toBeUndefined();

    // Alice reading the workspace-wide notice reads it for her (both her tabs), not for Bob.
    expect(await notifications.markRead(alice, { id: shared.id })).toBe(true);
    expect(aliceTab.states().at(-1)).toMatchObject({ ids: [shared.id], all: false, unread: { total: 1 } });
    expect(aliceOtherTab.states().at(-1)).toMatchObject({ ids: [shared.id], unread: { total: 1 } });
    expect(bobTab.states()).toHaveLength(0);
    expect((await notifications.unread(bob)).total).toBe(2);
    expect((await notifications.list(alice)).items.find((n) => n.id === shared.id)?.readAt).toBe(1_001);
    expect((await notifications.list(bob)).items.find((n) => n.id === shared.id)?.readAt).toBeUndefined();
    expect((await notifications.list({ principal: owner, workspaceId: DEFAULT_WORKSPACE_ID })).unread.total).toBe(3);

    expect(await notifications.markRead(alice, { all: true })).toBe(true);
    expect(aliceTab.states().at(-1)).toMatchObject({ ids: [mine.id], all: true, unread: { total: 0, byKind: {} } });
    expect(bobTab.states()).toHaveLength(0); // nothing of Bob's changed
    expect((await store.notifications.get(OWNER, bobs.id))?.readAt).toBeUndefined();
    expect((await store.notifications.get(OWNER, mine.id))?.readAt).toBe(1_001);

    expect(await notifications.markRead(bob, { all: true })).toBe(true);
    expect(bobTab.states().at(-1)).toMatchObject({ all: true, unread: { total: 0 } });
    expect([...bobTab.states().at(-1)!.ids].sort()).toEqual([shared.id, bobs.id].sort());
  });

  test("retention deletes notices past SIBYL_NOTIFICATION_RETENTION_DAYS through the scheduler job", async () => {
    const day = 24 * 60 * 60 * 1000;
    const { store, notifications, tick } = setup({ SIBYL_NOTIFICATION_RETENTION_DAYS: "30" });
    await notifications.notify({ kind: "routine_finished", title: "old" });
    tick(20 * day);
    await notifications.notify({ kind: "routine_finished", title: "newer" });
    tick(11 * day); // "old" is now 31 days old
    const job = notifications.retentionJob;
    const [due] = await job.due(31 * day + 1_000);
    expect(due).toBeDefined();
    const claimed = await job.claim(due!, 31 * day + 1_000, 0);
    expect(claimed).toBeDefined();
    await job.run(claimed!, new AbortController().signal);
    expect((await store.notifications.list(OWNER)).map((n) => n.title)).toEqual(["newer"]);
    // Not due again until the interval passed; 0 keeps everything.
    expect(await job.due(31 * day + 2_000)).toEqual([]);
    expect(setup().notifications.retentionDays()).toBe(90);
    const keep = setup({ SIBYL_NOTIFICATION_RETENTION_DAYS: "0" });
    await keep.notifications.notify({ kind: "routine_finished", title: "kept" });
    keep.tick(1_000 * day);
    expect(await keep.notifications.prune()).toBe(0);
  });

  test("deciding an approval reads its approval_needed notification", async () => {
    const { store, notifications } = setup();
    const tab = connect(notifications, owner);
    const { record } = await notifications.notify({ kind: "approval_needed", title: "“Notes” needs your approval", links: { routineId: "r1", approvalId: "ap1" } });
    await notifications.resolveApproval("ap1");
    expect((await store.notifications.get(OWNER, record.id))?.readAt).toBeDefined();
    expect(tab.states()).toEqual([expect.objectContaining({ ids: [record.id], unread: { total: 0, byKind: {} } })]);
    expect(notificationPath(record)).toBe("/inbox");
  });

  test("WebSocket messages: strict parsers and the handler", async () => {
    expect(parseClientMessage({ type: "notifications.request" }).success).toBe(true);
    expect(parseClientMessage({ type: "notifications.request", limit: 20, kinds: ["monitor_fired"], cursor: "1000:n1" }).success).toBe(true);
    expect(parseClientMessage({ type: "notifications.request", limit: 0 }).success).toBe(false);
    expect(parseClientMessage({ type: "notifications.request", kinds: ["party"] }).success).toBe(false);
    expect(parseClientMessage({ type: "notifications.request", cursor: "nope" }).success).toBe(false);
    expect(parseClientMessage({ type: "notifications.read", id: "n1" }).success).toBe(true);
    expect(parseClientMessage({ type: "notifications.read", all: true }).success).toBe(true);
    expect(parseClientMessage({ type: "notifications.read", all: true, id: "n1" }).success).toBe(false);
    expect(parseClientMessage({ type: "notifications.read" }).success).toBe(false);
    const view = { id: "n1", kind: "routine_failed", title: "t", body: "", links: { routineId: "r" }, createdAt: 1 };
    const unread = { total: 1, byKind: { routine_failed: 1 } };
    expect(parseServerMessage({ type: "notifications.list", items: [view], unread }).success).toBe(true);
    expect(parseServerMessage({ type: "notification", notification: { ...view, links: { evil: "x" } }, unread }).success).toBe(false);
    expect(parseServerMessage({ type: "notification", notification: view, unread: { total: 1, byKind: { party: 1 } } }).success).toBe(false);
    expect(parseServerMessage({ type: "notifications.state", ids: ["n1"], all: false, readAt: 2, unread }).success).toBe(true);

    const { notifications } = setup();
    await notifications.notify({ kind: "routine_failed", title: "Failed" });
    const sent: ServerMessage[] = [];
    const context = { notifications, send: (m: ServerMessage) => void sent.push(m), principal: () => owner, workspaceId: () => DEFAULT_WORKSPACE_ID };
    expect(await handleNotificationsMessage({ type: "notifications.request", limit: 10 }, context)).toBe(true);
    expect(sent[0]).toMatchObject({ type: "notifications.list", items: [{ kind: "routine_failed", title: "Failed" }], unread: { total: 1 } });
    expect(await handleNotificationsMessage({ type: "notifications.read", id: "missing" }, context)).toBe(true);
    expect(sent[1]).toMatchObject({ type: "error" });
    expect(await handleNotificationsMessage({ type: "usage.request" }, context)).toBe(false);
  });
});
