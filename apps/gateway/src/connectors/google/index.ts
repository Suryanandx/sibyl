/**
 * Google Workspace (open source): Gmail, Calendar, Drive, Docs and Sheets
 * over Google's REST APIs, signed in with the organization's own OAuth
 * client (Google Cloud → APIs & Services → Credentials).
 */
import type { ConnectorDefinition } from "../types.js";
import { calendarActions } from "./calendar.js";
import { gmailActions } from "./gmail.js";
import { driveActions } from "./workspace-files.js";

const G = "https://www.googleapis.com/auth/";

export const googleConnector: ConnectorDefinition = {
  id: "google",
  name: "Google Workspace",
  vendor: "Google",
  description: "Gmail, Calendar, Drive, Docs and Sheets.",
  edition: "oss",
  auth: {
    kind: "oauth2",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    revokeUrl: "https://oauth2.googleapis.com/revoke",
    baseScopes: ["openid", "email", "profile"],
    pkce: true,
    // A refresh token on every consent; keep earlier grants when adding groups.
    authorizeParams: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" }
  },
  apiBases: {
    gmail: "https://gmail.googleapis.com",
    calendar: "https://www.googleapis.com",
    drive: "https://www.googleapis.com",
    docs: "https://docs.googleapis.com",
    sheets: "https://sheets.googleapis.com",
    userinfo: "https://openidconnect.googleapis.com"
  },
  apiHosts: ["gmail.googleapis.com", "www.googleapis.com", "docs.googleapis.com", "sheets.googleapis.com", "openidconnect.googleapis.com"],
  groups: [
    { id: "gmail_read", title: "Gmail: search and read", description: "Search mail and read messages and threads.", scopes: [`${G}gmail.readonly`], defaultEnabled: true },
    { id: "gmail_draft", title: "Gmail: drafts", description: "Write drafts (nothing is sent).", scopes: [`${G}gmail.compose`], defaultEnabled: true },
    { id: "gmail_send", title: "Gmail: send", description: "Send e-mail as the connected account (always asks first).", scopes: [`${G}gmail.send`], defaultEnabled: false },
    { id: "gmail_organize", title: "Gmail: labels and archive", description: "Add or remove labels, archive, mark read.", scopes: [`${G}gmail.modify`], defaultEnabled: false },
    { id: "calendar_read", title: "Calendar: read", description: "List events and find free time.", scopes: [`${G}calendar.readonly`], defaultEnabled: true },
    { id: "calendar_write", title: "Calendar: create and update", description: "Create and change events.", scopes: [`${G}calendar.events`], defaultEnabled: true },
    { id: "drive_read", title: "Drive: search and read", description: "Find files and read their text.", scopes: [`${G}drive.readonly`], defaultEnabled: true },
    { id: "docs_read", title: "Docs: read", description: "Read Google Docs.", scopes: [`${G}documents.readonly`], defaultEnabled: true },
    { id: "docs_write", title: "Docs: create and append", description: "Create documents and add text.", scopes: [`${G}documents`], defaultEnabled: false },
    { id: "sheets_read", title: "Sheets: read", description: "Read ranges from spreadsheets.", scopes: [`${G}spreadsheets.readonly`], defaultEnabled: true },
    { id: "sheets_write", title: "Sheets: append and update", description: "Add rows and change cells.", scopes: [`${G}spreadsheets`], defaultEnabled: false }
  ],
  actions: [...gmailActions, ...calendarActions, ...driveActions],
  setup: {
    consoleName: "Google Cloud console",
    consoleUrl: "https://console.cloud.google.com/apis/credentials",
    docsAnchor: "google-workspace",
    steps: [
      "In the Google Cloud console, create (or pick) a project for Sibyl.",
      "APIs & Services → Library: enable the Gmail API, Google Calendar API, Google Drive API, Google Docs API and Google Sheets API.",
      "APIs & Services → OAuth consent screen: choose Internal (Workspace only) or External, add your support e-mail, and add the scopes of the action groups you will use.",
      "APIs & Services → Credentials → Create credentials → OAuth client ID → Web application.",
      "Add the redirect URI shown below under Authorized redirect URIs, then create.",
      "Paste the client ID and client secret here. They are stored encrypted in Sibyl's secrets vault."
    ]
  },
  async identify(ctx) {
    const me = await ctx.http.get<{ email?: string; name?: string }>(`${ctx.base("userinfo")}/v1/userinfo`);
    return { ...(me.email ? { account: me.email } : {}), ...(me.name ? { accountName: me.name } : {}) };
  }
};
