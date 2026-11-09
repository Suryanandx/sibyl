# Security policy

Sibyl handles microphone audio, conversations, provider credentials and tools that can act on your behalf. Please treat security and privacy problems with care, even on a local deployment.

## Supported versions

Sibyl is pre-1.0 and changes quickly.

| Version | Security fixes |
|---|---|
| `main` | Supported |
| Latest release | Best effort |
| Older versions | Not supported |

Please reproduce against `main` before reporting, when it is safe to do so.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability.

Use GitHub's private reporting: **Security → Report a vulnerability** at <https://github.com/Suryanandx/sibyl/security/advisories/new>. If that is unavailable, open an issue asking for a private contact, without any details of the problem.

Please include:

- the affected commit or version and how Sibyl was deployed;
- what an attacker could do, and a realistic scenario;
- minimal steps to reproduce, or a proof of concept;
- whether credentials, audio, transcripts, stored conversations, tools or network boundaries are involved;
- a suggested fix, if you have one.

We aim to acknowledge complete reports within five business days. Fix timing depends on severity and risk. Please give us time to ship a fix before disclosing publicly.

## In scope

- Exposure of API keys, the owner token, audio, transcripts or stored conversations.
- Bypassing `SIBYL_OWNER_TOKEN`, `ALLOWED_ORIGINS` or message validation.
- A write tool running without an approval, or an approval applying to something other than what the card showed.
- Server-side request forgery through tools such as `read_webpage`, or through provider or MCP URLs.
- Prompt injection that leads to an unapproved action or to data leaving through a tool.
- Budget bypasses that allow unbounded spending.
- Cancellation or reconnect behaviour that keeps sending audio or data after the user stopped.
- Exploitable vulnerabilities in shipped dependencies.

Hardening suggestions, provider outages, model quality and deployments that ignore the guidance in [docs/deployment.md](docs/deployment.md) (for example a public gateway with no owner token) are usually not vulnerabilities. Use a normal issue unless sensitive information is involved.

## Safe research

- Test only systems and accounts you control.
- Use synthetic audio and placeholder credentials.
- Avoid privacy violations, destructive actions and service disruption.
- Stop once you have enough evidence to report.

Thank you for helping keep Sibyl users safe.
