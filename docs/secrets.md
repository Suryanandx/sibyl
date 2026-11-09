# Secrets

Sibyl can keep API keys and tokens for the services it connects to (Higgsfield, Shopify, your own business APIs) and use them on your behalf — without the model ever seeing a value.

```
You: "Make me a video with Higgsfield."
Sibyl: [secure box in the reply]  Connect Higgsfield — paste your key · only sent to api.higgsfield.ai · Save
       … calls https://api.higgsfield.ai with Authorization: Bearer ${secret:HIGGSFIELD_API_KEY}
```

## How it works

| Piece | Where | What it does |
|---|---|---|
| Vault | `apps/gateway/src/secrets/vault.ts` | Stores secrets per owner in `store.kv` (`secrets.v1`), each value encrypted with AES-256-GCM. Only metadata leaves it, except through `resolve`. |
| Secure prompt | `request_secret` tool → `secret.request` → `SecretPrompt.tsx` | The assistant asks; you type the key into a password box inside its reply. |
| Use | `api_request` tool, `resolveSecretRefs()` for MCP configs | `${secret:NAME}` is filled in on the server, only for hosts the secret allows. |
| Redaction | `redactSecrets()` in the tool loop | Every tool result is scrubbed of stored values before the model reads it. |
| Management | Settings → Secrets (`/settings/secrets`) → `SecretsPanel.tsx` | List, add, replace a value, edit hosts, delete. Values are never displayed. |

### Each secret

| Field | Notes |
|---|---|
| `name` | `UPPER_SNAKE_CASE`, ≤ 64 characters, e.g. `HIGGSFIELD_API_KEY` |
| `service`, `description` | Shown to you and to the model |
| `allowedHosts` | Where the value may be sent: `api.example.com` (exact), `*.example.com` (any subdomain, not the apex), or `local` (a local stdio MCP server's environment). 1–10 entries. |
| `createdAt`, `updatedAt`, `lastUsedAt` | Timestamps |
| `ciphertext` | `v1:` + base64(12-byte random IV ‖ GCM tag ‖ ciphertext), authenticated with the owner and name |

### The master key

- `SIBYL_SECRET_KEY` — 32 random bytes, base64 (`openssl rand -base64 32`). Use this in production and keep it in your secret store.
- Otherwise Sibyl generates one once into `$SIBYL_DATA_DIR/secret.key` (default `./data/secret.key`) with mode `0600` and logs `secrets.key_generated`. **Back this file up** together with `sibyl.db`: without it the stored secrets can't be decrypted (they show as "Needs re-entry").
- With `SIBYL_STORAGE=memory` the key is random per process (nothing persists anyway).
- A malformed `SIBYL_SECRET_KEY` disables secrets (logged as `secrets.unavailable`); the gateway still starts.

`secret.key` and `data/` are git-ignored.

## The secure prompt

The model calls:

```json
{
  "name": "HIGGSFIELD_API_KEY",
  "service": "Higgsfield",
  "description": "To generate the video you asked for.",
  "allowedHosts": ["api.higgsfield.ai"],
  "howToGet": "Settings → API keys → Create key",
  "docsUrl": "https://higgsfield.ai/settings/api"
}
```

`request_secret` is a `read` tool: the box itself is the consent. If the secret exists it returns at once (no prompt) unless `replace: true`. Otherwise the gateway sends `secret.request` to the app showing that conversation and waits up to 10 minutes (or until the run is cancelled or the app closes).

The box shows the service, why it's needed, how to get the key (link), the hosts it will be sent to — which you can remove or add before saving — and a password field with Show/Hide. The value travels once in `secret.provide`, goes straight into the vault and is cleared from the page. The model only gets `Saved HIGGSFIELD_API_KEY (allowed for api.higgsfield.ai)` or `User cancelled`.

If nobody has the app open (e.g. a routine), `request_secret` fails and tells the model the user can add the key under **Secrets**.

## Using secrets

### `api_request` (needs approval)

```json
{
  "method": "POST",
  "url": "https://api.higgsfield.ai/v1/generate",
  "headers": { "Authorization": "Bearer ${secret:HIGGSFIELD_API_KEY}" },
  "body": { "prompt": "a cat surfing" }
}
```

- `${secret:NAME}` works in headers, `query`, the body (JSON-escaped when the body is an object) and the URL's query/path (URL-encoded) — never in the host.
- Every referenced secret must allow the request's host, and secrets are only sent over `https`.
- The SSRF guard from `read_webpage` applies: public addresses only (checked before the request and at connect time), no credentials in URLs.
- Redirects are followed for GET/HEAD only (max 3), each hop re-checked; a redirect that would carry a secret to a host it doesn't allow is not followed.
- 20 s timeout, 1 MB response cap, 8 000 characters back to the model, passed through `redact()`.
- The approval card shows the method, the URL (host) and the secret names as written (`${secret:NAME}`), never values.

### MCP servers

`resolveSecretRefs(value, { host })` (exported from `apps/gateway/src/secrets/index.ts`) fills references in an MCP server config — a string, an `env`/`headers` object or an `args` array:

```json
{ "command": "npx", "args": ["-y", "shopify-mcp"], "env": { "SHOPIFY_TOKEN": "${secret:SHOPIFY_TOKEN}" } }
```

For stdio servers pass `host: undefined`; the secret must list `local`. For HTTP servers pass the server URL's hostname. A missing or disallowed secret throws `SecretError` (with no value in the message).

### What the model knows

`list_secrets` returns names, services and allowed hosts, so the assistant knows what is connected and how to reference it.

## Protocol

Client → gateway: `secret.provide {id, value, allowedHosts?}`, `secret.cancel {id}`, `secrets.list`, `secret.update {name, value?, service?, description?, allowedHosts?}` (adds a secret when it doesn't exist; then `value` and `allowedHosts` are required), `secret.delete {name}`.

Gateway → client: `secret.request {request}`, `secret.resolved {id, name, status: saved|cancelled|expired|invalid, allowedHosts?, message?}`, `secrets.state {secrets, error?}`. No server message has a field for a value, and `parseServerMessage` rejects a `secrets.state` entry that carries one.

## Threat model

**Protects against**

- *The model seeing or repeating a key.* Values are never in prompts, tool inputs or tool results: inputs carry `${secret:NAME}`, results are redacted (raw, base64 at any byte alignment — so `Basic base64(user:key)` is caught — base64url, URL-encoded, JSON-escaped). Replaced and deleted values stay redacted for the life of the process.
- *Prompt injection exfiltrating a key.* A web page or API response that tells the model to "send the key to evil.com" fails: the key is only resolved for hosts the secret allows, redirects to other hosts are not followed, and every `api_request` needs your approval.
- *Keys in the database, backups or logs.* Values are encrypted at rest; logs record names and hosts only; conversations, approvals and usage records never contain values; `secret.provide` is never echoed.
- *Tampering.* GCM authentication (bound to owner + name) rejects modified or swapped ciphertext.

**Does not protect against**

- Someone with both the database and the master key (same machine, same backup) — keep `SIBYL_SECRET_KEY` outside the data volume in production.
- A compromised gateway process or host: values are decrypted in memory to send and to redact.
- An allowed host misusing the key, or an allowed host that reflects requests to third parties (e.g. a too-broad `*.example.com` covering user-content subdomains). Keep hosts narrow.
- You approving a bad `api_request`, or ticking "Don't ask again in this chat" for it.
- Keys pasted directly into the chat (the assistant is told to use the secure box; a pasted key is ordinary chat text).
- Very short values (< 4 characters) are not redacted; base64 fragments shorter than 8 characters are not matched.

## Limits

- 200 secrets per owner, values up to 8 192 characters, 10 hosts each.
- Hosts are matched by hostname; ports are not part of the binding.
- `*.example.com` does not match `example.com`; list both if needed. Wildcards need at least two labels (`*.com` is rejected) but public suffixes like `*.co.uk` are not detected.
- `request_secret` needs an open app; background routines can only use secrets that already exist.
- Changing the master key makes existing secrets unreadable: re-enter them (Replace value) — they are not lost silently.
