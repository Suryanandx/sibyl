# Sibyl Slides engine API

The deck engine is the FastAPI server in `servers/fastapi`. The Sibyl gateway
calls it server-to-server at **`SIBYL_SLIDES_URL`**:

| Setup | `SIBYL_SLIDES_URL` | Editor (browser) |
| --- | --- | --- |
| `pnpm slides:dev` | `http://localhost:8000` | `http://localhost:3000/slides/...` (via the web app) or `http://localhost:3100/slides/...` (direct) |
| `docker compose` | `http://slides:8000` | `http://localhost:3000/slides/...` |

The same endpoints are also reachable from the browser through the web app at
`/slides/api/v1/...` (the Slides web server forwards them to the engine).

## Auth

If `SIBYL_OWNER_TOKEN` is set, every endpoint except the health check requires
it, compared in constant time:

- `Authorization: Bearer <SIBYL_OWNER_TOKEN>` (gateway, scripts), or
- the cookie `sibyl_slides_token=<token>` (path `/slides`). The editor sets it
  from `localStorage["sibyl.ownerToken"]`, the key the Sibyl chat sign-in uses,
  so a signed-in browser opens decks without signing in again.

Without a token configured the engine is open: keep port 8000 private (compose
does not publish it; dev binds 127.0.0.1).

## Endpoints kept stable

### `GET /healthz` (also `GET /api/v1/sibyl/health`) — public

```json
{ "ok": true, "service": "sibyl-slides", "ownerLogin": false,
  "model": "deepseek/deepseek-v4.1-flash", "imageProvider": null }
```

### `POST /api/v1/ppt/presentation/generate` — generate and export a deck

Synchronous: returns when the deck is generated **and** exported (about
1-3 minutes for 5-15 slides). Use `/generate/async` below for progress.

```json
{
  "content": "What the deck is about (prompt, notes or a document's text)",
  "n_slides": 5,
  "language": "English",
  "template": "sibyl-graphite",
  "export_as": "pptx",
  "instructions": "optional extra guidance",
  "tone": "default",
  "verbosity": "standard",
  "include_title_slide": true,
  "include_table_of_contents": false,
  "web_search": false
}
```

Only `content` is required. `n_slides` omitted = model decides. `language`
omitted = auto-detect. `export_as`: `pptx` (default) or `pdf`. `template`:
`sibyl-graphite` (default), `sibyl-night`, `sibyl-editorial`, `sibyl-data`;
upstream names such as `general` are accepted as aliases. `tone`: `default`,
`casual`, `professional`, `funny`, `educational`, `sales_pitch`. `verbosity`:
`concise`, `standard`, `text-heavy`.

Response `200`:

```json
{
  "presentation_id": "6ca6c8c1-ea9d-4152-9617-41ff349a87e3",
  "path": "/app_data/exports/pptx/Deck-title_….pptx",
  "edit_path": "/slides/presentation?id=6ca6c8c1-ea9d-4152-9617-41ff349a87e3",
  "download_path": "/app_data/exports/pptx/Deck-title_….pptx",
  "cost_usd": 0.0202,
  "estimated": false
}
```

- `cost_usd`: what this generation actually cost in USD, summed from
  OpenRouter's usage accounting (`usage.cost`) over every model call made for
  it (outline, structure, slides, retries). It is also added to the
  presentation's `cost_usd` column. `estimated: true` means some calls
  reported no cost, so the figure is a lower bound.

- `path`: the exported file on the engine's disk (an absolute filesystem path
  in dev, under `/app_data` in Docker). Prefer `download_path`.
- `download_path`: `GET {SIBYL_SLIDES_URL}{download_path}` (with the owner
  token) downloads the file; browsers can use `/slides{download_path}`.
- `edit_path`: the editor, a browser path on the Sibyl origin (see "Opening a
  deck in the editor").

Errors: `400` invalid request (e.g. unknown template), `401` owner token
missing/wrong, `500` generation failed (provider error, missing
`OPENROUTER_API_KEY`).

### `POST /api/v1/ppt/presentation/generate/async` + `GET /api/v1/ppt/presentation/status/{task_id}`

Same body as `/generate`. Returns a task `{ "id", "status": "pending", "message", "data": {...} }`.
Poll the status endpoint; when `status` is `completed`, `data` holds the same
`presentation_id`, `path`, `edit_path`, `cost_usd` and `estimated` fields. `failed` carries an error message.

### `GET /api/v1/ppt/presentation/all` — list decks

Array of decks (`id`, `title`, `created_at`, `updated_at`, `n_slides`,
`language`, `slides` (first slide, for a thumbnail), …), newest first.

### `GET /api/v1/ppt/presentation/{id}` — one deck with all slides

`{ id, title, language, n_slides, layout, slides: [{ id, index, layout, content, speaker_note, … }], … }`.
`404` if unknown.

### `POST /api/v1/ppt/presentation/{id}/export` — export an existing deck

Body `{ "export_as": "pptx" }` or `{ "export_as": "pdf" }`. Response as for
`/generate` (`presentation_id`, `path`, `edit_path`, `download_path`). Use it
to re-export after edits in the editor.

### `GET /api/v1/sibyl/config` — active model and price (Sibyl)

```json
{ "model": "deepseek/deepseek-v4.1-flash",
  "pricing": { "prompt": 5.1e-08, "completion": 5.67e-07 },
  "imageProvider": null, "costAccounting": "openrouter-usage" }
```

The one source of truth for the deck model: the gateway uses it for cost
estimates and approval cards. `pricing` is USD per token from OpenRouter's
model list (cached six hours), or `null` when unknown.

### `GET /api/v1/ppt/presentation/{id}/thumbnail` — first-slide PNG (Sibyl)

A 640 px wide PNG of slide 1, rendered by the export runtime (a PDF export,
page 1 rasterized) and cached in `APP_DATA_DIRECTORY/thumbnails`. The cache key
is a fingerprint of the deck layout and slide 1, so edits to slide 1 render a
fresh one. The first call takes as long as a small PDF export; later calls are
instant. `404` for an unknown deck.

### `DELETE /api/v1/ppt/presentation/{id}` — delete a deck (`204`)

### `GET /api/v1/ppt/template/all` — template families

```json
{ "items": [ { "id": "sibyl-graphite", "name": "Sibyl Graphite", "description": "…",
  "layout_count": 16, "thumbnail": "/app_data/templates/sibyl-graphite/static/thumbnail.png",
  "preview_url": "http://<host>/slides/template-preview?templateV2Id=sibyl-graphite",
  "is_default": true } ] }
```

`thumbnail` is an engine path (`{SIBYL_SLIDES_URL}{thumbnail}`, or
`/slides{thumbnail}` in the browser).

The full OpenAPI schema is at `GET /openapi.json` (owner token required).

## Opening a deck in the editor

```
/slides/presentation?id=<presentation_id>[&space=<library space id>]
```

on the Sibyl app origin (the web app proxies `/slides/*` to the Slides web
server). `space` is optional: the editor's back control returns to
`/library/slides?space=<space>` (else `/library/slides`). The export renderer
is `/slides/pdf-maker?id=<id>` (used internally by exports).

## Routing contract

The engine UI serves only `/slides/presentation`, `/slides/pdf-maker`,
`/slides/template-preview`, its assets and `/slides/api/*`. Every other
`/slides/*` page (and unknown routes) answers `307` to
`${SIBYL_APP_URL}/library/slides`. Links in the editor (rail, back) go to the
app, in the order of the app's rail: Chat `/`, History `/?panel=history`,
Slides `/library/slides`, Routines `/routines`, Inbox `/inbox`, Integrations
`/integrations`, Settings `/settings`.
They are relative when the editor is reached through the app's proxy, and use
`SIBYL_APP_URL` (default `http://localhost:3000`) when it is opened directly on
the Slides origin.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | — | The only key needed. Never written to the engine's database. |
| `SIBYL_SLIDES_MODEL` | `deepseek/deepseek-v4.1-flash` | Deck model on OpenRouter (cheap, JSON-schema capable, 1M context). Good alternatives: `google/gemini-2.5-flash-lite`, `qwen/qwen3.8-flash`, `openai/gpt-5-mini`. |
| `SIBYL_SLIDES_IMAGE_PROVIDER` | empty (no image generation) | `pexels` / `pixabay` (free stock, needs `PEXELS_API_KEY` / `PIXABAY_API_KEY`), `gpt-image-2`, `gpt-image-1.5` (`OPENAI_API_KEY`), `gemini_flash`, `nanobanana_pro` (`GOOGLE_API_KEY`), `comfyui` (`COMFYUI_URL`), `open_webui`, `openai_compatible` (`OPENAI_COMPAT_IMAGE_*`). Without one, image slots keep a neutral placeholder and icons still work (local icon search). |
| `SIBYL_OWNER_TOKEN` | empty | Owner token (see Auth). |
| `SIBYL_APP_URL` | `http://localhost:3000` | The Sibyl app, for editor links when opened directly. |
| `APP_DATA_DIRECTORY` | `apps/slides/data` (dev), `/app_data` (Docker volume `slides-data`) | Database, exports, uploads, images. |
| `SIBYL_SLIDES_API_PORT` / `SIBYL_SLIDES_WEB_PORT` | `8000` / `3100` | Engine / web ports. |
| `SIBYL_SLIDES_HOST` | `127.0.0.1` (dev), `0.0.0.0` (Docker) | Bind address. |
| `SIBYL_SLIDES_CORS_ORIGINS` | empty | Extra CORS origins for direct browser calls to the engine (not needed normally). |

`SIBYL_SLIDES_MODEL` and `SIBYL_SLIDES_IMAGE_PROVIDER` are applied on every
start. The engine has no settings screen: models and keys come from the
environment.
