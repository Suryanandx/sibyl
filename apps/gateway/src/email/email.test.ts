import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { NOTIFICATION_KINDS } from "@open-gpt-live/core";
import { describe, expect, test } from "vitest";
import { createMailer, type MailMessage } from "../notifications/mailer.js";
import { inviteMailer } from "../identity/mail.js";
import { emailSamples } from "./catalog.js";
import { EMAIL_TOKENS, cleanSubject, escapeHtml, renderEmail, safeUrl } from "./layout.js";
import { invitationEmail, notificationEmail, signInLinkEmail, usageAlertEmail } from "./templates.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "../../../..");

describe("every template", () => {
  const samples = emailSamples();

  test("the catalog covers every email Sibyl sends", () => {
    const ids = samples.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ["sign-in-link", "sign-up-link", "sign-up-code", "invitation", "usage-alert", "usage-alert-blocked"]) expect(ids).toContain(id);
    for (const kind of NOTIFICATION_KINDS) expect(ids).toContain(`notification-${kind.replace(/_/g, "-")}`);
  });

  test.each(samples.map((s) => [s.id, s] as const))("%s renders HTML and text", (_id, sample) => {
    const email = renderEmail(sample.content, { to: sample.to });
    expect(email.subject.trim().length).toBeGreaterThan(0);
    expect(email.subject).not.toMatch(/\n/);
    expect(email.preheader.length).toBeGreaterThan(0);
    expect(sample.content.reason).toMatch(/^You're getting this because /);

    // HTML: a full document, preheader, heading, footer, no scripts, no remote pixels.
    expect(email.html).toMatch(/^<!DOCTYPE html>/);
    expect(email.html).toContain(`<title>${escapeHtml(email.subject)}</title>`);
    expect(email.html).toContain(escapeHtml(email.preheader));
    expect(email.html).toContain(escapeHtml(sample.content.heading));
    expect(email.html).toContain(escapeHtml(sample.content.reason));
    expect(email.html).toContain(`Sent to ${sample.to}.`);
    expect(email.html).not.toMatch(/<script|<link |@import|url\(/i);
    const images = [...email.html.matchAll(/<img [^>]*src="([^"]+)"/g)].map((m) => m[1]);
    expect(images).toEqual(["https://opensibyl.world/assets/brand/sibyl-mark-light.png"]);
    // Only brand colours (no purple, nothing off-palette).
    const allowed = new Set([...Object.values(EMAIL_TOKENS.light), ...Object.values(EMAIL_TOKENS.dark), "#ffffff"].map((c) => c.toLowerCase()));
    for (const [color] of email.html.matchAll(/#[0-9a-f]{6}\b/gi)) expect(allowed).toContain(color.toLowerCase());

    // Text: the heading, every link, the reason.
    expect(email.text.startsWith(sample.content.heading)).toBe(true);
    expect(email.text).toContain(sample.content.reason);
    for (const link of sample.links) {
      expect(email.text).toContain(link);
      expect(email.html).toContain(`href="${escapeHtml(link)}"`);
    }
    expect(email.text).not.toMatch(/<[a-z]/i);
  });
});

describe("escaping", () => {
  const evil = `<script>alert("x")</script>`;
  const tag = `"><img src=x onerror=alert(1)>`;

  test("names, workspaces and organizations are escaped", () => {
    const email = renderEmail(invitationEmail({ inviterName: evil, workspaceName: tag, orgName: "R&D <Lab>", role: "admin", url: "https://app.test/invite/t", days: 7 }));
    expect(email.html).not.toContain("<script>");
    expect(email.html).not.toContain("<img src=x");
    expect(email.html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(email.html).toContain("R&amp;D &lt;Lab&gt;");
    expect(email.html).toContain(escapeHtml(tag));
    // Plain text keeps the words as they are.
    expect(email.text).toContain(evil);
  });

  test("notification bodies are escaped; only http(s) URLs become links", () => {
    const body = `Reply from ${evil}\nhttps://crm.test/d?a=1&b=2\njavascript:alert(1)\n<a href="https://phish.test">click</a>`;
    const email = renderEmail(notificationEmail({ kind: "monitor_fired", title: tag, body, url: "https://app.test/monitors" }));
    expect(email.html).not.toContain("<script>");
    expect(email.html).not.toContain("<img src=x");
    expect(email.html).not.toContain('<a href="https://phish.test">');
    expect(email.html).not.toMatch(/href="javascript:/i);
    expect(email.html).toContain('href="https://crm.test/d?a=1&amp;b=2"');
    expect(email.subject).toBe(tag);
  });

  test("buttons refuse non-web URLs", () => {
    const email = renderEmail(signInLinkEmail({ url: "javascript:alert(1)", minutes: 15 }));
    expect(email.html).not.toMatch(/javascript:/i);
    expect(email.text).not.toMatch(/javascript:/i);
    expect(safeUrl("data:text/html,x")).toBeUndefined();
    expect(safeUrl("https://ok.test/a b")).toBe("https://ok.test/a%20b");
  });

  test("subjects are one clean line", () => {
    expect(cleanSubject("Hi\r\nBcc: x@y.z")).toBe("Hi Bcc: x@y.z");
    expect(cleanSubject("x".repeat(500)).length).toBeLessThanOrEqual(180);
    expect(() => renderEmail({ ...usageAlertEmail({ name: "A", period: "daily", thresholdPercent: 50, blocked: false, spent: "$1", cap: "$2" }), subject: "  " })).toThrow();
  });
});

describe("the mailer", () => {
  test("sends HTML and text from the shared layout, with the asset base from the environment", async () => {
    const sent: Array<MailMessage & { from: string }> = [];
    const mailer = createMailer({
      env: { SIBYL_SMTP_FROM: "Sibyl <hello@opensibyl.world>", SIBYL_EMAIL_ASSET_BASE_URL: "https://cdn.example.com/sibyl" },
      transport: async () => ({ sendMail: async (message) => void sent.push(message) })
    })!;
    await inviteMailer(mailer, () => 0)!.sendInvite({ to: "max@acme.test", inviterName: "Ana", workspaceName: "Sales", role: "member", url: "https://app.test/invite/t", expiresAt: 7 * 86_400_000 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ from: "Sibyl <hello@opensibyl.world>", to: "max@acme.test", subject: "Ana invited you to Sales on Sibyl" });
    expect(sent[0]!.html).toContain('src="https://cdn.example.com/sibyl/brand/sibyl-mark-light.png"');
    expect(sent[0]!.text).toContain("https://app.test/invite/t");
    expect(sent[0]!.text).toContain("expires in 7 days");
  });
});

describe("every send site uses the shared layer", () => {
  const sources = [...walk(join(REPO, "apps/gateway/src")), ...walk(join(REPO, "ee/gateway"))].filter((file) => !file.endsWith(".test.ts"));
  const rel = (file: string) => relative(REPO, file).split(sep).join("/");

  test("only the one mailer talks SMTP", () => {
    const smtp = sources.filter((file) => /\.sendMail\(|from "nodemailer"|import\("nodemailer"\)/.test(readFileSync(file, "utf8"))).map(rel);
    expect(smtp).toEqual(["apps/gateway/src/notifications/mailer.ts"]);
  });

  test("senders pass template content, never their own subject or text", () => {
    const senders = sources.filter((file) => /\bmailer\??\.send\(|this\.send\(mailer,|\.sendInvite\(/.test(readFileSync(file, "utf8")));
    expect(senders.map(rel).sort()).toEqual(
      [
        "apps/gateway/src/identity/mail.ts",
        "apps/gateway/src/identity/service.ts",
        "apps/gateway/src/identity/signup.ts",
        "apps/gateway/src/notifications/notifiers.ts",
        "ee/gateway/usage/alerts.ts"
      ].sort()
    );
    for (const file of senders) {
      const text = readFileSync(file, "utf8");
      // A raw message would carry its own subject/text/html next to `to:`.
      expect(text, rel(file)).not.toMatch(/send\(\{[^}]*\b(subject|text|html):/);
      if (!file.endsWith("identity/service.ts")) expect(text, rel(file)).toMatch(/email\/templates/);
    }
  });
});

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (path.endsWith(".ts")) yield path;
  }
}
