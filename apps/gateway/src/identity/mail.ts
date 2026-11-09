/**
 * Invitation email, sent through the gateway's one mailer
 * (notifications/mailer.ts). Only active when that mailer is (SIBYL_SMTP_URL);
 * otherwise the inviter copies the link.
 */
import type { Mailer } from "../notifications/mailer.js";

export interface InviteMail {
  to: string;
  inviterName: string;
  workspaceName: string;
  /** The organization's name (Admin → Organization), when set. */
  orgName?: string;
  role: string;
  url: string;
  expiresAt: number;
}

export interface InviteMailer {
  sendInvite(mail: InviteMail): Promise<void>;
}

/** Invitations over the shared mailer; undefined when email isn't set up. */
export function inviteMailer(mailer: Mailer | undefined, now: () => number = Date.now): InviteMailer | undefined {
  if (!mailer) return undefined;
  return {
    async sendInvite(mail) {
      const days = Math.max(1, Math.round((mail.expiresAt - now()) / 86_400_000));
      const where = mail.orgName ? `the ${mail.workspaceName} workspace of ${mail.orgName}` : `the ${mail.workspaceName} workspace`;
      const text = [
        `${mail.inviterName} invited you to ${where} on Sibyl as ${article(mail.role)} ${mail.role}.`,
        "",
        `Accept the invitation: ${mail.url}`,
        "",
        `The link works once and expires in ${days} day${days === 1 ? "" : "s"}. If you weren't expecting this, ignore this email.`
      ].join("\n");
      const subject = mail.orgName
        ? `${mail.inviterName} invited you to ${mail.workspaceName} (${mail.orgName}) on Sibyl`
        : `${mail.inviterName} invited you to ${mail.workspaceName} on Sibyl`;
      await mailer.send({ to: mail.to, subject, text });
    }
  };
}

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}
