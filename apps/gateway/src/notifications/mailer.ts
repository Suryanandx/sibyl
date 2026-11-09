/**
 * The gateway's one mailer (SMTP). Every email goes through it: sign-in links
 * and codes (identity/signup.ts), invitations (identity/mail.ts),
 * notifications (notifiers.ts) and enterprise usage alerts. Senders pass
 * `EmailContent` built by a template (email/templates.ts); the mailer renders
 * it through the one layout (email/layout.ts) into HTML and plain text.
 *
 * Active only when SIBYL_SMTP_URL is set, for example
 * `smtp://USER:PASS@email-smtp.eu-central-1.amazonaws.com:587?requireTLS=true`
 * (Amazon SES; see docs/configuration.md). SIBYL_SMTP_FROM sets the sender
 * (default: "Sibyl <no-reply@localhost>", which real mail servers refuse:
 * set it). SIBYL_EMAIL_ASSET_BASE_URL is where the logo is loaded from
 * (default https://opensibyl.world/assets/).
 */
import type { EmailMessage } from "@open-gpt-live/core";
import { DEFAULT_EMAIL_ASSET_BASE_URL, renderEmail } from "../email/layout.js";

/** What goes over SMTP: rendered subject, plain text and HTML. */
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** What nodemailer's transport offers (tests pass a fake). */
export interface MailTransport {
  sendMail(message: MailMessage & { from: string }): Promise<unknown>;
}

export interface Mailer {
  /** Render the content through the shared layout and send it. */
  send(message: EmailMessage): Promise<void>;
}

export interface MailerOptions {
  env: NodeJS.ProcessEnv;
  /** Test seam: replaces the SMTP transport (the mailer is then active without SIBYL_SMTP_URL). */
  transport?(): Promise<MailTransport>;
}

const DEFAULT_FROM = "Sibyl <no-reply@localhost>";

/** The mailer, or undefined when email isn't set up on this server. */
export function createMailer(options: MailerOptions): Mailer | undefined {
  const url = options.env.SIBYL_SMTP_URL?.trim();
  if (!url && !options.transport) return undefined;
  const from = options.env.SIBYL_SMTP_FROM?.trim() || DEFAULT_FROM;
  const assetBaseUrl = options.env.SIBYL_EMAIL_ASSET_BASE_URL?.trim() || DEFAULT_EMAIL_ASSET_BASE_URL;
  let transport: Promise<MailTransport> | undefined;
  const open = (): Promise<MailTransport> => {
    transport ??= options.transport
      ? options.transport()
      : import("nodemailer").then((module) => (module.default ?? module).createTransport(url!) as unknown as MailTransport);
    // A failed connection attempt is retried on the next send.
    transport.catch(() => {
      transport = undefined;
    });
    return transport;
  };
  return {
    async send(message) {
      const rendered = renderEmail(message.email, { assetBaseUrl, to: message.to });
      await (await open()).sendMail({ from, to: message.to, subject: rendered.subject, text: rendered.text, html: rendered.html });
    }
  };
}
