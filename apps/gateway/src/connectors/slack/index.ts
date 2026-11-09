/**
 * Slack (open source): channels, threads, posting, reactions and search
 * through the Slack Web API, installed with the organization's own Slack app
 * (OAuth v2). The bot token is what the connection stores (encrypted); the
 * optional search group adds a user token for the person who connected.
 *
 * Agents in channels (answering @mentions and threads) and notifications by
 * Slack use the same connection: see apps/gateway/src/presence and
 * docs/slack-and-teams.md.
 */
import type { ConnectorDefinition } from "../types.js";
import { slackCall, type SlackResponse } from "./api.js";
import { slackActions } from "./messages.js";

/** Where Slack sends events (signed with the app's signing secret). */
export const SLACK_EVENTS_PATH = "/api/presence/slack/events";
/** Vault name suffix of the signing secret (stored as SLACK_SIGNING_SECRET). */
export const SLACK_SIGNING_SECRET = "SIGNING_SECRET";

export const slackConnector: ConnectorDefinition = {
  id: "slack",
  name: "Slack",
  vendor: "Slack",
  description: "Read and post in channels and threads, react, search, and let agents answer @mentions in Slack.",
  edition: "oss",
  auth: {
    kind: "oauth2",
    authorizeUrl: "https://slack.com/oauth/v2/authorize",
    tokenUrl: "https://slack.com/api/oauth.v2.access",
    // The bot scopes come from the groups; Slack needs no identity scopes for a bot install.
    baseScopes: [],
    // Slack's v2 flow uses the client secret (confidential client), no PKCE.
    pkce: false,
    scopeSeparator: ",",
    userScopeParam: "user_scope",
    userGrant(token) {
      const user = token.authed_user as { access_token?: unknown; scope?: unknown } | undefined;
      if (!user || typeof user.access_token !== "string") return undefined;
      return { accessToken: user.access_token, scopes: typeof user.scope === "string" ? user.scope.split(",").map((s) => s.trim()).filter(Boolean) : [] };
    },
    async revoke({ accessToken, revokeUrl, fetch }) {
      // auth.revoke takes the token itself as the credential.
      const response = await fetch(revokeUrl ?? "https://slack.com/api/auth.revoke", { method: "POST", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/x-www-form-urlencoded" }, body: "" });
      await response.body?.cancel().catch(() => undefined);
    }
  },
  appSecrets: [
    {
      name: SLACK_SIGNING_SECRET,
      label: "Signing secret",
      help: "Basic Information → App Credentials → Signing Secret. Sibyl checks every event Slack sends with it."
    }
  ],
  appEndpoints: [{ label: "Events Request URL", path: SLACK_EVENTS_PATH, help: "Event Subscriptions → Request URL (needs a public HTTPS address)." }],
  apiBases: { slack: "https://slack.com/api" },
  apiHosts: ["slack.com"],
  groups: [
    {
      id: "read",
      title: "Channels: list and read",
      description: "List channels and read messages and threads in channels the app was added to.",
      scopes: ["channels:read", "groups:read", "channels:history", "groups:history", "users:read"],
      defaultEnabled: true
    },
    { id: "write", title: "Post and reply", description: "Post messages and thread replies as the Sibyl app.", scopes: ["chat:write"], defaultEnabled: true },
    { id: "reactions", title: "Reactions", description: "Add emoji reactions.", scopes: ["reactions:write"], defaultEnabled: true },
    {
      id: "agents",
      title: "Agents in channels",
      description: "Agents answer when @mentioned and follow up in their threads, under their own name.",
      scopes: ["app_mentions:read", "chat:write", "chat:write.customize", "channels:history", "groups:history"],
      defaultEnabled: true
    },
    {
      id: "notify",
      title: "Notifications by direct message",
      description: "Send monitor and agent notices to people as direct messages (matched by e-mail).",
      scopes: ["users:read", "users:read.email", "im:write", "chat:write"],
      defaultEnabled: true
    },
    {
      id: "search",
      title: "Search messages (as you)",
      description: "Search all messages the connecting person can see. Uses that person's own Slack permission.",
      scopes: [],
      userScopes: ["search:read"],
      defaultEnabled: false
    }
  ],
  actions: slackActions,
  setup: {
    consoleName: "Slack API: Your Apps",
    consoleUrl: "https://api.slack.com/apps",
    docsAnchor: "slack",
    steps: [
      "Open Your Apps → Create New App → From a manifest, pick your Slack workspace and paste the manifest from docs/slack-and-teams.md (it lists every scope and event).",
      "In the manifest, replace the two example URLs with the Redirect URI and the Events Request URL shown below (both must be public HTTPS addresses).",
      "Basic Information → App Credentials: copy the Client ID, Client Secret and Signing Secret and paste them here.",
      "Save, then press “Continue to Slack” above and install the app. Connect it for the whole workspace so agents can join channels.",
      "In Slack, invite the app to each channel an agent should answer in (/invite @Sibyl)."
    ]
  },
  async identify(ctx) {
    const me = await slackCall<SlackResponse & { team?: string; url?: string; user?: string }>(ctx, "auth.test");
    const host = typeof me.url === "string" ? me.url.replace(/^https?:\/\//, "").replace(/\/$/, "") : undefined;
    return { ...(me.team ? { account: host ? `${me.team} (${host})` : me.team } : {}), ...(me.user ? { accountName: me.user } : {}) };
  },
  tokenMetadata(token) {
    const team = token.team as { id?: unknown; name?: unknown } | undefined;
    const enterprise = token.enterprise as { id?: unknown } | undefined;
    const out: Record<string, string> = {};
    if (typeof team?.id === "string") out.teamId = team.id;
    if (typeof team?.name === "string") out.teamName = team.name.slice(0, 120);
    if (typeof token.bot_user_id === "string") out.botUserId = token.bot_user_id;
    if (typeof token.app_id === "string") out.appId = token.app_id;
    if (typeof enterprise?.id === "string") out.enterpriseId = enterprise.id;
    return out;
  }
};

export { slackCall, slackError, slackUserNames, requireChannelId, requireTs, type SlackMessage, type SlackResponse } from "./api.js";
