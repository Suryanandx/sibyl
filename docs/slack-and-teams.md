# Agents in Slack and Microsoft Teams

Your agents can work where your team talks. Put an agent in a Slack or Teams
channel and it answers when someone @mentions it, then keeps answering in that
thread. People can also message an agent directly: a Slack DM with the app, or a
Teams chat with the workspace's account. Monitors and agents can send their
notices to Slack and Teams, to the person directly.

This is part of open-source Sibyl. It uses the same connectors, permissions,
approvals and budgets as everything else.

- [How it works](#how-it-works)
- [Direct messages](#direct-messages)
- [Slack](#slack)
- [Microsoft Teams](#microsoft-teams)
- [Notifications](#notifications)
- [Security](#security)
- [Checking it end to end](#checking-it-end-to-end)
- [Configuration](#configuration)

## How it works

1. An admin connects **Slack** or **Microsoft 365** for the whole workspace
   (Integrations). Personal connections can't host agents: everyone in a
   channel talks to the agent, so it must not act with one person's accounts.
2. Someone who can edit the agent opens **Agents → the agent → Slack and
   Teams → Add to a channel** and picks the channel and how it answers:
   - **When @mentioned, then in the thread** (default): it answers @mentions,
     then every reply in a thread it is part of.
   - **Every new message**: it also answers every new message in the channel
     (in a thread under that message).
3. When a message arrives, Sibyl answers the vendor at once and does the work
   afterwards:
   - the agent's turn runs exactly like a routine or a monitor task: its
     instructions, model, skills, knowledge and tools; its autonomy decides
     writes; its own budget and the organization's budget apply; it can learn
     from the run;
   - the thread so far is part of the context;
   - the reply goes into the thread. In Slack it uses the agent's name.

**Who the agent acts as.** The person who placed it in the channel, with their
current rights in the workspace. In a channel it only uses the workspace's
shared connections, never anyone's personal accounts. If that person loses
access, the agent stops answering there and the channel shows why.

**Writes.** With *Ask me first*, a write waits for approval in Sibyl's inbox
and the agent says so in the thread. *Act, then tell me* runs it and sends a
notice. High-risk actions (sending, posting to a channel, deleting) always ask.

**Several agents in one channel.** In Slack, every agent shares the app's
@mention. Start with the agent's name to pick one: `@Sibyl Research what's
new?`. Without a name, the channel's first agent answers.

**What you can see.** Each channel has its own conversation in Sibyl
("Research · Slack #support") with what was asked and answered.

## Direct messages

Agents → an agent → **Slack and Teams → Direct messages** → *Answer in Slack*
or *Answer in Microsoft Teams*.

- **Where people write.** Slack: a direct message to the Sibyl app (Apps →
  Sibyl → Messages), or a group DM that includes the app. Teams: a 1:1 chat
  with the workspace's Microsoft 365 account (for example *Sibyl*), or a group
  chat that includes it. Meeting chats are left out.
- **Which agent answers.** Several agents can take direct messages.
  - A message that starts with an agent's name goes to that agent
    ("Research, what's new?").
  - After that, the conversation stays with that agent (in a 1:1, until
    someone names another agent).
  - Otherwise the first agent set to **Every direct message** answers.
    Agents set to **Only when the message starts with its name** wait to be
    named.
  - In group DMs and group chats an agent answers only when the app or account
    is @mentioned, or when it is named. In a Slack group DM it then keeps
    answering in that thread.
- **Who may write** (per agent and provider):
  - **People in this workspace** (default): the writer's Slack or Microsoft
    365 e-mail must belong to an active Sibyl account that may use agents in
    the agent's workspace. Without accounts (single-owner mode) the owner's
    `SIBYL_NOTIFY_EMAIL` counts. Anyone else gets one short "Sorry, I only
    answer people of this Sibyl workspace" and no model is called.
  - **Anyone** in the Slack workspace or Microsoft 365 organization.
- **Everything else is as in a channel.** The turn acts as the person who
  switched direct messages on, with only the workspace's shared connections;
  its autonomy decides writes (approvals in the inbox); its budget and the
  organization's apply. The rate limit is per conversation: 20 messages per 10
  minutes per DM or chat, and at most 200 per agent and provider.
- **What you can see.** "Research · Slack direct messages" / "Research · Teams
  chats" in Sibyl, with what was asked and answered.

Slack needs the connection group **Agents in direct messages** (the scopes
`im:history`, `mpim:history`, `users:read.email`; on by default for new
connections), the `message.im` and `message.mpim` events, and the app's
Messages tab (all in the manifest below). Teams needs the group **Teams: agents
in chats** (`Chat.ReadWrite`, `User.ReadBasic.All`). An existing connection
gets them with **Reconnect** after switching the group on.

## Slack

### 1. Create the Slack app

Open [Your Apps](https://api.slack.com/apps) → **Create New App → From a
manifest**, pick your workspace and paste this manifest. Replace
`https://sibyl.example.com` with your gateway's public address (the same value
as `SIBYL_PUBLIC_GATEWAY_URL`; Integrations → Slack → Setup guide shows both
URLs ready to copy).

```yaml
display_information:
  name: Sibyl
  description: Your team's AI agents, from Sibyl.
  background_color: "#1d211f"
features:
  app_home:
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  bot_user:
    display_name: Sibyl
    always_online: true
oauth_config:
  redirect_urls:
    - https://sibyl.example.com/api/connectors/oauth/callback
  scopes:
    bot:
      - app_mentions:read
      - channels:history
      - channels:read
      - chat:write
      - chat:write.customize
      - groups:history
      - groups:read
      - im:history
      - im:write
      - mpim:history
      - reactions:write
      - users:read
      - users:read.email
    user:
      - search:read
settings:
  event_subscriptions:
    request_url: https://sibyl.example.com/api/presence/slack/events
    bot_events:
      - app_mention
      - message.channels
      - message.groups
      - message.im
      - message.mpim
  interactivity:
    is_enabled: false
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

What each scope is for:

| Scope | Used for |
|---|---|
| `app_mentions:read` | the `app_mention` event (someone @mentioned the app) |
| `channels:history`, `groups:history` | thread replies (`message.channels`, `message.groups`) and reading threads for context |
| `channels:read`, `groups:read` | listing channels to pick from |
| `chat:write` | replies and posts |
| `chat:write.customize` | replying under the agent's name |
| `im:history`, `mpim:history` | direct messages and group DMs with the app (`message.im`, `message.mpim`) and their history for context |
| `reactions:write` | the 👀 reaction while an agent works, and the reaction action |
| `users:read`, `users:read.email` | names of the people in a thread; finding people by e-mail for notifications; checking who writes a direct message |
| `im:write` | opening a direct message for notifications |
| `search:read` (user scope) | only for "Search messages (as you)", which is off by default |

Slack checks the Events Request URL when you save it, so the gateway must be
running and reachable at that address with the Slack app set up in Sibyl
(step 2). If you create the app first, come back to **Event Subscriptions**
afterwards and press **Retry**.

### 2. Set it up in Sibyl

1. Integrations → **Slack** → Setup guide.
2. Paste the **Client ID**, **Client Secret** and **Signing Secret** (Slack:
   Basic Information → App Credentials). Save. They are stored encrypted in
   the secrets vault and never shown again.
3. **Connect another account → Whole workspace → Continue to Slack** and
   install the app.
4. In Slack, invite the app to each channel: `/invite @Sibyl`.
5. Agents → an agent → **Slack and Teams → Add to a channel**.

### What Slack sends and how Sibyl checks it

- Every request carries `X-Slack-Signature` and `X-Slack-Request-Timestamp`.
  Sibyl computes `v0=` + HMAC-SHA256(signing secret, `v0:<timestamp>:<raw
  body>`) and compares in constant time, before reading the body. Requests
  older than five minutes are refused (no replays).
- Sibyl answers within milliseconds; the agent's work happens afterwards.
  Slack's retries of the same event are recognised and dropped.
- The app's own messages, edits and joins are ignored. Direct messages are
  answered only by agents that take direct messages.

## Microsoft Teams

Teams works through the **Microsoft 365** connector, with Microsoft Graph
change notifications.

### Why Graph and not the Bot Framework

| | Graph change notifications (what Sibyl uses) | Bot Framework |
|---|---|---|
| Setup | The Microsoft 365 app you already registered; add permissions | An Azure Bot resource, a Teams app package to upload, a second credential |
| Sign-in | The workspace's Microsoft 365 connection (tokens in the vault) | The bot's own app identity |
| Who posts | The connected account | A bot with its own name |
| Receiving | Subscriptions per channel, renewed about every 45 minutes | Teams pushes every activity to one endpoint |

Graph keeps Teams in the one connector framework and needs nothing new in
Azure. The trade-off is that replies come from the connected account. Use a
dedicated account for the workspace connection (for example *Sibyl* /
`sibyl@contoso.com`), add it to the teams where agents work, and ask by
@mentioning that account. Sibyl puts the agent's name at the top of each reply.

### Azure app permissions

In the Microsoft Entra admin center, on the app you registered for Microsoft
365 (see [integrations.md](integrations.md#microsoft-365)): **API permissions →
Add a permission → Microsoft Graph → Delegated permissions**:

| Permission | Needed for | Admin consent |
|---|---|---|
| `User.Read`, `openid`, `profile`, `email`, `offline_access` | signing in, staying connected | no |
| `Team.ReadBasic.All`, `Channel.ReadBasic.All` | listing teams and channels ("Teams: list teams and channels") | no |
| `ChannelMessage.Read.All` | reading channel messages and subscribing to them ("Teams: read channel messages") | **yes** |
| `ChannelMessage.Send` | replies and posts ("Teams: post messages") | no |
| `Chat.ReadWrite` | chats with agents and 1:1 notices ("Teams: agents in chats"); also the chat actions ("Teams: chats") | no |
| `User.ReadBasic.All` | finding people by e-mail: who writes in a chat, whom to send a notice ("Teams: agents in chats") | no |

Then **Grant admin consent** for your organization. Connect Microsoft 365 for
the whole workspace with these groups switched on: *Teams: list teams and
channels*, *Teams: read channel messages*, *Teams: post messages*.

### What Graph sends and how Sibyl checks it

- **The address.** Graph must reach the gateway over public HTTPS: set
  `SIBYL_PUBLIC_GATEWAY_URL`. Without it the channel shows "Needs attention".
- **Subscribing.** When an agent joins a channel, Sibyl creates a subscription
  for `/teams/{team}/channels/{channel}/messages` (new messages and replies),
  with notifications at `/api/presence/teams/notifications` and lifecycle
  events at `/api/presence/teams/lifecycle`. Graph first sends a
  `validationToken`, which Sibyl echoes as plain text.
- **clientState.** Every subscription gets a random secret. Graph sends it
  with each notification; Sibyl keeps only its SHA-256 and drops
  notifications that don't match.
- **Ids only.** Notifications carry no message content. Sibyl reads the
  message with the connection, skips the account's own posts, and treats an
  @mention of the account as a mention.
- **Renewal.** Channel message subscriptions last an hour. A job on the
  routine scheduler renews them about 20 minutes before they expire (and on
  `reauthorizationRequired`); a removed one is created again. Failures retry
  after 1, 2, 4… minutes (at most an hour) and show on the channel.
- Removing the agent from the channel deletes the subscription.

**Chats.** For direct messages Sibyl subscribes to
`/users/{account}/chats/getAllMessages`: every chat the connected account is
in. Graph allows this with delegated `Chat.Read` / `Chat.ReadWrite` for the
signed-in account itself. The tenant-wide `/chats/getAllMessages` would need
application permissions (`Chat.Read.All`) that the Microsoft 365 connection
doesn't use, and per-chat subscriptions would need a new subscription for
every new chat. Each agent that takes Teams chats keeps its own subscription
(renewed like the channel ones); when several do, Graph notifies once per
subscription and Sibyl answers once. Notifications carry only
`chats('…')/messages('…')`; Sibyl reads the message and the chat's type, skips
the account's own posts and meeting chats, and reads the writer's e-mail when
only workspace members may write.

## Notifications

Monitors can notify in **Slack** and **Teams** next to the inbox and e-mail
(Monitors → an action → Notify). Agents set to *Act, then tell me* can send
their notices there too (Agents → an agent → Slack and Teams → "also tell me
in").

- **Slack:** a direct message from the app to the person, found by their
  account e-mail (group "Notifications by direct message"). If no Slack user
  has that e-mail, the workspace's notifications channel is used.
- **Teams:** a 1:1 chat from the workspace's account to the person, found by
  their account e-mail (group "Teams: agents in chats"; Graph finds the
  existing chat or starts one). If that isn't possible, a post in the
  workspace's notifications channel. Everyone in the channel sees it, so pick a
  channel for the right people.

Workspace admins choose the notifications channel in Integrations → Slack (or
Microsoft 365) → Notifications and agents. Notices link back to Sibyl when
`SIBYL_APP_URL` is set.

## Security

- Slack events are accepted only with a valid signature from the last five
  minutes; Graph notifications only with the subscription's clientState.
- Signing secrets, tokens and clientState values are never logged and never
  sent to the browser. The signing secret is a vault secret allowed for local
  use only.
- Anyone in a channel can talk to the agent there. It never uses personal
  connections in channels, and the prompt tells it to treat thread messages as
  requests, not instructions that override its rules. Keep agents with
  sensitive access out of large channels.
- Replies are escaped, so a reply can't ping `@channel` or hide a link.
- Each channel answers at most 20 messages per 10 minutes (more are dropped
  and logged); each direct-message conversation too, and at most 200 per agent
  and provider. At most four turns run at once.
- Direct messages are answered only for workspace members by default
  (matched by e-mail; see [Direct messages](#direct-messages)).

## Checking it end to end

The automated tests sign Slack events with a test secret and post them to a
running gateway, with Slack's Web API and Microsoft Graph replaced by local
servers (`apps/gateway/src/presence/presence-gateway.test.ts`). To check with a
real Slack workspace and Teams tenant:

**Slack**

1. Run the gateway behind a public HTTPS address (for example
   `cloudflared tunnel --url http://localhost:8787` or `ngrok http 8787`) and
   set `SIBYL_PUBLIC_GATEWAY_URL` to it. Restart the gateway.
2. Create the Slack app from the manifest above with that address, and set it
   up in Sibyl (Client ID, Client Secret, Signing Secret).
3. In Slack → Event Subscriptions, the Request URL shows **Verified**.
4. Connect Slack for the whole workspace; invite the app to a test channel.
5. Create an agent, add it to that channel ("When @mentioned").
6. In the channel, write `@Sibyl what can you do?`. Expect 👀 on your message
   within a second, then the agent's reply in a thread under its own name.
7. Reply in that thread without a mention: the agent answers again.
8. Write a new message without a mention: no answer.
9. Ask for a write (for example "react with :tada: to my message") with the
   agent on *Ask me first*: the thread says it is waiting; approve in Sibyl's
   inbox; the reaction appears.
10. Create a monitor that notifies in Slack and run it: a direct message from
    the app arrives (your Sibyl account e-mail must match your Slack e-mail).
11. Agents → the agent → Direct messages → *Answer in Slack*. In Slack open
    Apps → Sibyl → Messages and write "what can you do?": the agent answers
    in the DM. Ask a colleague without a Sibyl account to write too: they get
    the short refusal.

**Teams**

1. Same public address. Add the permissions above to the Microsoft 365 app and
   grant admin consent.
2. Connect Microsoft 365 for the whole workspace with a dedicated account that
   is a member of a test team, with the three Teams groups on.
3. Add an agent to a channel of that team. Within a few seconds the channel
   shows **Active** (Graph validated the address and the subscription exists).
4. In Teams, @mention the connected account in that channel. The agent's reply
   appears in the thread, starting with its name.
5. Wait more than an hour: it still answers (the subscription was renewed).
6. Switch on "Teams: agents in chats" for the connection (Reconnect), then the
   agent's *Answer in Microsoft Teams*. Start a 1:1 chat with the connected
   account and write to it: the reply comes in that chat, starting with the
   agent's name.
7. Run a monitor that notifies in Teams: the notice arrives as a 1:1 chat
   from the connected account.

## Configuration

| Variable | Default | What it does |
|---|---|---|
| `SIBYL_PUBLIC_GATEWAY_URL` | unset | Public HTTPS base address of the gateway. Needed for the Slack redirect and events URLs and for Teams subscriptions. |
| `SIBYL_SLACK_CLIENT_ID`, `SIBYL_SLACK_CLIENT_SECRET`, `SIBYL_SLACK_SIGNING_SECRET` | unset | Slack app credentials from the environment instead of the vault (the vault, set in the UI, takes precedence). |
| `SIBYL_PRESENCE` | on | `false` turns agents in Slack and Teams, and the Slack/Teams notifiers, off. |
| `SIBYL_PRESENCE_MODEL` | the default chat model | Model for channel turns when the agent has no model preset of its own. |
| `SIBYL_APP_URL` | unset | The web app's address, for "Open in Sibyl" links in notices. |

### API

All routes act in the workspace from `x-sibyl-workspace`.

| Route | Permission |
|---|---|
| `GET /api/presence/agents/:agentId` | `agents.use` (and the agent visible to you) |
| `POST /api/presence/agents/:agentId/bindings` `{provider, channelId, channelName?, teamId?, teamName?, respond}` | `agents.use`; editing rights on the agent; `integrations.use` |
| `PATCH /api/presence/agents/:agentId/bindings/:id` `{respond}`, `DELETE …/bindings/:id` | as above |
| `PUT /api/presence/agents/:agentId/settings` `{notify}` | as above |
| `PUT /api/presence/agents/:agentId/direct/slack\|teams` `{respond: "all"\|"mentions", allow: "members"\|"anyone"}`, `DELETE …/direct/slack\|teams` | as above |
| `GET /api/presence/channels?provider=slack\|teams[&teamId=]` | `integrations.use` |
| `GET /api/presence/settings` | `integrations.use` |
| `PUT /api/presence/settings` `{slack?, teams?}` | `integrations.connect_shared` |
| `POST /api/presence/slack/events` | Slack signature |
| `POST /api/presence/teams/notifications`, `/teams/lifecycle` | Graph `validationToken` / clientState |
