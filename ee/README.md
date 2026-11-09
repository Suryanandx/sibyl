# Sibyl Enterprise (`ee/`)

Everything in this directory is licensed under the **Sibyl Enterprise License**
([`ee/LICENSE`](LICENSE)), a source-available licence modelled on the Elastic
License 2.0. Everything outside `ee/` is MIT. See [`../LICENSING.md`](../LICENSING.md).

> The licence text is a **draft** and must be reviewed by a lawyer before the
> first enterprise release.

## What is Enterprise

Teams, workspaces, the Google and Microsoft connectors and everything else in
Sibyl are free and open source. Sibyl Enterprise adds controls larger
organisations need:

| Feature id | What it is |
|---|---|
| `custom_roles` | Roles beyond owner, admin, member and viewer |
| `policies` | Organisation-wide rules for tools, models, data and sharing |
| `sso` | SAML / OpenID Connect single sign-on |
| `scim` | User and group provisioning from your identity provider |
| `audit_log` | A record of who did what, exportable to your SIEM |
| `usage_advanced` | Per-team and per-user budgets, quotas and reports |
| `connector_hubspot` | HubSpot CRM connector |
| `connector_salesforce` | Salesforce connector |
| `recordings` | Call recordings (LiveKit egress), retention, list and download ([docs/realtime.md](../docs/realtime.md#recordings-enterprise)) |

The catalogue lives in `packages/core/src/features.ts` (`FEATURES`).
Status: the framework is in place; the only module today is an example behind
`audit_log` that logs "enterprise module loaded".

## How licensing works

- A licence key is a signed token: `sibyl1.<base64url(JSON payload)>.<base64url(Ed25519 signature)>`.
  The payload is `{ licensee, edition: "enterprise", seats, features, issuedAt, expiresAt }`.
- The gateway verifies it **offline** at startup against the public keys
  embedded in `packages/core/src/license.ts` (`SIBYL_LICENSE_PUBLIC_KEYS`).
  No phone-home, no telemetry.
- Set it with `SIBYL_LICENSE_KEY`, or paste it in **Settings → Licence**
  (owner only; stored in the data directory). The environment variable wins.
- Enterprise modules load at startup only when the licence enables their
  feature **and** `ee/` is part of the build. After changing the key, restart.
- **Expiry never locks you out.** An expired or invalid key turns enterprise
  features off; Sibyl keeps running as the open-source edition with all data.

## Getting a key

Contact the Sibyl maintainers at `enterprise@sibyl.example` (placeholder —
replace before release) with your organisation name, seat count and the
features you need. Evaluation keys are available for testing.

## Layout

```
ee/
  LICENSE              Sibyl Enterprise License (draft)
  gateway/index.ts     registers gateway modules (loaded by apps/gateway/src/license/ee-loader.ts)
  tools/issue-license.mjs  key generation and issuing (maintainers only)
  tsconfig.json        `pnpm typecheck:ee`
```

Planned: `ee/web` (enterprise screens) and `ee/packages` (shared enterprise code).

## Writing an enterprise module

```ts
// ee/gateway/index.ts
export default function registerEnterprise({ registerEnterpriseModule }) {
  registerEnterpriseModule({
    id: "audit-log",
    feature: "audit_log",
    install(ctx) {
      // ctx.tools, ctx.store, ctx.meter, ctx.log, ctx.env, ctx.gate
      // ctx.registerHttpRoute((req, res) => boolean)
      // ctx.registerPermissionPolicy(({ permission, role }) => "allow" | "deny" | undefined)
      return { close() {} };
    }
  });
}
```

Rules:

- Code in `ee/` may use the open-source packages. Open-source code must
  **never** import from `ee/` — `pnpm check:ee-boundary` (also run by the test
  suite) fails the build otherwise. The single exception is the documented
  loader `apps/gateway/src/license/ee-loader.ts` (plus the build script).
- Deleting `ee/` must leave a working product. The gateway build
  (`apps/gateway/build.mjs`) bundles `ee/gateway` when present; set
  `SIBYL_EDITION=oss` to build without it.

## Issuing keys (maintainers)

The production signing key must be generated **offline** on a trusted machine
and kept secret (password manager / HSM, never in a repository, CI secret or
chat). Only its public half goes into `SIBYL_LICENSE_PUBLIC_KEYS`.

```bash
# once: create a signing keypair outside the repository
node ee/tools/issue-license.mjs keygen --out ~/secure/sibyl-signing
# → prints the public key to put in packages/core/src/license.ts

# per customer
SIBYL_LICENSE_PRIVATE_KEY_FILE=~/secure/sibyl-signing/sibyl-license-signing.pem \
  node ee/tools/issue-license.mjs issue --licensee "Acme Ltd" --seats 50 --days 365 --features all
```

The public key embedded today is a **development** key; its private half is
not in the repository. Replace it with the production public key before the
first enterprise release (keep the old one in the list only if keys signed
with it must stay valid).
