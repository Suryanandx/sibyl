# Licensing

Sibyl is **open core**.

| | Sibyl (open source) | Enterprise (Agent Serve by valnoraelric.com) |
|---|---|---|
| Code | everything outside `ee/` | the `ee/` directory |
| Licence | [MIT](LICENSE) | [Sibyl Enterprise License](ee/LICENSE) (source-available, modelled on the Elastic License 2.0; **draft, pending legal review**) |
| Cost | free | production use of enterprise features needs a paid licence key |
| Without a key | everything works | enterprise modules stay off; Sibyl runs as the open-source edition |

## What is free

Chat and voice, knowledge, skills, plugins, routines, slides, usage metering,
teams and workspaces, and the Google and Microsoft connectors — all MIT.

## What is Enterprise

Custom roles, policies, SSO, SCIM, the audit log, advanced usage controls, and
the HubSpot and Salesforce connectors. See [`ee/README.md`](ee/README.md).

## How the two fit together

- **One-way dependency.** Open-source code never imports from `ee/`.
  Enterprise modules register through hooks in `packages/core/src/features.ts`
  (`registerEnterpriseModule`, HTTP routes, permission policies). The gateway
  reaches `ee/` through one documented loader,
  `apps/gateway/src/license/ee-loader.ts`. `pnpm check:ee-boundary` (and the
  test suite) enforce this.
- **Deleting `ee/` leaves a working, fully MIT product.** Build with
  `SIBYL_EDITION=oss` to leave enterprise code out of the gateway bundle even
  when the directory is present.
- **Licence keys** (`SIBYL_LICENSE_KEY`) are Ed25519-signed tokens verified
  offline (`packages/core/src/license.ts`, MIT). No phone-home. An expired key
  turns enterprise features off; it never locks anyone out of their data.
- Code already published under MIT stays MIT. Only new enterprise code goes
  into `ee/`.

## Contributing

Contributions outside `ee/` are MIT. Contributions to `ee/` are accepted under
the Sibyl Enterprise License. If you are unsure where something belongs, open
an issue first.
