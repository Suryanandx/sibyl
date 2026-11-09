/**
 * Invitation email, sent through the gateway's one mailer
 * (notifications/mailer.ts) with the shared template (email/templates.ts).
 * Only active when that mailer is (SIBYL_SMTP_URL); otherwise the inviter
 * copies the link.
 */
import { invitationEmail } from "../email/templates.js";
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
      await mailer.send({
        to: mail.to,
        email: invitationEmail({
          inviterName: mail.inviterName,
          workspaceName: mail.workspaceName,
          ...(mail.orgName ? { orgName: mail.orgName } : {}),
          role: mail.role,
          url: mail.url,
          days
        })
      });
    }
  };
}
