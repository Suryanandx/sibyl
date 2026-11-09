/**
 * Render every email (email/catalog.ts) with sample data into a folder you
 * can open in a browser, and screenshot each one with headless Chromium.
 *
 *   corepack pnpm --filter @open-gpt-live/gateway run email:preview [out-dir] [--no-screenshots]
 *
 * Writes <id>.html, <id>.txt and index.html to out-dir (default
 * apps/gateway/email-preview, not committed). Images load from
 * apps/site/assets unless SIBYL_EMAIL_ASSET_BASE_URL is set. Screenshots go to
 * out-dir/screens/<id>-{desktop,mobile,dark}.png. They need a Chromium that
 * playwright-core can launch (its own browser download, or CHROMIUM_PATH);
 * without one the screenshots are skipped.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { emailSamples } from "./catalog.js";
import { escapeHtml, renderEmail } from "./layout.js";

const GATEWAY = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const VIEWPORTS = [
  { name: "desktop", width: 900, height: 900, colorScheme: "light" },
  { name: "mobile", width: 390, height: 844, colorScheme: "light" },
  { name: "dark", width: 900, height: 900, colorScheme: "dark" }
] as const;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const out = resolve(args.find((arg) => !arg.startsWith("--")) ?? join(GATEWAY, "email-preview"));
  const screenshots = !args.includes("--no-screenshots");
  mkdirSync(out, { recursive: true });

  // The site's own brand assets, so the logo shows before opensibyl.world serves them (SIBYL_EMAIL_ASSET_BASE_URL wins).
  const assetBaseUrl = process.env.SIBYL_EMAIL_ASSET_BASE_URL?.trim() || pathToFileURL(join(GATEWAY, "../site/assets/")).href;
  const samples = emailSamples();
  const rows: string[] = [];
  for (const sample of samples) {
    const email = renderEmail(sample.content, { to: sample.to, assetBaseUrl });
    writeFileSync(join(out, `${sample.id}.html`), email.html);
    writeFileSync(join(out, `${sample.id}.txt`), `Subject: ${email.subject}\nPreheader: ${email.preheader}\n\n${email.text}`);
    rows.push(
      `<tr><td><a href="${sample.id}.html">${escapeHtml(sample.id)}</a><br><a href="${sample.id}.txt">text</a> · <a href="screens/${sample.id}-desktop.png">desktop</a> · <a href="screens/${sample.id}-mobile.png">mobile</a> · <a href="screens/${sample.id}-dark.png">dark</a></td><td><strong>${escapeHtml(email.subject)}</strong><br><span>${escapeHtml(email.preheader)}</span></td><td>${escapeHtml(sample.when)}</td></tr>`
    );
  }
  writeFileSync(
    join(out, "index.html"),
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Sibyl emails</title><style>body{font:14px/1.5 -apple-system,Segoe UI,sans-serif;color:#1d211f;background:#f7f7f5;margin:32px}table{border-collapse:collapse;background:#fff}td,th{border:1px solid #e4e7e2;padding:8px 10px;vertical-align:top;text-align:left}span{color:#565d59}a{color:#596c5d}</style></head><body><h1>Sibyl emails (${samples.length})</h1><table><tr><th>Email</th><th>Subject / preheader</th><th>Sent when</th></tr>${rows.join("")}</table></body></html>`
  );
  console.log(`Wrote ${samples.length} emails to ${out}`);

  if (!screenshots) return;
  const require = createRequire(join(GATEWAY, "package.json"));
  const { chromium } = require("playwright-core") as typeof import("playwright-core");
  let browser: import("playwright-core").Browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  } catch (error) {
    console.warn(`Skipped screenshots: no Chromium to launch (${error instanceof Error ? error.message.split("\n")[0] : String(error)}). Set CHROMIUM_PATH.`);
    return;
  }
  try {
    mkdirSync(join(out, "screens"), { recursive: true });
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, colorScheme: viewport.colorScheme, deviceScaleFactor: 1 });
      const page = await context.newPage();
      for (const sample of samples) {
        await page.goto(`file://${join(out, `${sample.id}.html`)}`, { waitUntil: "load" });
        await page.screenshot({ path: join(out, "screens", `${sample.id}-${viewport.name}.png`), fullPage: true });
      }
      await context.close();
    }
    console.log(`Screenshots in ${join(out, "screens")}`);
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
