"use client";

import { useCallback, useEffect, useState } from "react";
import type { InviteView } from "@open-gpt-live/protocol";
import { InviteDialog } from "../../../components/settings/MembersSection";
import { Button, Muted } from "../../../components/ui";
import { useAppSession, useAuthState } from "../../../lib/app-session";
import { gatewayRequest } from "../../../lib/gateway-http";
import { StepLayout } from "../OnboardingFlow";
import styles from "../onboarding.module.css";

/** Invite your team (optional): the same invitation dialog as Settings → Members. */
export function StepTeam() {
  const session = useAppSession();
  const { me } = useAuthState();
  const [open, setOpen] = useState(false);
  const [invites, setInvites] = useState<InviteView[]>([]);
  const workspaceId = session.currentWorkspaceId;
  const local = me?.principal === "local";

  const load = useCallback(async () => {
    try {
      const pending = await gatewayRequest<{ invites: InviteView[] }>(`/api/invites?workspaceId=${encodeURIComponent(workspaceId)}`, { workspaceId });
      setInvites(pending.invites);
    } catch {
      setInvites([]);
    }
  }, [workspaceId]);

  useEffect(() => {
    if (!local) void load();
  }, [load, local]);

  return (
    <>
      <StepLayout
        title="Invite your team"
        lead={
          local
            ? "Sibyl is running without accounts. Create an owner account in Settings → Members first, then invite people."
            : `Bring people into ${session.currentWorkspace?.name ?? "your workspace"}. They get their own sign-in and see what you share with them.`
        }
        hideSkip={invites.length > 0}
        skipNote="You can invite people later in Settings → Members."
      >
        {!local ? (
          <div className={styles.teamRow}>
            <Button onClick={() => setOpen(true)}>Invite people</Button>
            <Muted as="span" className={styles.small}>
              {invites.length
                ? `${invites.length} invitation${invites.length === 1 ? "" : "s"} waiting to be accepted.`
                : me?.smtp
                  ? "We email the link, or you copy it."
                  : "You copy the link and send it yourself."}
            </Muted>
          </div>
        ) : null}
        {invites.length ? (
          <ul className={styles.inviteList}>
            {invites.map((invite) => (
              <li key={invite.id}>{invite.email ?? "Anyone with the link"}</li>
            ))}
          </ul>
        ) : null}
      </StepLayout>
      {/* Outside the step's form: the dialog is a form of its own. */}
      {open ? (
        <InviteDialog
          workspaceId={workspaceId}
          workspaceName={session.currentWorkspace?.name ?? "this workspace"}
          myRole={session.currentWorkspace?.role ?? "viewer"}
          smtp={Boolean(me?.smtp)}
          onClose={() => setOpen(false)}
          onCreated={() => void load()}
        />
      ) : null}
    </>
  );
}
