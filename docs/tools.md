# Tools, MCP and approvals

The deep brain can call tools while it works on an answer: built-in tools for everyday lookups, and any tools your MCP servers provide. Tools that only read run on their own. Tools that change something wait for your approval in the chat.

## How a tool call looks

1. You ask something that needs fresh information or an action, by typing or by voice (the voice brain hands it to the deep brain).
2. The deep brain decides which tools to call. Each call shows as a step in the reply ("Searching the web", "Reading a webpage"), with a short result summary when it finishes.
3. The deep brain can take up to six rounds of tool calls, then writes its answer, with a visual when it helps.

Long tool results are cut to a manageable size before they go back to the model.

## Built-in tools

All built-in tools only read, so they never need approval.

| Tool | What it does | Where the data comes from |
|---|---|---|
| `web_search` | Searches the web and returns sources | OpenRouter's web search, using `SIBYL_WEB_SEARCH_MODEL` (default `google/gemini-3.8-flash`). Only available with an OpenRouter key. |
| `read_webpage` | Fetches a page and extracts its readable text | The page itself, fetched from your gateway |
| `weather` | Current conditions and forecast for a place | Open-Meteo (no key needed) |
| `currency_convert` | Converts between currencies at the latest rates | Frankfurter (no key needed) |
| `world_time` | The current time in a city or time zone | Computed on the gateway |
| `calculate` | Evaluates arithmetic exactly | Computed on the gateway |
| `wikipedia` | Searches Wikipedia and returns article summaries | Wikipedia |

`read_webpage` only fetches public `http` and `https` addresses. Private, loopback and link-local addresses (including cloud metadata endpoints) are refused, every redirect is checked again, and addresses are re-checked at connect time so DNS tricks can't reach your internal network.

Set `SIBYL_BUILTIN_TOOLS=false` to turn all built-in tools off.

## Connecting MCP servers

Sibyl is an [MCP](https://modelcontextprotocol.io) client. Tools from the servers you list become available to the deep brain alongside the built-ins.

Create `mcp.config.json` at the project root (or point `SIBYL_MCP_CONFIG` at a file elsewhere). The format matches the common `servers` / `mcpServers` layout used by desktop MCP clients:

```json
{
  "servers": {
    "files": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/srv/shared"]
    },
    "crm": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${CRM_TOKEN}" }
    },
    "_note": "Keys starting with an underscore are comments and are ignored."
  }
}
```

| Field | Meaning |
|---|---|
| server name | Letters, digits, `_` and `-`, up to 32 characters. |
| `command`, `args`, `env`, `cwd` | A local server started over stdio. |
| `url`, `headers` | A remote server over Streamable HTTP (`http` or `https`). |
| `timeoutMs` | Connect timeout for this server. |
| `disabled: true` or `enabled: false` | Skip this server without deleting it. |

`${VAR}` inside `command`, `args`, `env`, `cwd`, `url` and `headers` is replaced from the gateway's environment, so tokens can stay in `.env` rather than in the config file.

Servers are connected when the gateway starts. A server that fails to connect, or a broken config file, is logged and skipped; it never stops the gateway. Restart the gateway after editing the file.

| Variable | Default | Purpose |
|---|---|---|
| `SIBYL_MCP_CONFIG` | `mcp.config.json` at the project root | Path to the MCP config. The gateway logs an error if a path you name does not exist. |
| `SIBYL_MCP_CONNECT_TIMEOUT_MS` | `20000` | How long to wait for each server to connect. |
| `SIBYL_MCP_CALL_TIMEOUT_MS` | `120000` | How long a single tool call may take. |

> **Run only MCP servers you trust.** A stdio server runs as a program on your gateway host with the gateway's permissions, and any server sees the inputs the deep brain sends it.

## Approvals

Every tool is marked as either **read** or **write**:

- built-in tools are all read;
- an MCP tool is read only if its server marks it read-only (`readOnlyHint`). Everything else is treated as write.

A write call pauses the deep brain and shows an **approval card** in the chat: what will happen, in a sentence or two, and the key inputs (long values are shortened and anything that looks like a secret is masked).

- **Approve** runs the tool and the deep brain carries on.
- **Decline** tells the deep brain the action was not allowed; it continues without it.
- **Don't ask again in this chat** approves that tool automatically for the rest of the conversation.

An unanswered approval expires after 10 minutes. It is also cancelled when you stop the reply or close the connection.

## Turning tools on and off

Individual tools can be switched off; the setting is stored on the server and applied every time the gateway starts. There is no switch in the web app yet; a Connections screen for managing tools and MCP servers is on the roadmap.
