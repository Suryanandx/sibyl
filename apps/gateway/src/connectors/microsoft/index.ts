/**
 * Microsoft 365 (open source): Outlook mail and calendar, OneDrive and
 * SharePoint files, Excel and Teams through Microsoft Graph, signed in with
 * the organization's own Entra ID app registration (multi-tenant by default).
 */
import type { ConnectorDefinition } from "../types.js";
import { filesActions, teamsActions } from "./files-teams.js";
import { outlookActions } from "./mail-calendar.js";

const S = "https://graph.microsoft.com/";

export const microsoftConnector: ConnectorDefinition = {
  id: "microsoft",
  name: "Microsoft 365",
  vendor: "Microsoft",
  description: "Outlook mail and calendar, OneDrive and SharePoint files, Excel and Teams.",
  edition: "oss",
  appSettings: [
    {
      name: "tenant",
      label: "Tenant",
      help: '"common" lets work and personal accounts from any organization sign in; "organizations" any work account; or your tenant ID / domain to allow only your organization.',
      default: "common",
      pattern: /^(common|organizations|consumers|[0-9a-fA-F-]{36}|[A-Za-z0-9.-]{3,253})$/
    }
  ],
  auth: {
    kind: "oauth2",
    authorizeUrl: "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token",
    // Microsoft identity platform has no token revocation endpoint for one grant;
    // removing a connection deletes its tokens (people can also remove the app at myapps.microsoft.com).
    baseScopes: ["openid", "profile", "email", "offline_access", `${S}User.Read`],
    pkce: true,
    authorizeParams: { response_mode: "query", prompt: "select_account" }
  },
  apiBases: { graph: "https://graph.microsoft.com" },
  apiHosts: ["graph.microsoft.com"],
  groups: [
    { id: "mail_read", title: "Outlook: search and read", description: "Search mail and read messages.", scopes: [`${S}Mail.Read`], defaultEnabled: true },
    { id: "mail_draft", title: "Outlook: drafts", description: "Write drafts and reply drafts (nothing is sent).", scopes: [`${S}Mail.ReadWrite`], defaultEnabled: true },
    { id: "mail_send", title: "Outlook: send", description: "Send e-mail as the connected account (always asks first).", scopes: [`${S}Mail.Send`], defaultEnabled: false },
    { id: "calendar_read", title: "Calendar: read", description: "List events and find free time.", scopes: [`${S}Calendars.Read`], defaultEnabled: true },
    { id: "calendar_write", title: "Calendar: create and update", description: "Create and change events.", scopes: [`${S}Calendars.ReadWrite`], defaultEnabled: true },
    { id: "files_read", title: "OneDrive & SharePoint: search and read", description: "Find files, read their text and Excel ranges.", scopes: [`${S}Files.Read.All`, `${S}Sites.Read.All`], defaultEnabled: true },
    { id: "excel_write", title: "Excel: update", description: "Change cells in workbooks.", scopes: [`${S}Files.ReadWrite`], defaultEnabled: false },
    { id: "teams_read", title: "Teams: list teams and channels", description: "See the teams and channels you belong to.", scopes: [`${S}Team.ReadBasic.All`, `${S}Channel.ReadBasic.All`], defaultEnabled: true },
    { id: "teams_post", title: "Teams: post messages", description: "Post to a channel (always asks first) and reply in threads as the connected account.", scopes: [`${S}ChannelMessage.Send`], defaultEnabled: false },
    {
      id: "teams_messages_read",
      title: "Teams: read channel messages",
      description: "Read channel messages and threads; lets agents answer @mentions in Teams channels (needs admin consent).",
      scopes: [`${S}ChannelMessage.Read.All`],
      defaultEnabled: false
    },
    { id: "teams_chat", title: "Teams: chats", description: "List chats and send chat messages as the connected account (always asks first).", scopes: [`${S}Chat.ReadWrite`], defaultEnabled: false }
  ],
  actions: [...outlookActions, ...filesActions, ...teamsActions],
  setup: {
    consoleName: "Microsoft Entra admin center",
    consoleUrl: "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
    docsAnchor: "microsoft-365",
    steps: [
      "In the Microsoft Entra admin center, open App registrations → New registration.",
      'Name it "Sibyl". Supported account types: "Accounts in any organizational directory (multitenant)" — or single tenant if only your organization will connect.',
      "Redirect URI: platform Web, with the redirect URI shown below. Register.",
      "Certificates & secrets → New client secret; copy its Value (shown once).",
      "API permissions → Add → Microsoft Graph → Delegated: the permissions of the action groups you will use (listed per group). Grant admin consent if your tenant requires it.",
      "Paste the Application (client) ID and the secret value here. They are stored encrypted in Sibyl's secrets vault."
    ]
  },
  async identify(ctx) {
    const me = await ctx.http.get<{ mail?: string | null; userPrincipalName?: string; displayName?: string }>(`${ctx.base("graph")}/v1.0/me`, { $select: "mail,userPrincipalName,displayName" });
    const account = me.mail ?? me.userPrincipalName;
    return { ...(account ? { account } : {}), ...(me.displayName ? { accountName: me.displayName } : {}) };
  }
};
