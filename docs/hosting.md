# Hosting Sibyl for many organizations

Sibyl runs in one of two modes.

- **Self-hosted** (the default). One organization. Nothing on this page changes it.
- **Hosted** (`SIBYL_MODE=hosted`). One deployment serves many organizations. Each one is fully separate.

The design is in [plans/hosted.md](plans/hosted.md).

## How organizations are kept apart

- Every record already belongs to an organization (`ownerId`).
- The gateway builds one runtime per organization, from the same code as self-hosted Sibyl. All runtimes share one database connection and one usage meter.
- A runtime is built the first time it is needed: a request, a connection, or a routine or monitor that is due. It is unloaded after `SIBYL_TENANT_IDLE_MINUTES` without use. Open connections and running jobs keep it loaded.
- There is one scheduler loop. Every 30 seconds it wakes organizations with due work (routines, monitors, and Teams subscriptions that need renewing), then runs each loaded organization's jobs. Teams subscriptions last under an hour, so an idle organization with agents in Teams is woken about every 35 minutes to renew them; each organization keeps its next renewal time in a small index entry (`presence.wake`) that the loop reads across organizations.
- Each request goes to one organization:
  - a signed-in browser: the organization of its session (a session belongs to one organization);
  - an invitation link: the organization that sent it;
  - the OAuth redirect from Google or Microsoft: the organization that started it;
  - a LiveKit webhook: the organization in the room name;
  - vendor callbacks (monitor webhooks, Slack events, Teams notifications): the `/o/<organization id>/` prefix in their address. The app shows these addresses with the prefix.
- The organization's own checks still decide: sign-in, signatures, permissions. Routing only picks which organization checks.
- Each organization's secrets, connector credentials and two-step secrets are encrypted with its own key. The key is derived from the master key (`SIBYL_SECRET_KEY`) with HKDF. The self-hosted organization keeps the master key, so existing data reads as before.

Tests in `apps/gateway/src/tenancy/isolation.test.ts` run two organizations side by side and check that neither can see or change the other's data.

### Not on the hosted deployment

- Enterprise modules and licence keys. Enterprise is a separate deployment (Agent Serve).
- First-run setup and the owner token (`SIBYL_OWNER_TOKEN`). People sign up instead.

## Sign-up

The landing page's "Get started" goes to `/signup`. People pick one of:

- **Continue with Google** or **Continue with Microsoft**;
- their email, then **Email me a link** or **Set a password** (we email a 6-digit code to confirm the address).

Then they name their organization and first workspace (`/signup/org`), and setup starts (`/welcome`, see [getting-started.md](getting-started.md#4-first-run-owner-account-and-setup)).

Someone who already has an account is signed in instead, whichever way they came: a link, a code, Google or Microsoft. If their address is in more than one organization, they choose one. `/login` offers the same buttons, plus "Email me a sign-in link".

### Invitations with Google or Microsoft

An invitation page (`/invite/<token>`) also offers **Continue with Google** and **Continue with Microsoft** when the server has those sign-in apps. This accepts the invitation in one step:

- The provider must vouch for the address (as above), and the address must be the one the invitation was sent to. Another address is refused ("This invitation is for …") and the invitation stays unused. An invitation without an address takes the verified one, like the password form does.
- No account with that address yet (or one that was removed from the organization): a new account without a password is created, linked to the Google or Microsoft account, and joins the workspace. It then goes through setup (`/welcome`).
- An account with that address already exists: it joins the workspace and is linked to the Google or Microsoft account, unless it is already linked to a different one of that provider (refused).
- The organization's sign-in rules apply first (enforced single sign-on, allowed networks); a refusal leaves the invitation unused.
- The request is `GET /api/signup/oauth/<google|microsoft>/start?invite=<token>`; the gateway sends the browser back to `/invite/<token>?joined=<workspace>` signed in, or `?signin_error=<code>`.

### What you set up

| Needed for | Settings |
|---|---|
| Links and codes | `SIBYL_SMTP_URL` (and `SIBYL_SMTP_FROM`). Without email, only Google and Microsoft are offered. For Amazon SES see [configuration.md](configuration.md#sending-through-amazon-ses). |
| Continue with Google | A Google OAuth client (type "Web application") with the redirect URI `<gateway>/api/signup/oauth/google/callback`; `SIBYL_SIGNIN_GOOGLE_CLIENT_ID`, `SIBYL_SIGNIN_GOOGLE_CLIENT_SECRET`. |
| Continue with Microsoft | An app registration in Microsoft Entra ID (accounts in any organization and personal Microsoft accounts) with the web redirect URI `<gateway>/api/signup/oauth/microsoft/callback`, the `email` optional claim, and a client secret; `SIBYL_SIGNIN_MICROSOFT_CLIENT_ID`, `SIBYL_SIGNIN_MICROSOFT_CLIENT_SECRET`. |
| Links in emails | `SIBYL_APP_URL` (the web app); `SIBYL_PUBLIC_GATEWAY_URL` when the gateway is behind a proxy. |

These sign-in apps are only for signing in. They are separate from the Google and Microsoft **connectors** (`SIBYL_GOOGLE_*`, `SIBYL_MICROSOFT_*`), which read mail, calendars and files. Self-hosted Sibyl can use the same settings: invited people then sign in with a link or with Google or Microsoft, but nobody can sign up.

### How it is protected

- **Codes**: 6 digits, 15 minutes, 5 tries. Only a keyed hash (HMAC) is stored. A new code replaces the old one.
- **Links**: work once, for 15 minutes. Only a hash of the token is stored. The link opens the web app, which redeems it, so mail scanners that open links don't use them up.
- **Google and Microsoft**: authorization code with PKCE, state and nonce; the ID token's signature, issuer, audience and expiry are checked. The provider must vouch for the email address (Google: `email_verified`; Microsoft: personal accounts, or `xms_edov` for an organization's verified domain). The sign-in must finish in the browser that started it. The Google or Microsoft account is linked to the person, so a different account with the same address can't take it over.
- **Limits**, instead of CAPTCHAs: 5 emails an hour per address and 20 per IP address; 10 code or link checks per 15 minutes per address and IP, 50 per IP; 30 Google/Microsoft starts per 15 minutes per IP. Known and unknown addresses get the same answer.
- **Tickets** (below) are sealed (AES-256-GCM), last 30 minutes and work once.

Try it locally without real Google or Microsoft apps: run a mock identity provider and a mail catcher in Docker, then point the settings at them.

```bash
docker run -d --rm -p 127.0.0.1:8130:8080 -e JSON_CONFIG='{"interactiveLogin":true}' ghcr.io/navikt/mock-oauth2-server:2.1.10
docker run -d --rm -p 127.0.0.1:1125:1025 -p 127.0.0.1:8125:8025 axllent/mailpit:v1.21
```

```dotenv
SIBYL_SMTP_URL=smtp://127.0.0.1:1125
SIBYL_SIGNIN_GOOGLE_CLIENT_ID=sibyl-google
SIBYL_SIGNIN_GOOGLE_CLIENT_SECRET=anything
SIBYL_SIGNIN_GOOGLE_ISSUER=http://127.0.0.1:8130/google
SIBYL_SIGNIN_MICROSOFT_CLIENT_ID=sibyl-ms
SIBYL_SIGNIN_MICROSOFT_CLIENT_SECRET=anything
SIBYL_SIGNIN_MICROSOFT_ISSUER=http://127.0.0.1:8130/microsoft
SIBYL_SIGNIN_ALLOW_PRIVATE_NETWORK=true
```

The mock provider's sign-in page takes any user name and the claims to send, for example `{"email": "ann@acme.test", "email_verified": true}`. Emails show up at <http://127.0.0.1:8125>.

## Creating an organization

People sign up with a verified email address. The sign-up layer verifies it (link, code, Google or Microsoft) and gives the browser a **sign-up ticket**. Creating the organization redeems the ticket:

```
POST /api/orgs                      (hosted only; 404 on self-hosted Sibyl)
x-sibyl-signup-ticket: <ticket>     (or the cookie sibyl_signup)
{ "orgName": "Acme", "workspaceName": "Acme team" }

201 { "org": { "id": "o…", "name": "Acme" }, "workspaceId": "default" }
```

- The ticket names the person: email, name, how they signed up (`password`, `magic_link`, `google`, `microsoft`), the Google or Microsoft account (linked to the new owner), and a password hash for a password sign-up. Its shape is `SignupTicketVerifier` in `packages/core/src/identity.ts`; the tickets are `apps/gateway/src/identity/signup-tickets.ts`. A ticket is redeemed only when the organization was created, so a rejected name doesn't use it up.
- The reply creates the organization, its owner and its first workspace, and signs the owner in (the usual session cookie). The `sibyl_signup` cookie is cleared.
- Without a password the owner signs in by link or with Google or Microsoft.
- At most 5 new organizations per address and 20 per IP address an hour.
- A signed-in person whose address is verified can add another organization without a ticket.

`GET /api/orgs` → `{ "organizations": [{ "id", "name", "current", "role" }] }`: the organizations the signed-in person belongs to.

Signing in: `POST /api/auth/login` with email and password finds the organization from the email. If the person is in more than one, the reply is `409 choose_organization` with the list; send the chosen `org` with the next attempt. For the two-step code, send the `x-sibyl-org` header (the organization id from `/api/auth/me`).

## Model access

Each organization chooses how it pays for models.

- **Its own OpenRouter key** (`byok`). Settings → Models → Model access. The key is checked with OpenRouter (`GET https://openrouter.ai/api/v1/key`) before it is saved, and the card shows what the key can still spend. It is stored in the organization's vault as `MODEL_OPENROUTER`. Every model call uses it.
- **AI credits** (`credits`, hosted). Without a key, calls run on the platform's key (`OPENROUTER_API_KEY` on the server) and are paid from the organization's credits.
- **The server's key** (`server`, self-hosted). `OPENROUTER_API_KEY` in `.env`.

| Request | Who | Reply |
|---|---|---|
| `GET /api/model-access` | anyone who can chat | `{ mode: "byok" \| "credits" \| "server", key?: { last4, label?, limitUsd?, usageUsd?, remainingUsd?, checkedAt }, credits?: { balanceUsd }, serverKey, hosted }` (`?refresh=1` checks the key again) |
| `PUT /api/model-access/key` `{ "key": "sk-or-…" }` | owners and admins (`org.settings`) | the same shape; `400 { error: "invalid_key" }` when OpenRouter rejects the key |
| `DELETE /api/model-access/key` | owners and admins | the same shape |
| `GET /api/credits` | `usage.view` (hosted) | balance and the latest ledger entries |
| `POST /api/credits/purchase` `{ "amountUsd": 10 }` | `org.billing` (hosted) | needs a payment provider |

Saving or removing a key rebuilds the organization's runtime for the new key. Open browsers reconnect by themselves.

Self-hosted Sibyl has the same card. A key added there wins over `OPENROUTER_API_KEY` in `.env`.

## AI credits

- Each organization has a ledger. Entries are only ever added: grant, purchase, charge, refund. Each has an idempotency key, so a retry never counts twice.
- Every model call of an organization on credits is charged: the cost OpenRouter reported, plus `SIBYL_CREDITS_MARGIN`. The charge is written in the same database transaction as the call's usage record (key `usage:<event id>`): if the gateway stops right after a call, both are there or neither is, and a charge never counts twice. On start the balance is read from the ledger again.
- The balance check before a call reads the balance kept in memory (updated with every charge). With one gateway process this is exact; see [Scaling](#scaling).
- When the balance is used up, new calls stop with "Your AI credits are used up". The chat shows an **Add credits** button.
- Buying credits goes through a payment provider. Only a test provider exists so far (`SIBYL_PAYMENTS=test`: purchases complete at once, nobody is charged; never use it in production). The real provider comes later.

## Budgets, Admin and meetings

- **Budgets.** `SIBYL_BUDGET_*` caps apply to each organization on its own (every organization gets the same upper bound). Inside that, each organization sets its own budget in Admin → Organization and its workspace budgets in Settings → Workspace. One usage meter serves every organization; it keeps budgets and spend per organization.
- **Admin → Organization and Users** show and change only the signed-in organization: its name (also the name in the organization list and sign-in), its people, roles, turning people off and removing them.
- **Meetings.** Meetings, transcripts and comments belong to their organization. A hosted guest link carries the organization (`/join/<id>?k=…&o=<organization id>`), so a guest without an account (or signed in to another organization) reaches the right one. Meeting rooms on LiveKit carry the organization like every other room.

## Operator API

Set `SIBYL_PLATFORM_TOKEN` and send it as `Authorization: Bearer <token>`.

| Request | What it does |
|---|---|
| `POST /api/platform/orgs/<id>/credits` `{ "amountUsd": 5, "note": "…", "idempotencyKey": "…" }` | Grant credits. |
| `GET /api/platform/orgs/<id>` | The organization, its number of people and its balance. |
| `POST /api/platform/signup-tickets` `{ "email": "…", "name": "…", "password": "…" }` | A one-hour sign-up ticket signed by the gateway (for testing, or a sign-up layer running elsewhere). `password` is optional. |

Example:

```bash
curl -X POST "$GATEWAY/api/platform/orgs/$ORG/credits" \
  -H "Authorization: Bearer $SIBYL_PLATFORM_TOKEN" -H "content-type: application/json" \
  -d '{"amountUsd": 5, "note": "Welcome"}'
```

## Settings

All hosted settings are in [configuration.md](configuration.md#hosted-sibyl).

## Scaling

Hosted Sibyl runs as **one gateway process** today. That process can serve many organizations, but you can't yet run two gateways on the same database.

What lives only in that process's memory:

- **Loaded runtimes.** Each organization's services (agents, routines, monitors, connectors, Slack and Teams presence) run in the gateway that loaded them. Two gateways would both run the same organization's scheduled jobs and keep separate copies of its state.
- **Credit balances.** The ledger is in the database and every charge is transactional (above), but the balance used to allow or block the next call is a copy in memory. A second process wouldn't see the first one's charges until it restarts, so an organization could overspend.
- **Rate limits and budgets.** Sign-in and sign-up limits, Slack and Teams message limits, and today's / this month's spend per organization, workspace and agent are counted in memory (spend is rebuilt from the database at start).
- **Pending sign-ins and choices.** Google / Microsoft sign-ins in progress and "which organization?" choices are kept in memory for minutes; they must finish on the same process.
- **Vendor de-duplication.** Slack retries and Teams notifications are de-duplicated in memory.

What it would take to run several gateways:

1. **PostgreSQL instead of SQLite.** SQLite is one file on one machine. The store is one interface (`packages/core/src/store.ts`) with a contract test suite (`packages/store/src/store-contract.test.ts`) that a PostgreSQL store would have to pass.
2. **Credits and limits in the store, with row locking.** Check and charge in one transaction (`SELECT … FOR UPDATE` on the organization's balance row, or a conditional update that refuses a charge below zero). Rate-limit counters and budget totals move to the database (or Redis) as well.
3. **Sticky routing per organization.** Every request, WebSocket and vendor callback of one organization goes to the same gateway (a load balancer hashing the organization: the session's organization, `/o/<organization id>/` in callback paths, the invitation's organization). Then runtimes, de-duplication and pending sign-ins can stay in memory.
4. **One scheduler per organization.** The scheduler already claims routine runs with leases in the database; the wake-up loop and Teams renewals would follow the same owner as the sticky routing.

## Limits today

- One gateway process (see [Scaling](#scaling)).
- LiveKit phone numbers: each organization can set up its own trunk, but one LiveKit project serves all of them.
- Agent computers: each organization has its own file area and sandbox label. With a fixed `SIBYL_COMPUTER_PROXY_PORT`, only the self-hosted organization uses that port; hosted organizations get a free port each.
