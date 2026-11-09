/**
 * Email content: what every email Sibyl sends is made of. Senders build an
 * `EmailContent` (subject, preheader, heading, blocks, the footer's reason)
 * and hand it to the gateway's one mailer, which renders it through the one
 * shared layout (apps/gateway/src/email) into HTML and plain text. Nothing
 * sends raw text or HTML of its own.
 *
 * All strings here are plain text. The renderer escapes them; never put HTML
 * in them.
 */

/** A run of text in a paragraph: plain, bold, or a link. */
export type EmailInline = string | { strong: string } | { text: string; href: string };

export type EmailBlock =
  /** A paragraph. */
  | { kind: "text"; text: string | EmailInline[] }
  /** Smaller, quieter paragraph (expiry, "if you didn't ask for this"). */
  | { kind: "note"; text: string | EmailInline[] }
  /**
   * The call to action. `fallback` also prints the URL under the button
   * (for sign-in links: some clients block buttons).
   */
  | { kind: "button"; label: string; url: string; fallback?: boolean }
  /** A one-time code, large and spaced. */
  | { kind: "code"; code: string }
  /** Someone else's words or a multi-line result, kept line by line (URLs become links). */
  | { kind: "panel"; text: string; label?: string }
  /** Short label / value rows. */
  | { kind: "facts"; rows: Array<{ label: string; value: string }> };

export interface EmailContent {
  /** One line; the inbox shows it. */
  subject: string;
  /** The hidden line inboxes show after the subject. */
  preheader: string;
  /** The title at the top of the email. */
  heading: string;
  blocks: EmailBlock[];
  /** Why the reader got this email (the footer), e.g. "You're getting this because …". */
  reason: string;
}

/** One email for one address. */
export interface EmailMessage {
  to: string;
  email: EmailContent;
}
