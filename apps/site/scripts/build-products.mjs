#!/usr/bin/env node
/**
 * Builds one page per Sibyl product (apps/site/products/<slug>.html) from products.mjs,
 * with the landing page's header and footer (chrome.mjs). Run with the docs:
 *
 *   corepack pnpm --filter site docs
 *
 * The output is committed, so hosting stays build-free.
 */
import { writeFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SITE, GITHUB, esc, chrome, head } from "./chrome.mjs";
import { PRODUCTS } from "./products.mjs";

const OUT = join(SITE, "products");
const { header, footer } = chrome("products");

function feature(f, i) {
  return `      <article class="feat">
        <div class="featText">
          <h3>${esc(f.title)}</h3>
          <p>${esc(f.text)}</p>
          <a class="more" href="${esc(f.docs[0])}">${esc(f.docs[1])} docs <span aria-hidden="true">→</span></a>
        </div>
        <figure class="media">
          <div class="frame app"><img src="${esc(f.image.src)}" width="${f.image.width}" height="${f.image.height}" loading="${i === 0 ? "eager" : "lazy"}" decoding="async" alt="${esc(f.image.alt)}" /></div>
        </figure>
      </article>`;
}

function costs(p) {
  const rows = p.costs
    .map(([what, cost, basis, href]) => `            <tr><th scope="row">${esc(what)}</th><td class="costValue">${esc(cost)}</td><td>${href ? `<a class="link" href="${esc(href)}">${esc(basis)}</a>` : esc(basis)}</td></tr>`)
    .join("\n");
  return `    <section class="wrap productSection" aria-labelledby="cost-title">
      <h2 id="cost-title" class="sectionTitle small">What it costs to run</h2>
      <p class="sectionLede">There is no subscription. You pay your model provider (through your OpenRouter key) for what you use. These are real numbers we measured; prices move as providers change theirs.</p>
      <div class="tableWrap" tabindex="0" role="region" aria-labelledby="cost-title">
        <table class="costTable">
          <thead><tr><th scope="col">What</th><th scope="col">Cost</th><th scope="col">Where the number comes from</th></tr></thead>
          <tbody>
${rows}
          </tbody>
        </table>
      </div>${p.note ? `\n      <p class="note">${esc(p.note)}</p>` : ""}
    </section>`;
}

function others(p) {
  return PRODUCTS.filter((o) => o.slug !== p.slug)
    .map((o) => `<li><a href="${o.slug}.html"><strong>${esc(o.name)}</strong><span>${esc(o.line)}</span></a></li>`)
    .join("");
}

function page(p) {
  return `<!doctype html>
<html lang="en">
${head({ title: `${p.name} — ${p.line}`, description: p.lede, generatedFrom: "apps/site/scripts/build-products.mjs from scripts/products.mjs" })}
<body>
  <a class="skip" href="#main">Skip to content</a>
${header}
  <main id="main" class="productPage">
    <section class="hero wrap">
      <p class="eyebrow">${esc(p.name)} · Open source · Part of Sibyl</p>
      <h1>${esc(p.headline)}</h1>
      <p class="lede">${esc(p.lede)}</p>
      <div class="ctaRow">
        <a class="btn btnInk" href="#try">Try it</a>
        <a class="btn btnLine" href="${esc(p.docs[0][0])}">Read the docs</a>
      </div>
    </section>

    <section class="wrap productSection" aria-labelledby="can-title">
      <h2 id="can-title" class="sectionTitle small">What you can do</h2>
      <div class="feats">
${p.features.map(feature).join("\n")}
      </div>
    </section>

${costs(p)}

    <section class="wrap productSection" id="try" aria-labelledby="try-title">
      <h2 id="try-title" class="sectionTitle small">Try it</h2>
      <p class="sectionLede">${esc(p.name)} is part of the one Sibyl install, with the other products. You need an <a class="link" href="https://openrouter.ai/keys">OpenRouter API key</a>.</p>
      <div class="cmd">
        <pre><code>git clone https://github.com/Suryanandx/sibyl.git &amp;&amp; cd sibyl &amp;&amp; cp .env.example .env &amp;&amp; docker compose up --build</code></pre>
        <button type="button" class="btn btnLine btnXs copy" aria-label="Copy the Docker command">Copy</button>
      </div>
      <p class="note">Set <code>OPENROUTER_API_KEY</code> in <code>.env</code>, then open <code>http://localhost:3000</code> and create the owner account. The <a class="link" href="${GITHUB}#quickstart">quickstart on GitHub</a> also covers running it with Node.js.</p>
    </section>

    <section class="wrap productSection" aria-labelledby="docs-title">
      <h2 id="docs-title" class="sectionTitle small">Docs</h2>
      <ul class="docLinks">${p.docs.map(([href, label]) => `<li><a class="link" href="${esc(href)}">${esc(label)} <span aria-hidden="true">→</span></a></li>`).join("")}</ul>
    </section>

    <nav class="wrap productSection otherProducts" aria-labelledby="others-title">
      <h2 id="others-title" class="sectionTitle small">The other Sibyl products</h2>
      <ul>${others(p)}</ul>
    </nav>
  </main>
${footer}
</body>
</html>
`;
}

mkdirSync(OUT, { recursive: true });
for (const f of readdirSync(OUT)) if (f.endsWith(".html")) rmSync(join(OUT, f));
for (const p of PRODUCTS) writeFileSync(join(OUT, `${p.slug}.html`), page(p));
console.log(`products: ${PRODUCTS.length} pages`);
