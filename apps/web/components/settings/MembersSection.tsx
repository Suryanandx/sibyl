"use client";

/**
 * Settings → Members: who is in the current workspace, their roles, pending
 * invitations, and the invite dialog (role picker, copy link, optional email).
 * What is shown follows useAppSession().can(); the gateway enforces the same.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { IdentityRole, InviteView, MemberView } from "@open-gpt-live/protocol";
import { refreshAppSession, useAppSession, useAuthState } from "../../lib/app-session";
import { errorText, gatewayRequest } from "../../lib/gateway-http";
import { paths } from "../../lib/routes";
import { Badge, Button, ButtonLink, Card, CardHeader, Dialog, EmptyState, Field, Input, Muted, Notice, Select, Stack, cx } from "../ui";
import styles from "./settings.module.css";

export const ROLE_LABEL: Record<IdentityRole, string> = { owner: "Owner", admin: "Admin", member: "Member", viewer: "Viewer" };
export const ROLE_HELP: Record<IdentityRole, string> = {
  owner: "Everything, including deleting the workspace.",
  admin: "Manage members, connections, secrets and settings.",
  member: "Chat, run actions, create routines and decks.",
  viewer: "Chat and read. Can't change anything."
};
export const RANK: Record<IdentityRole, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1]![0]! : "")).toUpperCase() || "?";
}

export default function MembersSection() {
  const session = useAppSession();
  const { me } = useAuthState();
  const workspaceId = session.currentWorkspaceId;
  const myRole = session.currentWorkspace?.role ?? "viewer";
  const canInvite = session.can("members.invite");
  const canManage = session.can("members.manage");
  const [members, setMembers] = useState<MemberView[] | null>(null);
  const [invites, setInvites] = useState<InviteView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await gatewayRequest<{ members: MemberView[] }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/members`, { workspaceId });
      setMembers(result.members);
      if (canInvite) {
        const pending = await gatewayRequest<{ invites: InviteView[] }>(`/api/invites?workspaceId=${encodeURIComponent(workspaceId)}`, { workspaceId });
        setInvites(pending.invites);
      } else {
        setInvites([]);
      }
    } catch (caught) {
      setMembers([]);
      setError(errorText(caught));
    }
  }, [workspaceId, canInvite]);

  useEffect(() => {
    if (me && me.mode !== "local") void load();
  }, [load, me]);

  async function changeRole(member: MemberView, role: IdentityRole): Promise<void> {
    setBusy(member.userId);
    setError(null);
    try {
      const result = await gatewayRequest<{ members: MemberView[] }>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(member.userId)}`,
        { method: "PATCH", body: { role }, workspaceId }
      );
      setMembers(result.members);
      if (member.you) void refreshAppSession();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(null);
    }
  }

  async function remove(member: MemberView): Promise<void> {
    const leaving = Boolean(member.you);
    const question = leaving
      ? "Leave this workspace? You'll need a new invitation to come back."
      : `Remove ${member.name} from this workspace?`;
    if (!window.confirm(question)) return;
    setBusy(member.userId);
    setError(null);
    try {
      await gatewayRequest(
        leaving
          ? `/api/workspaces/${encodeURIComponent(workspaceId)}/leave`
          : `/api/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(member.userId)}`,
        { method: leaving ? "POST" : "DELETE", workspaceId }
      );
      if (leaving) {
        await refreshAppSession();
        window.location.assign(paths.newChat);
        return;
      }
      await load();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(null);
    }
  }

  async function revoke(invite: InviteView): Promise<void> {
    setBusy(invite.id);
    try {
      await gatewayRequest(`/api/invites/${encodeURIComponent(invite.id)}`, { method: "DELETE", workspaceId });
      setInvites((list) => list.filter((item) => item.id !== invite.id));
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(null);
    }
  }

  // Single-owner install (no accounts yet): explain how to start inviting.
  if (me && me.mode === "local") {
    return (
      <EmptyState
        title="Sibyl is running for one person, without accounts"
        action={
          <ButtonLink variant="primary" href="/setup" outside>
            Create owner account
          </ButtonLink>
        }
      >
        <p>Create an owner account to invite people. Your chats, routines and settings stay as they are.</p>
      </EmptyState>
    );
  }

  return (
    <Stack>
      <Card>
        <CardHeader
          title="Members"
          meta={`People in ${session.currentWorkspace?.name ?? "this workspace"} and what they can do.`}
          actions={
            canInvite ? (
              <Button variant="primary" onClick={() => setInviteOpen(true)}>
                Invite people
              </Button>
            ) : null
          }
        />
        {error ? <Notice tone="danger">{error}</Notice> : null}
        {members === null ? (
          <Muted>Loading members…</Muted>
        ) : (
          <ul className={styles.rows} aria-label="Members">
            {members.map((member) => {
              const editable = canManage && !member.inherited && RANK[member.role] <= RANK[myRole] && !member.you;
              // The last owner can't leave or be removed (the gateway enforces it too).
              const lastOwner = member.role === "owner" && members.filter((m) => m.role === "owner").length <= 1;
              const removable =
                !lastOwner && (member.you ? !member.inherited : canManage && !member.inherited && RANK[member.role] <= RANK[myRole]);
              return (
                <li key={member.userId} className={styles.row}>
                  <span className={styles.avatar} aria-hidden="true">
                    {initials(member.name)}
                  </span>
                  <span className={styles.rowMain}>
                    <span className={styles.rowTitle}>
                      {member.name}
                      {member.you ? <Badge>You</Badge> : null}
                    </span>
                    <span className={styles.rowMeta}>{member.email}</span>
                  </span>
                  <span className={styles.rowEnd}>
                    {editable ? (
                      <Select
                        className={styles.roleSelect}
                        aria-label={`Role for ${member.name}`}
                        value={member.role}
                        disabled={busy === member.userId}
                        onChange={(event) => void changeRole(member, event.target.value as IdentityRole)}
                      >
                        {(Object.keys(ROLE_LABEL) as IdentityRole[])
                          .filter((role) => RANK[role] <= RANK[myRole])
                          .reverse()
                          .map((role) => (
                            <option key={role} value={role}>
                              {ROLE_LABEL[role]}
                            </option>
                          ))}
                      </Select>
                    ) : (
                      <Muted as="span">
                        <span title={member.inherited ? "From the organization" : undefined}>
                          {ROLE_LABEL[member.role]}
                          {member.inherited ? " · organization" : ""}
                        </span>
                      </Muted>
                    )}
                    {removable ? (
                      <Button variant="ghost" size="sm" disabled={busy === member.userId} onClick={() => void remove(member)}>
                        {member.you ? "Leave" : "Remove"}
                      </Button>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {canInvite && invites.length > 0 ? (
        <Card>
          <CardHeader title="Pending invitations" />
          <ul className={styles.rows} aria-label="Pending invitations">
            {invites.map((invite) => (
              <li key={invite.id} className={styles.row}>
                <span className={cx(styles.avatar, styles.avatarPending)} aria-hidden="true">
                  ?
                </span>
                <span className={styles.rowMain}>
                  <span className={styles.rowTitle}>{invite.email ?? "Anyone with the link"}</span>
                  <span className={styles.rowMeta}>
                    {ROLE_LABEL[invite.role]} · expires {new Date(invite.expiresAt).toLocaleDateString()}
                  </span>
                </span>
                <span className={styles.rowEnd}>
                  <Button variant="ghost" size="sm" disabled={busy === invite.id} onClick={() => void revoke(invite)}>
                    Revoke
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {inviteOpen ? (
        <InviteDialog
          workspaceId={workspaceId}
          workspaceName={session.currentWorkspace?.name ?? "this workspace"}
          myRole={myRole}
          smtp={Boolean(me?.smtp)}
          onClose={() => setInviteOpen(false)}
          onCreated={() => void load()}
        />
      ) : null}
    </Stack>
  );
}

/**
 * Invite someone: to one workspace (Settings → Members), or — with
 * `workspaces` — to a workspace picked here (Admin → Users). The role starts
 * at the organization's default (Admin → Organization).
 */
export function InviteDialog(props: {
  workspaceId: string;
  workspaceName: string;
  /** Let the inviter pick the workspace (Admin → Users). */
  workspaces?: ReadonlyArray<{ id: string; name: string }>;
  myRole: IdentityRole;
  smtp: boolean;
  onClose(): void;
  onCreated(): void;
}) {
  const { me } = useAuthState();
  const orgDefault = me?.org?.defaultRole ?? "member";
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<IdentityRole>(RANK[orgDefault] <= RANK[props.myRole] ? orgDefault : "viewer");
  const [workspaceId, setWorkspaceId] = useState(props.workspaceId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<{ url: string; emailed: boolean } | null>(null);
  const [copied, setCopied] = useState(false);
  const roles = (["viewer", "member", "admin", "owner"] as IdentityRole[]).filter((r) => RANK[r] <= RANK[props.myRole]);
  const workspaceName = props.workspaces?.find((w) => w.id === workspaceId)?.name ?? props.workspaceName;

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await gatewayRequest<{ url: string; emailed: boolean }>("/api/invites", {
        method: "POST",
        body: { workspaceId, role, ...(email.trim() ? { email: email.trim() } : {}) },
        workspaceId
      });
      setLink(result);
      props.onCreated();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  async function copy(): Promise<void> {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Couldn't copy. Select the link and copy it yourself.");
    }
  }

  const title = props.workspaces ? "Invite people" : `Invite to ${workspaceName}`;

  if (link) {
    return (
      <Dialog
        title={title}
        onClose={props.onClose}
        actions={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setLink(null);
                setEmail("");
              }}
            >
              Invite someone else
            </Button>
            <Button variant="primary" onClick={props.onClose}>
              Done
            </Button>
          </>
        }
      >
        <Muted>
          {link.emailed ? "We emailed the invitation. You can also share this link:" : "Share this link with the person you're inviting. It works once and expires in 7 days."}
        </Muted>
        <div className={styles.inline}>
          <Input readOnly value={link.url} aria-label="Invitation link" onFocus={(event) => event.target.select()} />
          <Button variant="primary" onClick={() => void copy()}>
            {copied ? "Copied" : "Copy link"}
          </Button>
        </div>
        {error ? <Notice tone="danger">{error}</Notice> : null}
      </Dialog>
    );
  }

  return (
    <Dialog
      title={title}
      onClose={props.onClose}
      onSubmit={(event) => void submit(event)}
      actions={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? "Creating…" : "Create invitation"}
          </Button>
        </>
      }
    >
      <Field
        label={`Email ${props.smtp ? "" : "(optional)"}`}
        hint={props.smtp ? "We'll email the link. Leave empty to only copy it." : "Only this address can use the link. Leave empty for anyone with the link."}
      >
        <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@company.com" />
      </Field>
      {props.workspaces ? (
        <Field label="Workspace">
          <Select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>
            {props.workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      <fieldset className={styles.roles}>
        <legend>Role</legend>
        {roles.map((option) => (
          <label key={option} className={styles.roleOption}>
            <input type="radio" name="invite-role" value={option} checked={role === option} onChange={() => setRole(option)} />
            <span className={styles.rowMain}>
              <span className={styles.rowTitle}>{ROLE_LABEL[option]}</span>
              <span className={styles.rowMeta}>{ROLE_HELP[option]}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </Dialog>
  );
}
