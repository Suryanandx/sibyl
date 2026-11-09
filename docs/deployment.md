# Deployment

Sibyl runs as two processes:

- the **web app** (Next.js) on port 3000;
- the **gateway** (HTTP + WebSocket) on port 8787.

The gateway owns every credential and the database. The web app only knows the gateway's public WebSocket URL, which is compiled into it at build time.

## Checklist

- [ ] `OPENROUTER_API_KEY` set in the gateway's environment only.
- [ ] `SIBYL_OWNER_TOKEN` set to a long random value.
- [ ] `ALLOWED_ORIGINS` set to your exact web origin, such as `https://sibyl.example.com`.
- [ ] Web app built with `NEXT_PUBLIC_GATEWAY_WS_URL=wss://…`.
- [ ] HTTPS for the page and WSS for the gateway, terminated at a reverse proxy.
- [ ] `SIBYL_DATA_DIR` on persistent, backed-up storage.
- [ ] Spending caps: `SIBYL_BUDGET_DAILY_USD` and `SIBYL_BUDGET_MONTHLY_USD`, plus a credit limit on the OpenRouter key.
- [ ] `/healthz` monitored.

Browsers only allow microphone access on secure pages (HTTPS, or `localhost`), so voice mode needs HTTPS in production.

## Docker Compose

```bash
cp .env.example .env
# set OPENROUTER_API_KEY and SIBYL_OWNER_TOKEN
docker compose up --build
```

This builds `Dockerfile.gateway` and `Dockerfile.web` and starts:

| Service | Address |
|---|---|
| Web app | <http://localhost:3000> |
| Gateway WebSocket | `ws://localhost:8787` |
| Gateway health | <http://localhost:8787/healthz> |

Compose passes your `.env` to the gateway (or the file named by `OPEN_GPT_LIVE_ENV_FILE`), sets `NODE_ENV=production`, and sets `ALLOWED_ORIGINS` to `http://localhost:3000` unless you override it.

### Things to know about the images

- **The gateway URL is baked into the web image.** `NEXT_PUBLIC_GATEWAY_WS_URL` and the `NEXT_PUBLIC_VAD_*` settings are build arguments. Set them in the environment or `.env` before `docker compose build`, and rebuild after changing them.
- **Data lives in `/app/data`.** The gateway image sets `SIBYL_DATA_DIR=/app/data` and declares it as a volume. To keep conversations across rebuilds and make backups easy, mount a named volume or a host folder there, for example in a `docker-compose.override.yml`:

  ```yaml
  services:
    gateway:
      volumes:
        - sibyl-data:/app/data
  volumes:
    sibyl-data:
  ```

- **Keep the scout cache with the data.** The image runs as the unprivileged `node` user, so the default cache location (`/app/.model-scout.json`) is not writable and the scout would re-run on every start. Set `SCOUT_CACHE_FILE=/app/data/model-scout.json`.
- **The model allowlist** comes from `models.config.example.json`, copied to `/app/models.config.json`. Mount your own file there, or point `MODELS_CONFIG_FILE` at a mounted path.
- **MCP servers** are read from `/app/mcp.config.json` or the path in `SIBYL_MCP_CONFIG`. Stdio servers run inside the gateway container, so the commands they need (for example `npx`) must exist in the image. Remote (HTTP) servers need nothing extra.

The compose file also contains an optional `local-ai` profile for Ollama and Speaches. It is not supported in this release: the gateway image ships an OpenRouter model catalog, and live conversation needs an audio-native voice model. To experiment with a self-hosted OpenAI-compatible provider, see [configuration.md](configuration.md#using-a-different-openai-compatible-provider).

## Without Docker

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm start
```

`pnpm build` builds the gateway bundle (`apps/gateway/dist/server.cjs`) and the web app. `pnpm start` runs both with `NODE_ENV=production`. Build the web app with the production `NEXT_PUBLIC_GATEWAY_WS_URL` in the environment.

## Reverse proxy and WSS

Terminate TLS at a reverse proxy and forward WebSocket upgrades to the gateway. With Nginx, serving the web app at `/` and the gateway at `/gateway/`:

```nginx
server {
  listen 443 ssl;
  server_name sibyl.example.com;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
  }

  location /gateway/ {
    proxy_pass http://127.0.0.1:8787/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;
    access_log off;
  }
}
```

Then build the web app with:

```dotenv
NEXT_PUBLIC_GATEWAY_WS_URL=wss://sibyl.example.com/gateway/
```

and run the gateway with:

```dotenv
ALLOWED_ORIGINS=https://sibyl.example.com
```

The long `proxy_read_timeout` keeps quiet voice sessions from being cut off. The owner token travels as a `?token=` query parameter on the WebSocket URL, so turn off access logging for the gateway location (as above) or make sure your proxy doesn't record query strings.

Caddy handles WebSocket upgrades automatically:

```caddy
sibyl.example.com {
  handle_path /gateway/* {
    reverse_proxy 127.0.0.1:8787
  }
  reverse_proxy 127.0.0.1:3000
}
```

## Protecting the gateway

- **`SIBYL_OWNER_TOKEN`** is the sign-in. Without it, anyone who can reach the gateway can talk to it on your OpenRouter key. The web app asks for the token once and keeps it in that browser's local storage.
- **`ALLOWED_ORIGINS`** stops other websites from opening a connection from a visitor's browser. It is not authentication: clients that send no `Origin` header are allowed.
- **Budgets** limit the damage if the token leaks.
- Keep port 8787 off the public internet when you use a reverse proxy; bind it to localhost or a private network.

## Health check

```bash
curl http://127.0.0.1:8787/healthz
```

```json
{
  "status": "ok",
  "uptimeSeconds": 12,
  "connections": 1,
  "provider": "openrouter",
  "genUi": true,
  "realtimeStt": false,
  "tts": true
}
```

The response also includes a service name and version. The health check never calls a model provider and never exposes credentials. Every other HTTP path returns 404.

## Logs

The gateway writes one JSON object per line to stdout and stderr. Useful events:

| Event | Meaning |
|---|---|
| `gateway.started` | Listening, with the provider and default models |
| `models.loaded`, `models.scouted`, `models.applied` | The catalog in use and scout updates |
| `models.scout_failed` | The scout could not run; the config file is used |
| `session.connected`, `session.socket_error` | Connections |
| `latency.*`, `request.finished` | Per-request timings, ending in `Ms` |
| `stt.background_failed` | The background transcript failed; the turn continues |
| `tools.*`, `mcp.*` | Tool and MCP server installation |

Fields that look like credentials, audio, transcripts or message content are redacted. Use `sessionId` and `requestId` to follow one turn.

## Backups

Everything Sibyl stores is in `SIBYL_DATA_DIR/sibyl.db`. Stop the gateway (or use SQLite's online backup) and copy that file.

## After each deploy

A five-minute check in a real browser:

1. `curl /healthz` returns `"status": "ok"`.
2. The web app connects (after you enter the owner token).
3. **Typing:** a question that needs a visual returns text and a visual, and nothing is spoken.
4. **Tools:** "what's the weather in Lisbon?" shows a tool step and a correct answer.
5. **Push-to-talk:** hold the mic, ask a short question, release. The transcript appears once and Sibyl answers out loud.
6. **Hands-free:** tap the mic, wait for calibration, ask something. Sibyl answers after a short pause.
7. **Barge-in:** talk over a long answer. Sibyl stops within about half a second.
8. **History:** reload the page, open the conversation from the sidebar and continue it.

## Rolling back

Build images from a specific Git commit. To roll back, redeploy the last known-good gateway and web images together; they share the protocol, so mixing versions is not supported. Back up `sibyl.db` before upgrading in case a schema change needs reverting.
