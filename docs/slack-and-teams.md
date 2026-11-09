# Agents in Slack and Microsoft Teams

Your agents can work where your team talks. Put an agent in a Slack or Teams
channel and it answers when someone @mentions it, then keeps answering in that
thread. Monitors and agents can also send their notices to Slack and Teams.

This is part of open-source Sibyl. It uses the same connectors, permissions,
approvals and budgets as everything else.

- [How it works](#how-it-works)
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
      - im:write
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
| `reactions:write` | the 👀 reaction while an agent works, and the reaction action |
| `users:read`, `users:read.email` | names of the people in a thread; finding people by e-mail for notifications |
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
- The app's own messages, edits, joins and direct messages are ignored.

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
| `Chat.ReadWrite` | optional: chat actions ("Teams: chats") | no |

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

## Notifications

Monitors can notify in **Slack** and **Teams** next to the inbox and e-mail
(Monitors → an action → Notify). Agents set to *Act, then tell me* can send
their notices there too (Agents → an agent → Slack and Teams → "also tell me
in").

- **Slack:** a direct message from the app to the person, found by their
  account e-mail (group "Notifications by direct message"). If no Slack user
  has that e-mail, the workspace's notifications channel is used.
- **Teams:** a post in the workspace's notifications channel. Everyone in it
  sees the notice, so pick a channel for the right people.

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
  and logged). At most four channel turns run at once.

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
| `GET /api/presence/channels?provider=slack\|teams[&teamId=]` | `integrations.use` |
| `GET /api/presence/settings` | `integrations.use` |
| `PUT /api/presence/settings` `{slack?, teams?}` | `integrations.connect_shared` |
| `POST /api/presence/slack/events` | Slack signature |
| `POST /api/presence/teams/notifications`, `/teams/lifecycle` | Graph `validationToken` / clientState |
