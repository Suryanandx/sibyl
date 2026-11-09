# Upstream: Presenton

Sibyl Slides is derived from [Presenton](https://github.com/presenton/presenton)
(Apache-2.0). `LICENSE` is Presenton's license; `NOTICE` keeps its third-party
notices with a Sibyl header.

| | |
| --- | --- |
| Upstream repository | https://github.com/presenton/presenton |
| Tag | `v0.9.12-beta` (latest web release on 2026-11-09; `electron-*` tags are desktop builds) |
| Commit | `93b9dcf947f70ae107b779b51dd3c491e736748a` |
| Export runtime | `@presenton/export-core` `v1.0.51` (`presentationExportVersion` in `package.json`, installed by `scripts/sync-presentation-export.cjs`) |

## Not imported

Electron desktop app, README assets, docs, upstream CI and deploy files
(`.github`, `.do`), upstream Dockerfiles, nginx config, compose file, `start.js`
(replaced by `start.mjs`), Cypress tests, the prebuilt FastEmbed model cache,
`layouts.json`, all 16 upstream slide templates.

## Removed after import

- Telemetry: Mixpanel SDK and token, telemetry-status route, usage-analytics
  settings, Sentry init and breadcrumbs. The upstream call sites that named
  product events now call inert no-ops (`servers/nextjs/utils/mixpanel.ts`);
  no analytics code or network call remains. Bundled-library telemetry is
  switched off (`MEM0_TELEMETRY`, `HF_HUB_DISABLE_TELEMETRY`,
  `NEXT_TELEMETRY_DISABLED`, `ANONYMIZED_TELEMETRY`, `DO_NOT_TRACK`).
- Hosted-service upsells: Presenton Cloud provider, OAuth login and request
  proxy, community gallery, GitHub-stars/Discord header, MCP server.
- Presenton accounts (login, admin panel, API keys UI): replaced by the Sibyl
  owner token (`SIBYL_OWNER_TOKEN`). The account tables stay in the database
  schema so upstream migrations keep working; auth runs in `DISABLE_AUTH` mode.
- Screens other than the editor/viewer: home, onboarding wizard, dashboard,
  settings, upload wizard, outline, template library, custom-template builder,
  document preview. The deck library lives in the Sibyl app (`/library/slides`).

- Assets trimmed (v0.4): the vendored fonts went from 95 families (~74 MB) to
  a curated 12 (~11 MB: Inter, DM Sans, Lato, Montserrat, Open Sans, Poppins,
  Roboto, Lora, Playfair Display, Source Serif 4, JetBrains Mono, Caveat);
  `components/slide-editor/text/local-fonts.ts` maps every removed family to
  Inter (`REMOVED_FONT_FAMILIES`) and `assets/fonts.json` lists only the kept
  ones. Icons keep the `regular`, `bold` and `fill` weights (thin/light map to
  regular, duotone to fill: `utils/icon_weights.py`); `assets/icons.json`
  keeps only names and tags (it is only read to rebuild the icon index) and
  `assets/icons-vectorstore.json` is minified (same float32 values). The icon
  search needs the vectorstore, so it stays bundled.

## Sibyl changes (main files)

- `servers/fastapi/utils/sibyl.py`: env defaults, OpenRouter seeding, owner
  token, editor paths. `api/middlewares.py`: owner-token middleware.
- `servers/nextjs/proxy.ts`, `next.config.mjs` (basePath `/slides`),
  `components/sibyl/*` (shell, rail, sign-in, emblem loader, shared UI),
  `app/sibyl.css` (Sibyl tokens), `tailwind.config.ts` (token mapping).
- `templates/build_sibyl_templates.py`: the four Sibyl template families.
- `servers/fastapi/utils/sibyl_thumbnail.py` + `GET /presentation/{id}/thumbnail`
  in `api/v1/ppt/endpoints/presentation.py`: cached first-slide PNGs.
- `servers/fastapi/utils/llm_utils.py`: structured calls retry when the model
  streams JSON that does not parse.
- `start.mjs`, `../../Dockerfile.slides`.

## Updating from upstream

Diff upstream between the recorded commit and the new tag, port the changes to
`servers/` by hand (the tree has been restructured too much for a clean
merge), keep the removals above, bump `presentationExportVersion` if upstream
did, and record the new tag and commit here.
