#!/usr/bin/env node
/**
 * Builds the docs site (apps/site/docs/) from the repo's Markdown.
 *
 *   corepack pnpm --filter site docs
 *
 * - Every docs/*.md (not docs/plans/) becomes docs/<name>.html; README.md becomes docs/overview.html.
 * - Header and footer are taken from apps/site/index.html (between the site:header / site:footer
 *   markers), so the landing page and the docs never drift apart.
 * - Links between docs point at the generated pages; links to other repo files go to GitHub.
 * - docs/search-index.json feeds the client-side search (no third-party service).
 * The output is committed, so hosting stays build-free.
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, copyFileSync, rmSync, statSync } from "node:fs";
import { join, posix, basename } from "node:path";
import { Marked } from "marked";
import { SITE, REPO, GITHUB, esc, chrome, head } from "./chrome.mjs";
import { PRODUCTS } from "./products.mjs";

const OUT = join(SITE, "docs");

/** Sidebar groups, in order. Pages that exist in docs/ but are not listed land in Reference. */
const GROUPS = [
  ["Get started", ["overview", "getting-started", "navigation"]],
  ["Using Sibyl", ["voice", "generative-ui", "side-panel", "tools", "models-and-costs", "browser-support"]],
  ["Agents", ["agents", "agent-computers", "slack-and-teams"]],
  ["Knowledge & tools", ["knowledge", "skills-and-plugins", "integrations", "secrets"]],
  ["Meetings & calls", ["meetings", "realtime"]],
  ["Spaces", ["slides", "media"]],
  ["Automations", ["monitors"]],
  ["Teams & admin", ["admin"]],
  ["Hosting & deployment", ["deployment", "hosting", "configuration", "troubleshooting"]],
  ["Enterprise", ["enterprise"]],
  ["Reference", ["architecture", "protocol", "site"]]
];

/* ── Sources ─────────────────────────────────────────────────────────── */

const docFiles = readdirSync(join(REPO, "docs")).filter((f) => f.endsWith(".md"));
const sources = new Map(); // slug -> repo path
sources.set("overview", "README.md");
for (const f of docFiles) sources.set(basename(f, ".md"), `docs/${f}`);

/** Page titles (each source's first # heading), used for sidebar labels and for links written as a bare file name. */
const titles = new Map(
  [...sources].map(([slug, path]) => [slug, slug === "overview" ? "Overview" : (readFileSync(join(REPO, path), "utf8").match(/^#\s+(.+)$/m)?.[1] ?? slug).replace(/[`*_]/g, "").trim()])
);

const listed = new Set(GROUPS.flatMap(([, slugs]) => slugs));
const extra = [...sources.keys()].filter((s) => !listed.has(s)).sort();
if (extra.length) GROUPS.find(([g]) => g === "Reference")[1].push(...extra);
const groups = GROUPS.map(([name, slugs]) => [name, slugs.filter((s) => sources.has(s))]).filter(([, s]) => s.length);
const order = groups.flatMap(([, s]) => s);

/* ── Shared header/footer from the landing page (see chrome.mjs) ───── */

const { header, footer } = chrome("docs");

/* ── Markdown ────────────────────────────────────────────────────────── */

const stripTags = (s) => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
/** GitHub-style heading slug, so existing #anchors in the docs keep working. */
const slugify = (text) => text.toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");

const copied = new Set();
/** Rewrite a link found in `fromPath` (a repo path) for the generated page. */
function rewriteLink(href, fromPath) {
  if (!href || /^(https?:|mailto:|#)/.test(href)) return href;
  const [pathPart, hash] = href.split("#");
  const target = posix.normalize(posix.join(posix.dirname(fromPath), pathPart));
  const suffix = hash ? `#${hash}` : "";
  if (target === "README.md") return `overview.html${suffix}`;
  const m = target.match(/^docs\/([^/]+)\.md$/);
  if (m && sources.has(m[1])) return `${m[1]}.html${suffix}`;
  if (target.startsWith("docs/assets/") && existsSync(join(REPO, target))) {
    mkdirSync(join(OUT, "assets"), { recursive: true });
    copyFileSync(join(REPO, target), join(OUT, "assets", basename(target)));
    copied.add(basename(target));
    return `assets/${basename(target)}${suffix}`;
  }
  const isDir = pathPart.endsWith("/") || (existsSync(join(REPO, target)) && statSync(join(REPO, target)).isDirectory());
  return `${GITHUB}/${isDir ? "tree" : "blob"}/HEAD/${target.replace(/\/$/, "")}${suffix}`;
}

function render(slug) {
  const path = sources.get(slug);
  let md = readFileSync(join(REPO, path), "utf8");
  if (slug === "overview") {
    // The README opens with a centred HTML logo block and a link row; the docs page has its own header.
    md = md.replace(/^[\s\S]*?(?=^Sibyl is )/m, "# Overview\n\n");
  }
  const toc = [];
  const used = new Map();
  const sections = []; // for search: { id, heading, text }
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      heading({ tokens, depth }) {
        const inner = this.parser.parseInline(tokens);
        const text = stripTags(inner);
        let id = slugify(text) || "section";
        const n = used.get(id) ?? 0;
        used.set(id, n + 1);
        if (n) id = `${id}-${n}`;
        if (depth === 2 || depth === 3) toc.push({ id, text, depth });
        if (depth <= 3) sections.push({ id, heading: text, text: "" });
        if (depth === 1) return `<h1 id="${id}">${inner}</h1>\n`;
        return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true" tabindex="-1">#</a>${inner}</h${depth}>\n`;
      },
      link({ href, title, tokens }) {
        const url = rewriteLink(href, path);
        const ext = /^https?:/.test(url) && !url.startsWith(GITHUB);
        let inner = this.parser.parseInline(tokens);
        // "see [realtime.md](realtime.md)" reads better on the web as "see Realtime calls (LiveKit)".
        const page = url.match(/^([\w-]+)\.html(?:#.*)?$/)?.[1];
        if (page && titles.has(page) && /^(<code>)?(docs\/)?[\w-]+\.md(#[\w-]*)?(<\/code>)?$/.test(inner)) inner = esc(titles.get(page));
        return `<a href="${esc(url)}"${title ? ` title="${esc(title)}"` : ""}${ext ? ' rel="noopener"' : ""}>${inner}</a>`;
      },
      image({ href, title, text }) {
        const url = rewriteLink(href, path);
        return `<img src="${esc(url)}" alt="${esc(text)}"${title ? ` title="${esc(title)}"` : ""} loading="lazy" decoding="async">`;
      },
      code({ text, lang }) {
        const language = (lang || "").split(/\s/)[0];
        const label = language === "mermaid" ? "Diagram source (Mermaid)" : language;
        return `<div class="codeBlock">${label ? `<span class="codeLang">${esc(label)}</span>` : ""}<pre><code${language ? ` class="language-${esc(language)}"` : ""}>${esc(text)}</code></pre><button type="button" class="btn btnLine btnXs copy" aria-label="Copy code">Copy</button></div>\n`;
      },
      html({ text }) {
        // Raw HTML in the Markdown (rare): keep simple tags (the README's screenshot table),
        // drop layout wrappers, and point image paths at the copied files.
        if (/<\/?(p|picture|source|div)\b/i.test(text)) return "";
        return text.replace(/\b(src|href)="([^"]*)"/g, (m, attr, url) => `${attr}="${esc(rewriteLink(url, path))}"`);
      }
    }
  });
  let html = marked.parse(md);
  html = html.replace(/<table>/g, '<div class="tableWrap" tabindex="0" role="region" aria-label="Table"><table>').replace(/<\/table>/g, "</table></div>");

  // Search text per section: split the rendered HTML at headings.
  const parts = html.split(/<h[1-3] id="([^"]+)"[^>]*>/);
  for (let i = 1; i < parts.length; i += 2) {
    const sec = sections.find((s) => s.id === parts[i]);
    const body = (parts[i + 1] ?? "")
      .replace(/^[\s\S]*?<\/h[1-6]>/, "")
      .replace(/<span class="codeLang">[\s\S]*?<\/span>|<button[\s\S]*?<\/button>|<a class="anchor"[^>]*>#<\/a>/g, " ")
      .replace(/<[^>]+>/g, " ");
    if (sec) sec.text = stripTags(body).replace(/\s+/g, " ").trim().slice(0, 700);
  }
  const title = (md.match(/^#\s+(.+)$/m)?.[1] ?? slug).replace(/[`*_]/g, "").trim();
  const firstPara = stripTags(html.match(/<p>([\s\S]*?)<\/p>/)?.[1] ?? "").replace(/\s+/g, " ").trim();
  return { slug, path, title, html, toc, sections, description: firstPara.slice(0, 200) };
}

/* ── Page shell ──────────────────────────────────────────────────────── */

function sidebar(current) {
  const items = groups
    .map(([name, slugs]) => {
      const links = slugs
        .map((s) => `<li><a href="${s}.html"${s === current ? ' aria-current="page"' : ""}>${esc(pages.get(s).title)}</a></li>`)
        .join("");
      return `<li><p class="sideHead">${esc(name)}</p><ul>${links}</ul></li>`;
    })
    .join("");
  return `<nav class="docsNav" aria-label="Documentation"><ul>${items}</ul></nav>`;
}

const searchBox = `<div class="docsSearch" role="search">
  <label class="sr" for="docs-search">Search the docs</label>
  <input id="docs-search" type="search" placeholder="Search the docs" autocomplete="off" spellcheck="false" aria-controls="docs-search-results" aria-expanded="false" />
  <ul id="docs-search-results" class="searchResults" role="listbox" aria-label="Search results" hidden></ul>
</div>`;

function shell({ title, description, body, slug }) {
  return `<!doctype html>
<html lang="en">
${head({ title: `${title} · Sibyl docs`, description, generatedFrom: `apps/site/scripts/build-docs.mjs from ${slug === "index" ? "docs/" : sources.get(slug)}`, extraCss: ["docs.css"], extraJs: ["docs.js"] })}
<body class="docsBody">
  <a class="skip" href="#main">Skip to content</a>
${header}
${body}
${footer}
</body>
</html>
`;
}

function pageBody(p) {
  const i = order.indexOf(p.slug);
  const prev = i > 0 ? pages.get(order[i - 1]) : null;
  const next = i < order.length - 1 ? pages.get(order[i + 1]) : null;
  const group = groups.find(([, s]) => s.includes(p.slug))?.[0] ?? "";
  const toc = p.toc.length
    ? `<aside class="docsToc" aria-labelledby="toc-title"><p class="tocTitle" id="toc-title">On this page</p><ul>${p.toc
        .map((t) => `<li class="d${t.depth}"><a href="#${t.id}">${esc(t.text)}</a></li>`)
        .join("")}</ul></aside>`
    : `<aside class="docsToc" aria-hidden="true"></aside>`;
  const source = `${GITHUB}/blob/HEAD/${p.path}`;
  return `<div class="wrap docsWrap">
  <div class="docsSide">
    ${searchBox}
    <details class="docsMenu">
      <summary>Docs menu <span class="muted">· ${esc(p.title)}</span></summary>
      ${sidebar(p.slug)}
    </details>
    <div class="docsMenuWide">${sidebar(p.slug)}</div>
  </div>
  <main id="main" class="docsMain">
    <p class="crumb"><a href="index.html">Docs</a> <span aria-hidden="true">/</span> ${esc(group)}</p>
    <article class="prose">
${p.html}
    </article>
    <p class="editLink"><a href="${source}">View the source of this page on GitHub</a></p>
    <nav class="pager" aria-label="Previous and next page">
      ${prev ? `<a class="prev" href="${prev.slug}.html"><span>Previous</span>${esc(prev.title)}</a>` : "<span></span>"}
      ${next ? `<a class="next" href="${next.slug}.html"><span>Next</span>${esc(next.title)}</a>` : "<span></span>"}
    </nav>
  </main>
  ${toc}
</div>`;
}

function indexBody() {
  const cards = groups
    .map(
      ([name, slugs]) => `<section class="docGroup">
      <h2>${esc(name)}</h2>
      <ul>${slugs
        .map((s) => {
          const p = pages.get(s);
          return `<li><a href="${s}.html">${esc(p.title)}</a><p>${esc(p.description)}</p></li>`;
        })
        .join("")}</ul>
    </section>`
    )
    .join("\n");
  return `<main id="main" class="wrap docsHome">
  <p class="eyebrow">Documentation</p>
  <h1>Sibyl docs</h1>
  <p class="sectionLede">How to set up, use, extend and host Sibyl. Start with <a class="link" href="getting-started.html">Getting started</a>, or search.</p>
  <p class="sectionLede">Sibyl is a family of open-source products that run in one install and work together: ${PRODUCTS.map((p) => `<a class="link" href="../products/${p.slug}.html">${esc(p.name)}</a>`).join(", ").replace(/, ([^,]*)$/, " and $1")}. Each product page links to its docs below.</p>
  <div class="homeSearch">${searchBox}</div>
  <div class="docGroups">
${cards}
  </div>
</main>`;
}

/* ── Build ───────────────────────────────────────────────────────────── */

rmSync(join(OUT, "assets"), { recursive: true, force: true });
for (const f of existsSync(OUT) ? readdirSync(OUT) : []) if (f.endsWith(".html") || f === "search-index.json") rmSync(join(OUT, f));
mkdirSync(OUT, { recursive: true });

const pages = new Map();
for (const slug of order) pages.set(slug, render(slug));

for (const p of pages.values()) {
  writeFileSync(join(OUT, `${p.slug}.html`), shell({ title: p.title, description: p.description, body: pageBody(p), slug: p.slug }));
}
writeFileSync(
  join(OUT, "index.html"),
  shell({ title: "Documentation", description: "How to set up, use, extend and host Sibyl, the open-source AI assistant you host yourself.", body: indexBody(), slug: "index" })
);

const index = [];
for (const p of pages.values()) {
  for (const s of p.sections) index.push({ p: p.title, h: s.heading, u: `${p.slug}.html${s.heading === p.title ? "" : `#${s.id}`}`, x: s.text });
}
writeFileSync(join(OUT, "search-index.json"), JSON.stringify(index));

console.log(`docs: ${pages.size} pages, ${index.length} search entries, ${copied.size} images${extra.length ? `; unlisted pages put in Reference: ${extra.join(", ")}` : ""}`);
