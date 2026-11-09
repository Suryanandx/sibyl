/**
 * The gateway's one mailer (SMTP). Used for notification email and for
 * workspace invitations (identity/mail.ts composes those).
 *
 * Active only when SIBYL_SMTP_URL is set (for example
 * `smtps://user:pass@smtp.example.com:465`). SIBYL_SMTP_FROM sets the sender
 * (default: "Sibyl <no-reply@localhost>"). The SMTP connection is opened on
 * the first send and reused.
 */

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

/** What nodemailer's transport offers (tests pass a fake). */
export interface MailTransport {
  sendMail(message: MailMessage & { from: string }): Promise<unknown>;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export interface MailerOptions {
  env: NodeJS.ProcessEnv;
  /** Test seam: replaces the SMTP transport (the mailer is then active without SIBYL_SMTP_URL). */
  transport?(): Promise<MailTransport>;
}

const DEFAULT_FROM = "Sibyl <no-reply@localhost>";
const SUBJECT_MAX = 180;

/** The mailer, or undefined when email isn't set up on this server. */
export function createMailer(options: MailerOptions): Mailer | undefined {
  const url = options.env.SIBYL_SMTP_URL?.trim();
  if (!url && !options.transport) return undefined;
  const from = options.env.SIBYL_SMTP_FROM?.trim() || DEFAULT_FROM;
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
      await (await open()).sendMail({
        from,
        to: message.to,
        subject: oneLine(message.subject).slice(0, SUBJECT_MAX),
        text: message.text
      });
    }
  };
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
