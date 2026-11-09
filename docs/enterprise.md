# Enterprise (Agent Serve)

Sibyl is free and open source, including teams and workspaces. The enterprise
edition, [Agent Serve](https://valnoraelric.com) by valnoraelric.com, adds
controls for larger organisations; to get it, talk to us. The controls live in
`ee/` and turn on with a licence key (`SIBYL_LICENSE_KEY`, or paste it in
**Settings → Licence**); see [LICENSING.md](../LICENSING.md). Without a key the
Admin sections below show "Available with Agent Serve" and Sibyl works exactly
as the open source edition.

Everything here is in **Admin** (`/admin/<section>`, under Settings), which organization
owners and admins can open. Admin → Organization and Admin → Users are free
(see [admin.md](admin.md)); with a licence, Users also shows who signs in
through single sign-on and which accounts SCIM manages.

## Roles

Licence feature: `custom_roles`. Admin → **Roles**.

### Custom roles

A custom role is a named set of permissions from the permission catalogue
(`chat.use`, `knowledge.edit`, `tools.write`, `audit.view`, …). The built-in
roles (Owner, Admin, Member, Viewer) stay.

- Assign a custom role to a person for the **whole organization** or for
  **one workspace**. A workspace assignment wins in that workspace.
- While assigned, the custom role decides what the person may do there
  **instead of** their built-in role. Their built-in role still decides which
  workspaces they can open.
- Organization permissions (`org.settings`, `org.billing`, `audit.view`) only
  count in organization-wide assignments. For example, an "Auditor" role with
  `chat.use` and `audit.view` lets someone read the audit log.
- Organization owners are never limited, so nobody can lock the organization
  out. A custom role can't be assigned to an owner.
- Deleting a role removes it from everyone who had it; they go back to their
  built-in role.

The gateway checks every HTTP request, WebSocket message and tool call with
the same rules, and the web app hides what a person can't do.

### Who may use a shared connection

For each shared connection (Integrations, shared with a workspace) you can
name the roles (built-in or custom) and the people who may use it. Everyone
else can't use it: its tools are not offered to them or to agents acting for
them. Without a rule, everyone who may use integrations in the workspace can
use it. Personal connections are only ever used by their owner.

## Policies

Licence feature: `policies`. Admin → **Policies**. Changes apply right away.

### Blocked tools

Pick tools, or every tool of a source (an MCP server, a connector, memory, …).
Blocked tools are never offered to Sibyl, agents, routines or monitors, and a
call to one is refused and recorded in the audit log.

### Second approval

Write actions already ask the person for approval. A policy can also require
an **organization owner or admin** to approve, after the person:

- **High-risk actions**: send, delete, share outside, pay;
- **Every action that changes something**;
- **Only the tools chosen**.

Waiting actions appear at the top of Admin → Policies, and owners and admins
get a notification. The approver must be someone other than the person who
asked. An action waits up to 10 minutes; if nobody decides, it does not run.

### Model allowlist

Tick the models people may use. Leave all unticked to allow every model in the
catalogue. Choosing a model that isn't allowed is refused with a message, and
chats, routines and monitors that would use it stop with the same message.
Make sure the default model (Settings → Models) is on the list.

### Data retention

Set how many days to keep **chats**, **uploaded files** and
**notifications**. Older items are deleted every hour by the same scheduler that
runs routines. Leave a field empty to keep those items. **Run now** applies the
rules immediately. Each run that deletes something is recorded in the audit
log. The audit log itself is never deleted by retention.

## Audit log

Licence feature: `audit_log`. Admin → **Audit log**. Reading it needs the
`audit.view` permission (organization owners, or a custom role with it).

### What is recorded

- sign-ins (and failed sign-ins), sign-outs;
- member role changes and removals, invitations, workspaces created and deleted;
- custom roles, role assignments and connection access rules;
- integrations connected, changed and removed, and app setup;
- secrets saved, deleted and used — **by name only, never the value**;
- approvals, second approvals and every write action a tool ran;
- blocked tools and refused models;
- downloads (decks, files) and audit log exports;
- licence and policy changes, retention runs.

Each entry has the time, who did it, the workspace, what it was about and the
outcome (succeeded, failed or denied).

### Tamper evidence

The log is append-only: Sibyl has no way to change or delete entries. Every
entry also carries a SHA-256 hash of its content and of the entry before it.
**Check integrity** walks the whole chain and tells you the first entry that
was changed, inserted or removed (for example by someone editing the
database file).

### Export

**Export CSV** or **Export JSONL** downloads the entries that match the
current filters (newest first, up to 100,000). CSV cells that start with
`=`, `+`, `-` or `@` are prefixed with `'` so spreadsheets don't run them.

### Streaming to a webhook (SIEM)

Enter an `https` URL. New entries are sent in order, in batches of up to 100,
as `POST` with a JSON body `{ "entries": [...] }` and these headers:

| Header | Value |
|---|---|
| `x-sibyl-timestamp` | Unix time in milliseconds |
| `x-sibyl-signature` | `sha256=` + hex HMAC-SHA256 of `<timestamp>.<body>` with your signing secret |

The signing secret is shown once when you save the webhook (or choose **New
secret**). It is stored in the secrets vault, allowed only for the webhook's
host. Sibyl remembers the last entry delivered; after a failure it retries
with back-off (up to 15 minutes) and shows the error. Webhooks on private or
local addresses are refused. Streaming starts from new entries; use Export for
history.

### API

| Route | Permission |
|---|---|
| `GET /api/admin/audit?action=&actor=&workspaceId=&outcome=&from=&to=&q=&before=&limit=` | `audit.view` |
| `GET /api/admin/audit/verify` | `audit.view` |
| `GET /api/admin/audit/export?format=csv\|jsonl` (+ the same filters) | `audit.view` |
| `GET/PUT/DELETE /api/admin/audit/stream`, `POST /api/admin/audit/stream/test` | `audit.view` |
| `/api/admin/roles…`, `/api/admin/policies…`, `/api/admin/approvals…` | `org.settings` |

`action` takes an exact action (`auth.sign_in`) or an area ending in a dot
(`auth.`).

## Single sign-on

People sign in through your identity provider (IdP) instead of a Sibyl password.
Sibyl supports **OpenID Connect** (Okta, Microsoft Entra ID, Google, Keycloak,
Auth0 …) and **SAML 2.0**. Licence feature: `sso`.

### Add a provider

1. Open **Admin → Single sign-on → Add provider**.
2. Choose OpenID Connect or SAML, give it the name people see on the sign-in
   button ("Continue with Okta"), and list the **email domains** it signs people
   in for.
3. Fill in the provider's details:
   - **OpenID Connect:** issuer URL, client ID and client secret. Sibyl reads
     `<issuer>/.well-known/openid-configuration` when you save, so a wrong issuer
     is caught right away. Register the **redirect URI** Sibyl shows at your IdP.
   - **SAML:** the IdP's single sign-on URL, its signing certificate (PEM), and
     optionally its entity ID. Register the **SP entity ID** and **ACS URL** Sibyl
     shows (or give the IdP the metadata URL).
4. Press **Check** to test the settings, then sign in once in a private window.

The client secret is stored in the secrets vault (encrypted, sent only to the
IdP's token endpoint) and is never shown again. It appears in Settings → Secrets
as `SSO_<ID>_CLIENT_SECRET`.

### How sign-in is checked

- **OpenID Connect:** authorization code flow with PKCE, `state` and `nonce`. The
  ID token's signature is checked against the IdP's published keys, plus issuer,
  audience and expiry.
- **SAML:** the assertion itself must be signed with the configured certificate.
  Sibyl checks the audience (its SP entity ID), the recipient (its ACS URL), the
  time window (one minute of clock skew), that the response answers a sign-in
  Sibyl started in the last 10 minutes, and that the assertion hasn't been used
  before. Sign-in started at the IdP (IdP-initiated) is not accepted.
- The browser that finishes a sign-in must be the one that started it.

### Who can sign in

A provider signs in people whose email is in one of its **domains** (a domain
belongs to one provider). Claiming a domain is the admin's statement — one Sibyl
is one organization, so there is no DNS check.

- An account already linked to the person at this provider is used.
- Otherwise an account with the same email is linked (OpenID Connect: unless the
  IdP says the email is unverified).
- Otherwise, with **"Create an account the first time someone signs in"** on, a
  new account is created in the workspace and role you choose under **New people
  and groups**. With it off, only existing or provisioned people get in.

Accounts created this way have no Sibyl password.

### Groups

Under **New people and groups**, map a group to a workspace role (for example
`engineering` → Engineering, Admin). Groups come from the OpenID Connect groups
claim (default `groups`), the SAML groups attribute, or SCIM. People get the
highest role their groups give. Leaving a group takes the role back. A role an
admin gave by hand is never lowered. Groups never make anyone an owner.

### Require single sign-on

**Require SSO** refuses password sign-in for every email in your providers'
domains. One **break-glass owner** keeps password sign-in (with two-step
verification, if you require it) so you can get in when the IdP is down. Turning
on the requirement makes you the break-glass owner unless you pick another
owner. Removing the last provider turns the requirement off.

The owner token (`SIBYL_OWNER_TOKEN`) is an API key and always works.

## SCIM

SCIM 2.0 lets your IdP create, update and remove people and groups in Sibyl.
Licence feature: `scim`.

1. Open **Admin → Provisioning (SCIM)** and create a token. Copy it: it is shown
   once, and Sibyl keeps only its hash. You can have several tokens and revoke
   them one by one.
2. In your IdP, set the SCIM base URL Sibyl shows (`<gateway>/scim/v2`) and the
   token as a Bearer token.

What Sibyl supports:

| | |
|---|---|
| Users | list, `filter=userName eq "…"` (also `externalId`, `emails.value`, `id`), get, create, replace (PUT), update (PATCH), delete |
| Groups | list, `filter=displayName eq "…"` (also `externalId`, `id`), get, create, replace, update members (add, remove, replace), delete |
| Paging | `startIndex`, `count` (up to 200) |
| Not supported | bulk, sorting, ETags, password changes |

- `userName` is the person's email address.
- New people join the workspace and role set under **New people and groups**.
- **Removing someone** (DELETE, or `active: false`) turns the account off: they
  can't sign in and every session ends at once, including open chats. Their
  chats and work stay. `active: true` turns the account back on.
- Sibyl never turns off the organization's last owner.
- Groups use the same group → role rules as SSO.

## Session policies

Under **Admin → Session policies** (licence feature `sso`):

- **Sign out after (hours):** a session ends this long after sign-in, used or
  not. Without it, a session lasts 30 days from its last use.
- **Sign out when idle (minutes):** a session ends after this long without a
  request or chat message. Open chats are closed too (checked every minute).
- **Allowed networks:** IP addresses or CIDR ranges (IPv4 and IPv6). Sign-in and
  every request must come from them. A request from elsewhere is refused, but the
  session isn't ended, so it works again back on an allowed network. You can't
  save a list that leaves out your own address. Behind a reverse proxy on the same
  machine or private network, Sibyl uses `X-Forwarded-For`.
- **Require two-step verification** for password sign-ins. People without it set
  it up at their next sign-in (or when they accept an invitation). SSO sign-ins
  rely on your IdP's MFA.

The owner token is not limited by these policies.

### Two-step verification is open source

Anyone can turn on two-step verification for their own account in **Settings →
Sign-in security**, in every edition: it protects an account, and that
shouldn't need a licence. What Agent Serve adds is *requiring* it for
everyone.

- Codes are standard TOTP (RFC 6238: 6 digits, 30 seconds, SHA-1), so any
  authenticator app works. A code works once.
- Ten one-time recovery codes are shown when you turn it on. Sibyl keeps only
  their hashes.
- The secret is encrypted with the secrets key (`SIBYL_SECRET_KEY` or
  `data/secret.key`). If that key changes, people with two-step verification
  must use a recovery code, then turn it off and on again.
- A sign-in code request expires after 5 minutes or 5 wrong codes.

## Advanced usage controls

Feature `usage_advanced`. Open it in **Admin → Usage controls** (organisation owners and admins).

The open-source budgets (`SIBYL_BUDGET_DAILY_USD`, `SIBYL_BUDGET_MONTHLY_USD`, the routine caps) always apply first, and the switch to cheaper models at 85% of a budget works as before. Usage controls only add limits on top.

### What you can set

- **Budgets by person.** A daily and a monthly cap in USD for one person. It counts their spend in every workspace: chat, voice, deep work and the routines they created.
- **Budgets by role.** A daily and a monthly cap for each person with that role (owner, admin, member, viewer). The role is the one they have in the workspace they are working in. A person's own budget replaces their role's, field by field.
- **Cost cap per request.** A request expected to cost more is refused before it starts. The estimate is the model's recent average cost, or its price.
- **Allowed models.** When the list is not empty, only these model ids may be used for chat, voice and routines.
- **Requests per minute.** Chat and voice requests per person per minute. Routines don't count.

When someone gets close to their own budget (85%), Sibyl switches them to the Cheapest preset, as it does for the organisation budget. When a limit stops a request, the person sees why in the chat, and routines stop with "budget".

### Alerts

Choose thresholds as percentages of a budget, for example `80, 100`. Each person, budget (daily or monthly) and threshold alerts once per day or month. Being stopped by a budget counts as 100%.

- **Email** goes through the gateway's mailer (`SIBYL_SMTP_URL`), to the addresses you list and, if you tick the box, to the person.
- **Webhook**: Sibyl POSTs JSON to your URL:

  ```json
  { "type": "usage.alert", "id": "…", "at": "2026-11-09T12:00:00.000Z",
    "user": { "id": "…", "name": "Ana", "email": "ana@example.com" },
    "workspace": { "id": "default", "name": "Default" },
    "period": "daily", "thresholdPercent": 80, "blocked": false,
    "spentUsd": 0.8, "capUsd": 1, "message": "Sibyl usage: Ana used 80% of their daily budget" }
  ```

  Each delivery has the headers `x-sibyl-timestamp` (Unix milliseconds) and `x-sibyl-signature: sha256=<hex>`. The signature is HMAC-SHA256 of `<timestamp>.<body>` with the signing key. The key is created in the secrets vault when you save a webhook URL, and is shown once. Use **New signing key** to replace it. Webhooks need the vault (`SIBYL_SECRET_KEY`).

  The webhook must be on the public internet. To send alerts to a receiver on your own network, set `SIBYL_USAGE_WEBHOOK_PRIVATE=true` on the gateway.

Use **Send a test alert** to check both channels.

### Chargeback report

The report shows what each workspace and person spent in a date range. It is built from the recorded model calls, so it matches what the meter counted. **Export CSV** downloads it with the columns `workspace_id, workspace, user_id, user, email, calls, cost_usd, voice_usd, brain_usd, routine_usd, other_usd`.

Spend recorded without a person or workspace shows as "Unattributed". This covers calls made before this feature was installed, and background work such as monitors and memory.

Who sees what:

- organisation owners and admins see everything;
- someone with `budgets.manage` in a workspace sees everyone in that workspace;
- someone with `usage.view` sees only their own spend.

### API

All routes go through the gateway's permission check. Reads need `usage.view` and changes need `budgets.manage`. The settings also need organisation owner or admin.

| Method and path | What it does |
|---|---|
| `GET /api/usage-controls` | Settings, people and their spend today and this month |
| `PUT /api/usage-controls` | Save settings (`{ "controls": { … } }`). Returns `webhookKey` once when a key is created |
| `POST /api/usage-controls/webhook-key` | Replace the webhook signing key (returned once) |
| `POST /api/usage-controls/test-alert` | Send a sample alert about you |
| `GET /api/usage-controls/report?from=YYYY-MM-DD&to=YYYY-MM-DD` | Chargeback report (JSON). Both dates are included. The default is this month |
| `GET /api/usage-controls/report.csv?from=…&to=…` | The same report as CSV |

### How it plugs in

The open-source usage meter has one hook, a usage policy (`UsagePolicy` in `packages/core/src/usage.ts`). The meter asks it after its own caps allow a call. Every usage event now records who spent (`userId`) and in which workspace (`workspaceId`). Without a licence, no policy is installed and nothing changes.
