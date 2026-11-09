# Hosted Sibyl: tenancy, sign-up and onboarding

Status: **agreed** (2026-11-09).

- **Multi-tenant**: one hosted deployment serves many organizations, fully separated.
- **Sign-up methods**: email + password, magic link, Continue with Google, Continue with Microsoft.
- **Billing**: plans are bring-your-own-key (BYOK) with a small subscription; people without a key can buy AI credits.
- **Enterprise** is Agent Serve by valnoraelric.com ("talk to us").

## 1. Modes

| | Self-hosted (default) | Hosted (`SIBYL_MODE=hosted`) |
|---|---|---|
| Organizations | one (`owner`) | many, created at sign-up |
| First run | owner setup screen | public sign-up |
| Model key | `OPENROUTER_API_KEY` in `.env`, or pasted during onboarding (vault) | the organization's own key (BYOK, vault), or AI credits |
| Enterprise modules | licence key | Agent Serve (not on the shared host) |

Self-hosted behaviour does not change. Everything below is additive.

## 2. Tenancy

- `ownerId` already means *organization* in every record. Today `runtime.ts` builds every service once with `DEFAULT_OWNER_ID`.
- In hosted mode, a **tenant registry** creates one `GatewayRuntime` per organization on first use, from the same `createRuntime` code. These runtimes share:
  - the one store connection;
  - one scheduler (jobs carry their organization);
  - one usage meter backend.
- Idle tenants are unloaded.
- A connection, HTTP request or job is routed to the runtime of the principal's organization. Nothing crosses organizations.
- Isolation tests for every collection and API show that org A can never see or change org B's data.
- Per-organization secrets key: each organization's vault values are encrypted with a key derived for that organization.

## 3. Model access

- **BYOK.** An organization's OpenRouter key lives in its vault (`model.openrouter`). Model adapters for that tenant use it, and the scout, catalog and costs work per key. The key is checked when it is added, using OpenRouter's key endpoint, which also shows the key's limit and credit.
- **AI credits**, for organizations without a key:
  - **Platform key**: model calls run on the platform's key.
  - **Ledger**: every metered call is charged against a prepaid credit balance per organization, kept in its own `credits` ledger.
  - **Running out**: when the balance is empty, the organization gets the usual budget-blocked message, plus "Add credits".
  - **Buying credits**: through a payment-provider hook. A test-mode provider comes first; the real payment provider is chosen later.

## 4. Sign-up (hosted)

1. `/signup`. The person picks one of:
   - Continue with Google;
   - Continue with Microsoft;
   - email, then a magic link or a password.
2. Email addresses are verified: by the link, or by a code for a password sign-up.
3. They create an organization with a name; the first workspace gets a name too. They become its owner.
4. Onboarding starts (section 5).

The Google and Microsoft sign-in is part of the open-source identity code (OpenID Connect). Enterprise SSO is a separate `ee/` feature. The two share the OIDC client helpers, which live in the open-source code.

## 5. Onboarding (hosted and self-hosted first run)

A short, skippable flow. Each step is one screen with one decision.

1. **Welcome**: a name and the avatar the person shows in the app.
2. **Model access**:
   - "Use my OpenRouter key" (paste, checked live, shows its credit);
   - or "Buy AI credits" (hosted);
   - or "Already set by the server" (self-hosted with `.env`).
3. **Pick a style**: Cheapest, Balanced, Fastest or Best, with typed and voice prices. Balanced is pre-selected.
4. **Connect your tools** (optional): Google, Microsoft, Slack. One click each, and a shared connection for the team.
5. **Your first agent** (optional): pick a template ("Research assistant", "Inbox helper", "Meeting note-taker"…), give it a name, and its avatar is generated.
6. **Add knowledge** (optional): drop files or a folder.
7. **Invite your team** (optional): e-mail invites or a link.
8. **First conversation**: suggested prompts built from what they connected, and a "Try talking" hint.

After onboarding:

- A **Getting started** checklist stays in the sidebar until it is done or dismissed. It shows progress, and each item deep-links to the right screen.
- Every empty state teaches the next action.
- Onboarding state is stored per person and per organization, so it resumes on any device.

## 6. Delivery

1. **Tenancy foundation**: tenant registry, per-organization model key (BYOK), credits ledger, organization creation, isolation tests.
2. **Sign-up and onboarding**: section 4 and section 5 screens. The landing page's "Get started" links to `/signup` on the hosted site.
3. **Payments for credits and plans**: provider chosen with the user.
