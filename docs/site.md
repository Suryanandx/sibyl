# Website and docs site

The public site lives in `apps/site/`. It is plain static HTML, so any static host works (GitHub Pages, Netlify, Cloudflare Pages, an S3 bucket, nginx), and it makes no third-party requests: the font, images, video and search index are all served from the folder.

| Path | What it is |
| --- | --- |
| `index.html`, `site.css`, `site.js` | The landing page. `site.js` runs the theme toggle, the Products menu and the phone menu, the product index, install tabs, copy buttons, lazy video, the hero film's sound button, reveal-on-scroll, the printing receipt and the hero's contour shader. |
| `products/` | One page per product (Assistant, Meet, Slides, Studio, Agents), generated from `scripts/products.mjs` (below). |
| `docs/` | The docs site, generated from the repo's Markdown (below). `docs.css` and `docs.js` (search, "On this page") are hand-written; the `.html` pages and `search-index.json` are generated. |
| `assets/` | Font, brand marks, paintings, painted loops, app clips and screenshots (`assets/screens/`). |
| `scripts/build-docs.mjs`, `scripts/build-products.mjs` | The docs and product page generators. Both take the header and footer from `index.html` through `scripts/chrome.mjs`. |

## Preview locally

```bash
npx serve apps/site -l 3110
# or, without Node:
python3 -m http.server 3110 --directory apps/site
```

Open <http://localhost:3110> for the landing page, <http://localhost:3110/products/assistant.html> for a product page and <http://localhost:3110/docs/> for the docs.

## Deploy

The site is live at [opensibyl.world](https://opensibyl.world). Every push to `main` that touches `apps/site`, `docs` or the README runs `.github/workflows/site.yml`: it rebuilds the docs, fails if the committed pages are out of date, uploads the folder to a private S3 bucket, refreshes CloudFront and checks the live pages. AWS access is a short-lived role over GitHub OIDC; no keys are stored in GitHub. The bucket, CDN, certificate, DNS records at Hostinger and the deploy role are Terraform in `deploy/terraform/site` (see [its README](../deploy/terraform/README.md)).

Any other static host works too: publish the `apps/site` folder as the site root. All paths are relative, so it also works from a sub-path such as `https://<user>.github.io/sibyl/`.

## The docs site

Every page in `docs/` (not `docs/plans/`) becomes `apps/site/docs/<name>.html`, and the README becomes `docs/overview.html`. The same command also rebuilds the product pages. Regenerate after changing any Markdown, `scripts/products.mjs`, or the landing page's header or footer:

```bash
corepack pnpm --filter site run docs
```

(`pnpm docs` on its own is a built-in pnpm command, so the script runs with `run`.) The generated pages are committed, so hosting needs no build.

What the generator does:

- **Same header and footer as the landing page.** It copies them from `index.html` (between the `site:header` and `site:footer` comments) and rewrites their links for the docs folder, so the two never drift apart.
- **Sidebar groups**, in order: Get started · Using Sibyl · Agents · Knowledge & tools · Meetings & calls · Spaces · Automations · Teams & admin · Hosting & deployment · Enterprise · Reference. The list is `GROUPS` at the top of the script; a new `docs/*.md` that isn't listed lands in Reference, and a listed page that doesn't exist yet (such as `media`) is skipped.
- **Links.** Links between docs point at the generated pages, including `#anchors` (headings get GitHub-style ids). A link written as a bare file name (`realtime.md`) shows the page title. Links to other repo files (source, `LICENSE`, `docs/plans/`) go to GitHub. Images under `docs/assets/` (screenshots in `docs/assets/screens/` too) are copied to `apps/site/docs/assets/`, including the ones in the README's raw-HTML screenshot table. The copies are byte-identical, so git stores each image once.
- **Pages** have an "On this page" list (wide screens), previous and next links, a link to the Markdown source, code blocks with copy buttons, and styled tables. Mermaid blocks show as their source.
- **Search** runs in the browser over `search-index.json`: one entry per heading with its text. The index loads the first time you use the search box. Press `/` to jump to it.

Markdown is parsed with [`marked`](https://marked.js.org) (the only dependency, a dev dependency of `apps/site/package.json`).

## Product pages

Sibyl is a family of products in one install: **Sibyl Assistant**, **Sibyl Meet**, **Sibyl Slides**, **Sibyl Studio** and **Sibyl Agents**. Each has a page at `products/<slug>.html` with a plain headline, three to five "What you can do" blocks with real screenshots, **What it costs to run**, **Try it** (the quickstart) and links to its docs pages.

The content lives in `scripts/products.mjs`; the docs home lists the same products from there. Costs on these pages are only numbers that were measured, each with its source (a docs page, or Settings → Usage on the screenshot install). Sibyl Phone has no page until it has been tested on a real phone line; the landing page says it is coming soon.

## Landing page

- **Hero and product grid.** The hero says what Sibyl is: open-source alternatives to the tools you pay for every month, so you pay only for the AI you use. Below it, a grid links the five product pages, with a line saying a new product joins every week.
- **Header.** A **Products** menu lists the five products, with one line each. Next to them are the editions: Sibyl self-hosted (free), Sibyl hosted (coming soon) and Agent Serve by valnoraelric.com (talk to us). It follows the disclosure pattern. The button says whether it is open; Esc closes it and returns focus, and so does a click outside. On a phone the menu button opens the same links, and Products expands in place.
- **Product sections** follow the app's rail: Chat, Agents, Meetings, Spaces, Library, Automations, and Settings and control. Each area has a heading, a few sentences, a painting, a screenshot or a real clip of the app, and a link to its docs page. Agent computers, the side panel, Media and Meetings show screenshots of the real app. Phone lines are labelled **Coming soon**.
- **Every "Docs" link** goes to the docs site.

## Content rules

- Facts only, taken from the README and the pages in `docs/`.
- Every number in the numbers row is checked against the code and the README:
  - **1 key to start**: only `OPENROUTER_API_KEY` is required (README, Configuration).
  - **MIT**: `LICENSE`.
  - **0 telemetry**: the gateway, web app and packages contain no analytics or telemetry calls; Presenton's telemetry was removed from Slides (`apps/slides/UPSTREAM.md`). Next.js's own build-time telemetry is a separate CLI setting.
  - **4 model presets**: `STRATEGIES` in `apps/gateway/src/scout.ts` (cheapest, balanced, fastest, best).
- No invented customers, testimonials, download counts or prices. Self-hosted is free. Hosted plans (Free, Pro, Team; bring your own key, optional AI credits) show "Coming soon". Agent Serve (enterprise, by valnoraelric.com) is always "Talk to us". No e-mail addresses on the page.

## Design

- Colours are the app's tokens from `apps/web/app/globals.css`. No gradients, no purple. Light and dark follow the system and can be switched with the toggle (saved in `localStorage`, shared by the landing page and the docs).
- Plain and quiet: hairline dividers instead of cards, one main action per section, small supporting text.
- Buttons are boxed: 6px radius, 1px borders, solid ink for the main action and outlined for the rest.
- Type is **Archivo** (SIL Open Font License, licence in `assets/fonts/OFL.txt`), self-hosted as the variable `wght` font (Latin and Latin Extended subsets from `@fontsource-variable/archivo` 5.3.0). Headings and body use weight 300 with slight negative tracking; labels and buttons use 450–500. Code stays monospace.
- The logo is the app's mask (`assets/brand/sibyl-mark-mask.png`) with the same ribbon trace as `apps/web/components/SibylLoader.tsx`.
- Motion respects `prefers-reduced-motion`: videos show their poster with controls, and the mark's trace stops.

## Paintings

All made through OpenRouter with one shared style prompt: a refined, finished oil painting with painterly brushwork, soft light, generous space, and the Sibyl palette (warm off-whites, oat, raw umber, ink, sage, grey-green), with no text, logos or realistic faces.

**Choosing the model.** One test prompt (the hero landscape at 2K) went to each candidate:

| Model | Result | Cost (USD) |
|---|---|---|
| `google/gemini-3-pro-image` | Finished painting, paint edge to edge | 0.139 |
| `google/gemini-nano-banana-2.1` | Painterly, but left a raw linen border | 0.053 |
| `google/gemini-3.1-flash-image` | Painterly, but left a raw linen border | 0.101 |
| `openai/gpt-5.4-image-2`, `openai/gpt-5-image` | Failed at the provider (502) | 0 |

`google/gemini-3-pro-image` made all 16 paintings, at about $0.139 each (**$2.22** in all):

- On the page: horizon, voice, channels, wires, key, journals, valley, seedling, commons, lighthouse and easel.
- Replaced by real screenshots and removed: `computer`, `media` and `sidepanel`. Not shipped: `tools`, which was never used, and `meeting`.

The earlier photographic set (`google/gemini-3.1-flash-image`, about $0.67) was replaced.

Paintings are served as WebP at 960 and 1920 px wide and lazy-loaded.

## Painted loops

Two paintings move: the landscape (clouds and grass), which opened the page before the film and is kept in `assets/video/`, and the curtain room in **Talk or type**. Both were made with `google/veo-3.1-lite` through `POST /api/v1/videos` (image-to-video, 8 s, 1080p, no audio). The painting is used as both the first and the last frame, so the clip loops without a seam. Each cost **$0.40** (as reported by OpenRouter). They are re-encoded to 1280 px VP9 WebM (about 0.6–0.8 MB) with an H.264 MP4 fallback. The poster (the painting itself) shows first. The hero clip starts only after the page has loaded, and every clip plays only while it is on screen.

## The hero film and the product demos

The landing page opens with **Sibyl in one minute** (`assets/video/intro-film.*`): a 16:9 film made from real product screens, with an AI-generated male voiceover (OpenAI `gpt-audio` through OpenRouter) and AI-generated music (`google/lyria-3-pro-preview`). The web copies are 1280 × 720 H.264 MP4 and VP9 WebM (about 2.5 and 2.1 MB) with a WebP poster, and `intro-film.vtt` holds captions made from the script's own timings. It plays muted while it is on screen; **Sound on** restarts it with the voiceover. The caption under it says the voice and music are AI-generated.

Each product page opens with a short demo recorded live from the app (`assets/video/demo-<product>.*`, 960 px MP4 and WebM, 0.2–1.1 MB, with a poster), and the matching docs page shows the same recording as a GIF (`docs/assets/demo-<product>.gif`, 720 px, 10 fps, 0.6–3.4 MB). They were recorded with Playwright `recordVideo` against a local install of the current code, with real OpenRouter models, and waiting is sped up, which the captions say.

## App clips and screenshots

Recorded on 2026-11-10 from a fresh local install of the current code, which has the grouped rail (empty data folder, `MODELS_CONFIG_FILE=models.config.example.json`, "Continue without an account"). Each was captured with headless Chromium (Playwright `recordVideo`) and encoded with ffmpeg to H.264 MP4 and VP9 WebM, 1200 px wide, 24 fps:

- `clip-chart`: a chart answer in dark mode (Visual answers). The wait while the model thinks is fast-forwarded, and the caption says so.
- `clip-agents`: building an agent from the Research template (Agents you build).
- `clip-knowledge`: making a knowledge base from four of Sibyl's own docs and searching it (Knowledge).
- `clip-onboard`: stepping through first-run setup (Getting started).

Screenshots of Skills, Integrations and Models settings are WebP at 1280 × 800.

### Screenshots of the real app (`assets/screens/`, `docs/assets/screens/`)

Most were retaken on 2026-11-10 after the design change to boxed corners, from a local install of the current code with a local test owner. The content was made through the app with real OpenRouter models: chats with a chart and an image, an agent (Research Dot) that used its computer, a five-slide deck from the Slides engine (Docker), and meetings with notes from the realtime layer (LiveKit). A few leftover test chats were hidden in the history while capturing; nothing else on screen was changed. They are 1600 × 1000 (meetings 1440 × 900, the slide editor 1600 × 1218): PNG for the README and docs, WebP for the site.

Six images are from the earlier set: the Inbox with a routine waiting for approval, the knowledge base and the knowledge answer, the meeting room, onboarding and the getting-started checklist.

The earlier set was taken on 2026-11-10 from a fresh install of the current code (grouped rail, light mode unless noted) with a temporary data folder and a local test owner, "Alex Morgan". The content was made through the app itself with real OpenRouter models: four agents from the templates (one with a computer, running the `sibyl-computer:1.64.1` image), a knowledge base of six of Sibyl's own docs, chats with a chart, a knowledge answer and an agent browsing Hacker News, three images and a short video in Create mode, a five-slide deck from the Slides engine (Docker), and a routine waiting for approval in the Inbox. The whole run cost **$1.51** on OpenRouter (Settings → Usage), of which $1.08 was the model scout's first catalog check. The meeting screenshots come from the realtime test install of the same day (LiveKit dev server, a fake camera and microphone).

Captured with headless Chromium (Playwright) at 1440 × 900, device scale 2, then scaled to 1600 px wide: palette PNG for the README and docs (`docs/assets/screens/`, about 1.6 MB for 19 images), WebP for the site (`apps/site/assets/screens/`, about 0.8 MB). Test e-mail addresses are hidden.

## Page weight

The first paint needs the HTML, CSS, JS, font and the film's poster: about 0.1 MB. The film (2.1 MB WebM) starts only after the page has loaded and while it is on screen. Everything else loads as you scroll. A docs page is the HTML (20–60 KB) plus the shared CSS, JS and font; the search index (about 220 KB) loads only when you search.

Total generation cost for the current assets: about **$3.02** ($2.22 paintings, $0.80 loops), plus **$1.51** for the screenshot run. The comparison tests and the replaced photo set add about $0.96.
