/**
 * The one email layout. Every email Sibyl sends is an `EmailContent`
 * (packages/core/src/email.ts) rendered here into HTML and plain text.
 *
 * - Table layout with inline styles (Gmail strips <style> in some views;
 *   Outlook on Windows renders with Word), one 560px column that shrinks on
 *   phones.
 * - Light by default; a `prefers-color-scheme: dark` block (Apple Mail, iOS,
 *   Outlook.com) switches to the dark tokens. Clients that invert colours on
 *   their own (Gmail apps) get colours that survive it: the logo sits on its
 *   own light tile.
 * - A hidden preheader, a bulletproof button (a padded link in a coloured
 *   cell, with Outlook padding), a footer saying why the reader got it.
 * - Images use absolute URLs under SIBYL_EMAIL_ASSET_BASE_URL. No tracking
 *   pixels, no remote fonts, no scripts.
 *
 * Every value is escaped here; templates pass plain text only.
 */
import type { EmailBlock, EmailContent, EmailInline } from "@open-gpt-live/core";

export const DEFAULT_EMAIL_ASSET_BASE_URL = "https://opensibyl.world/assets/";
export const SIBYL_HOME_URL = "https://opensibyl.world";
const LOGO_PATH = "brand/sibyl-mark-light.png";

export interface RenderedEmail {
  subject: string;
  preheader: string;
  html: string;
  text: string;
}

export interface RenderOptions {
  /** Base URL for images (ends in a slash or gets one). Default: https://opensibyl.world/assets/ */
  assetBaseUrl?: string;
  /** The address it goes to, named in the footer. */
  to?: string;
}

/** Brand tokens (apps/web/app/globals.css, apps/site/site.css): warm neutrals, sage accent. No purple. */
export const EMAIL_TOKENS = {
  light: {
    canvas: "#f7f7f5",
    card: "#ffffff",
    subtle: "#f1f2ef",
    text: "#1d211f",
    text2: "#565d59",
    border: "#e4e7e2",
    ink: "#1d211f",
    inkText: "#fafaf8",
    accent: "#596c5d"
  },
  dark: {
    canvas: "#121413",
    card: "#1b1d1c",
    subtle: "#222624",
    text: "#ecedea",
    text2: "#a3a9a5",
    border: "#2b2f2d",
    ink: "#ecedea",
    inkText: "#121413",
    accent: "#9db3a2"
  }
} as const;

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Archivo, Roboto, Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Courier New', monospace";
const SUBJECT_MAX = 180;
const L = EMAIL_TOKENS.light;
const D = EMAIL_TOKENS.dark;

/* ───────────── escaping ───────────── */

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escape text for HTML content and attribute values. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]!);
}

/** An http(s) or mailto URL, normalised; anything else (javascript:, data:, relative) is refused. */
export function safeUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** Subjects are one line, without control characters, and not too long. */
export function cleanSubject(subject: string): string {
  // eslint-disable-next-line no-control-regex
  const line = subject.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return line.length > SUBJECT_MAX ? `${line.slice(0, SUBJECT_MAX - 1).trimEnd()}…` : line;
}

/* ───────────── render ───────────── */

export function renderEmail(content: EmailContent, options: RenderOptions = {}): RenderedEmail {
  const subject = cleanSubject(content.subject);
  if (!subject) throw new Error("An email needs a subject.");
  const preheader = content.preheader.replace(/\s+/g, " ").trim();
  return { subject, preheader, html: renderHtml(content, subject, preheader, options), text: renderText(content, options) };
}

export function assetUrl(path: string, base = DEFAULT_EMAIL_ASSET_BASE_URL): string {
  const root = base.trim() || DEFAULT_EMAIL_ASSET_BASE_URL;
  return new URL(path.replace(/^\/+/, ""), root.endsWith("/") ? root : `${root}/`).href;
}

function renderHtml(content: EmailContent, subject: string, preheader: string, options: RenderOptions): string {
  const logo = assetUrl(LOGO_PATH, options.assetBaseUrl);
  const blocks = content.blocks.map(htmlBlock).join("\n");
  const sentTo = options.to ? `Sent to ${escapeHtml(options.to)}. ` : "";
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no, date=no, address=no, email=no, url=no">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(subject)}</title>
<!--[if mso]>
<noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
<style>table,td,div,p,a,h1{font-family:Segoe UI,Arial,sans-serif !important;}</style>
<![endif]-->
<style>
:root { color-scheme: light dark; supported-color-schemes: light dark; }
body { margin: 0 !important; padding: 0 !important; width: 100% !important; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; border-collapse: collapse; }
img { border: 0; outline: none; text-decoration: none; -ms-interpolation-mode: bicubic; }
a { text-decoration: underline; }
a[x-apple-data-detectors] { color: inherit !important; text-decoration: none !important; }
u + #body a { color: inherit; text-decoration: none; }
@media only screen and (max-width: 600px) {
  .s-shell { padding: 20px 12px !important; }
  .s-card-pad { padding: 28px 22px 16px 22px !important; }
  .s-h1 { font-size: 22px !important; line-height: 30px !important; }
  .s-code { font-size: 28px !important; letter-spacing: 6px !important; padding-left: 6px !important; }
}
@media (prefers-color-scheme: dark) {
  .s-bg { background-color: ${D.canvas} !important; }
  .s-card { background-color: ${D.card} !important; border-color: ${D.border} !important; }
  .s-subtle { background-color: ${D.subtle} !important; border-color: ${D.border} !important; }
  .s-text, .s-h1 { color: ${D.text} !important; }
  .s-muted { color: ${D.text2} !important; }
  .s-link { color: ${D.accent} !important; }
  .s-rule { border-color: ${D.border} !important; }
  .s-btn-td { background-color: ${D.ink} !important; }
  .s-btn { color: ${D.inkText} !important; }
  .s-logo { border-color: ${D.border} !important; }
}
[data-ogsc] .s-bg { background-color: ${D.canvas} !important; }
[data-ogsc] .s-card { background-color: ${D.card} !important; }
[data-ogsc] .s-text, [data-ogsc] .s-h1 { color: ${D.text} !important; }
[data-ogsc] .s-muted { color: ${D.text2} !important; }
[data-ogsc] .s-link { color: ${D.accent} !important; }
</style>
</head>
<body id="body" class="s-bg" style="margin:0;padding:0;width:100%;background-color:${L.canvas};">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${escapeHtml(preheader)}${"&#8199;&#847;&zwnj;&nbsp;".repeat(40)}</div>
<table role="presentation" class="s-bg" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background-color:${L.canvas};">
<tr><td class="s-shell" align="center" style="padding:40px 16px;">
<!--[if mso]><table role="presentation" width="560" cellspacing="0" cellpadding="0" border="0" align="center"><tr><td><![endif]-->
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:560px;">
<tr><td style="padding:0 4px 20px 4px;">
<table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>
<td class="s-logo" width="32" height="32" bgcolor="#ffffff" style="width:32px;height:32px;background-color:#ffffff;border:1px solid ${L.border};border-radius:8px;text-align:center;vertical-align:middle;">
<img src="${escapeHtml(logo)}" width="22" height="22" alt="" style="display:block;width:22px;height:22px;margin:5px auto;border:0;">
</td>
<td class="s-text" style="padding-left:10px;font-family:${FONT};font-size:17px;line-height:24px;font-weight:600;letter-spacing:-0.2px;color:${L.text};">Sibyl</td>
</tr></table>
</td></tr>
<tr><td class="s-card s-card-pad" bgcolor="${L.card}" style="background-color:${L.card};border:1px solid ${L.border};border-radius:10px;padding:36px 40px 22px 40px;">
<h1 class="s-h1" style="margin:0 0 18px 0;font-family:${FONT};font-size:24px;line-height:32px;font-weight:600;letter-spacing:-0.3px;color:${L.text};">${escapeHtml(content.heading)}</h1>
${blocks}
</td></tr>
<tr><td style="padding:22px 4px 0 4px;">
<p class="s-muted" style="margin:0 0 8px 0;font-family:${FONT};font-size:12px;line-height:18px;color:${L.text2};">${sentTo}${escapeHtml(content.reason)}</p>
<p class="s-muted" style="margin:0;font-family:${FONT};font-size:12px;line-height:18px;color:${L.text2};">Sibyl &middot; <a class="s-muted" href="${SIBYL_HOME_URL}" style="color:${L.text2};text-decoration:underline;">opensibyl.world</a></p>
</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>
`;
}

const P = `font-family:${FONT};font-size:15px;line-height:24px;color:${L.text};`;
const NOTE = `font-family:${FONT};font-size:13px;line-height:20px;color:${L.text2};`;

function htmlBlock(block: EmailBlock): string {
  switch (block.kind) {
    case "text":
      return `<p class="s-text" style="margin:0 0 16px 0;${P}">${inlineHtml(block.text)}</p>`;
    case "note":
      return `<p class="s-muted" style="margin:0 0 12px 0;${NOTE}">${inlineHtml(block.text)}</p>`;
    case "button":
      return buttonHtml(block.label, block.url, block.fallback === true);
    case "code":
      return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:4px 0 20px 0;"><tr>
<td class="s-subtle" bgcolor="${L.subtle}" align="center" style="background-color:${L.subtle};border:1px solid ${L.border};border-radius:8px;padding:18px 12px;">
<span class="s-text s-code" style="font-family:${MONO};font-size:32px;line-height:40px;font-weight:600;letter-spacing:8px;padding-left:8px;color:${L.text};">${escapeHtml(block.code)}</span>
</td></tr></table>`;
    case "panel":
      return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 20px 0;"><tr>
<td class="s-subtle" bgcolor="${L.subtle}" style="background-color:${L.subtle};border:1px solid ${L.border};border-radius:8px;padding:14px 16px;">
${block.label ? `<p class="s-muted" style="margin:0 0 6px 0;${NOTE}font-weight:600;">${escapeHtml(block.label)}</p>` : ""}<p class="s-text" style="margin:0;${P}font-size:14px;line-height:22px;word-break:break-word;">${multilineHtml(block.text)}</p>
</td></tr></table>`;
    case "facts":
      return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 20px 0;">
${block.rows
  .map(
    (row) =>
      `<tr><td class="s-muted s-rule" valign="top" style="${NOTE}padding:8px 12px 8px 0;border-top:1px solid ${L.border};width:38%;">${escapeHtml(row.label)}</td><td class="s-text s-rule" valign="top" style="${P}font-size:14px;line-height:20px;padding:8px 0;border-top:1px solid ${L.border};">${escapeHtml(row.value)}</td></tr>`
  )
  .join("\n")}
</table>`;
  }
}

function buttonHtml(label: string, rawUrl: string, fallback: boolean): string {
  const url = safeUrl(rawUrl);
  if (!url) return "";
  const href = escapeHtml(url);
  const button = `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:8px 0 24px 0;"><tr>
<td class="s-btn-td" bgcolor="${L.ink}" style="background-color:${L.ink};border-radius:6px;mso-padding-alt:12px 24px;">
<a class="s-btn" href="${href}" target="_blank" rel="noopener" style="display:inline-block;padding:12px 24px;font-family:${FONT};font-size:15px;line-height:20px;font-weight:600;color:${L.inkText};text-decoration:none;border-radius:6px;mso-padding-alt:0;">${escapeHtml(label)}</a>
</td></tr></table>`;
  if (!fallback) return button;
  return `${button}
<p class="s-muted" style="margin:0 0 16px 0;${NOTE}">If the button doesn't work, copy this link into your browser:<br><a class="s-link" href="${href}" style="color:${L.accent};word-break:break-all;">${escapeHtml(url)}</a></p>`;
}

function inlineHtml(text: string | EmailInline[]): string {
  const parts = typeof text === "string" ? [text] : text;
  return parts
    .map((part) => {
      if (typeof part === "string") return escapeHtml(part);
      if ("strong" in part) return `<strong style="font-weight:600;">${escapeHtml(part.strong)}</strong>`;
      const url = safeUrl(part.href);
      return url ? `<a class="s-link" href="${escapeHtml(url)}" style="color:${L.accent};">${escapeHtml(part.text)}</a>` : escapeHtml(part.text);
    })
    .join("");
}

const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g;

/** Plain text kept line by line, with http(s) URLs turned into links. */
function multilineHtml(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      let out = "";
      let last = 0;
      for (const match of line.matchAll(URL_IN_TEXT)) {
        const url = safeUrl(match[0]);
        out += escapeHtml(line.slice(last, match.index));
        out += url ? `<a class="s-link" href="${escapeHtml(url)}" style="color:${L.accent};word-break:break-all;">${escapeHtml(match[0])}</a>` : escapeHtml(match[0]);
        last = match.index + match[0].length;
      }
      return out + escapeHtml(line.slice(last));
    })
    .join("<br>");
}

/* ───────────── plain text ───────────── */

function renderText(content: EmailContent, options: RenderOptions): string {
  const parts: string[] = [content.heading.trim(), ""];
  for (const block of content.blocks) {
    const text = textBlock(block);
    if (text) parts.push(text, "");
  }
  parts.push("--", `${options.to ? `Sent to ${options.to}. ` : ""}${content.reason}`, `Sibyl · ${SIBYL_HOME_URL}`);
  return `${parts.join("\n")}\n`;
}

function textBlock(block: EmailBlock): string {
  switch (block.kind) {
    case "text":
    case "note":
      return inlineText(block.text);
    case "button": {
      const url = safeUrl(block.url);
      return url ? `${block.label}:\n${url}` : "";
    }
    case "code":
      return `    ${block.code}`;
    case "panel":
      return [...(block.label ? [`${block.label}:`] : []), ...block.text.split("\n").map((line) => `  ${line}`.trimEnd())].join("\n");
    case "facts":
      return block.rows.map((row) => `${row.label}: ${row.value}`).join("\n");
  }
}

function inlineText(text: string | EmailInline[]): string {
  const parts = typeof text === "string" ? [text] : text;
  return parts
    .map((part) => {
      if (typeof part === "string") return part;
      if ("strong" in part) return part.strong;
      const url = safeUrl(part.href);
      return url && url !== part.text ? `${part.text} (${url})` : part.text;
    })
    .join("");
}
