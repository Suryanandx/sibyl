/**
 * Notices composed from other modules' events, where those modules don't
 * know about notifications themselves.
 */
import type { InviteRecord, UserRecord } from "@open-gpt-live/core";
import type { NotificationInput } from "./service.js";

/** Someone accepted an invitation: tell the person who invited them. */
export function inviteAcceptedNotice(event: { invite: InviteRecord; user: UserRecord; workspaceName: string }): NotificationInput {
  const { invite, user, workspaceName } = event;
  return {
    kind: "invite_accepted",
    workspaceId: invite.workspaceId,
    recipientUserId: invite.invitedBy,
    title: `${user.name} joined ${workspaceName}`,
    body: `${user.name} (${user.email}) accepted your invitation and joined ${workspaceName} as ${article(invite.role)} ${invite.role}.`
  };
}

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}
