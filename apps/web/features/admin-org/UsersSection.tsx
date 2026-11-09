"use client";

/**
 * Admin → Users: everyone in the organization across workspaces — role,
 * workspaces, last activity, how they sign in, on or off — and pending
 * invitations everywhere. Owners and admins change organization roles, turn
 * accounts off and on, remove people, and resend or revoke invitations. With
 * Sibyl Enterprise, single sign-on shows as the sign-in method and accounts
 * the identity provider manages (SCIM) are read-only.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { IdentityRole, OrgInviteView, OrgUserView } from "@open-gpt-live/protocol";
import { InviteDialog, RANK, ROLE_LABEL, initials } from "../../components/settings/MembersSection";
import settings from "../../components/settings/settings.module.css";
import { Badge, Button, ButtonLink, Card, CardHeader, EmptyState, Input, Muted, Notice, Select, Stack, cx } from "../../components/ui";
import { refreshAppSession, useAppSession, useAuthState } from "../../lib/app-session";
import { errorText } from "../../lib/gateway-http";
import { usersApi } from "./api";
import styles from "./admin-org.module.css";

type StatusFilter = "all" | "active" | "disabled";
type RoleFilter = "any" | IdentityRole;

export function UsersSection() {
  const session = useAppSession();
  const { me } = useAuthState();
  const myRole = session.orgRole;
  const sso = session.hasFeature("sso");
  const scim = session.hasFeature("scim");
  const [users, setUsers] = useState<OrgUserView[] | null>(null);
  const [invites, setInvites] = useState<OrgInviteView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; url?: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [role, setRole] = useState<RoleFilter>("any");
  const [inviteOpen, setInviteOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await usersApi.list();
      setUsers(result.users);
      setInvites(result.invites);
      setError(null);
    } catch (caught) {
      setUsers((current) => current ?? []);
      setError(errorText(caught));
    }
  }, []);

  // Reload whenever who we are changes (pushed over the socket after any identity change).
  useEffect(() => {
    if (me && me.mode !== "local") void load();
  }, [load, me]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (users ?? []).filter(
      (user) =>
        (status === "all" || user.status === status) &&
        (role === "any" || user.orgRole === role) &&
        (!q || user.name.toLowerCase().includes(q) || user.email.includes(q) || user.workspaces.some((w) => w.name.toLowerCase().includes(q)))
    );
  }, [users, query, status, role]);

  async function act(key: string, work: () => Promise<unknown>, done?: string): Promise<void> {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await work();
      if (done) setNotice({ text: done });
      await load();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(null);
    }
  }

  const changeRole = (user: OrgUserView, next: IdentityRole) =>
    act(user.id, async () => {
      await usersApi.update(user.id, { orgRole: next });
      if (user.you) await refreshAppSession();
    });

  const setActive = (user: OrgUserView, active: boolean) => {
    if (!active && !window.confirm(`Turn off ${user.name}'s account? They are signed out everywhere and can't sign in until it's turned on again.`)) return;
    void act(user.id, () => usersApi.update(user.id, { active }), active ? `${user.name} can sign in again.` : `${user.name} is signed out and can't sign in.`);
  };

  const remove = (user: OrgUserView) => {
    if (!window.confirm(`Remove ${user.name} from the organization? They lose every workspace and are signed out. Invite them again to bring them back.`)) return;
    void act(user.id, () => usersApi.remove(user.id), `${user.name} was removed.`);
  };

  const resend = (invite: OrgInviteView) =>
    act(invite.id, async () => {
      const result = await usersApi.resendInvite(invite.id);
      setNotice({
        text: result.emailed ? `Sent a new invitation to ${invite.email}. The old link no longer works.` : "Here is the new link. The old one no longer works.",
        ...(result.emailed ? {} : { url: result.url })
      });
    });

  const revoke = (invite: OrgInviteView) => act(invite.id, () => usersApi.revokeInvite(invite.id));

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
        <p>Create an owner account to invite people and manage them here.</p>
      </EmptyState>
    );
  }

  const owners = (users ?? []).filter((u) => u.orgRole === "owner" && u.status === "active").length;

  return (
    <Stack>
      <Card>
        <CardHeader
          title="People"
          meta={users ? `${users.filter((u) => u.status === "active").length} active · ${users.length} in total` : undefined}
          actions={
            <Button variant="primary" onClick={() => setInviteOpen(true)}>
              Invite people
            </Button>
          }
        />
        <div className={styles.filters}>
          <Input type="search" value={query} placeholder="Search name, email or workspace" aria-label="Search people" onChange={(event) => setQuery(event.target.value)} />
          <Select aria-label="Status" value={status} onChange={(event) => setStatus(event.target.value as StatusFilter)}>
            <option value="all">Everyone</option>
            <option value="active">Active</option>
            <option value="disabled">Turned off</option>
          </Select>
          <Select aria-label="Organization role" value={role} onChange={(event) => setRole(event.target.value as RoleFilter)}>
            <option value="any">Any role</option>
            {(["owner", "admin", "member", "viewer"] as IdentityRole[]).map((option) => (
              <option key={option} value={option}>
                {ROLE_LABEL[option]}s
              </option>
            ))}
          </Select>
        </div>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        {notice ? (
          <Notice tone="positive">
            {notice.text}
            {notice.url ? <Input readOnly className={styles.link} value={notice.url} aria-label="New invitation link" onFocus={(event) => event.target.select()} /> : null}
          </Notice>
        ) : null}
        {users === null ? (
          <Muted>Loading people…</Muted>
        ) : shown.length === 0 ? (
          <Muted>No one matches.</Muted>
        ) : (
          <ul className={settings.rows} aria-label="People">
            {shown.map((user) => {
              const managed = scim && user.managedBy === "scim";
              const above = RANK[user.orgRole] > RANK[myRole];
              const lastOwner = user.orgRole === "owner" && owners <= 1;
              const canRole = !above && !(lastOwner && user.status === "active");
              const canStatus = !above && !user.you && !managed && !(lastOwner && user.status === "active");
              return (
                <li key={user.id} className={cx(settings.row, styles.row, styles.person, user.status === "disabled" && settings.off)}>
                  <span className={settings.avatar} aria-hidden="true">
                    {initials(user.name)}
                  </span>
                  <span className={cx(settings.rowMain, styles.main)}>
                    <span className={settings.rowTitle}>
                      {user.name}
                      {user.you ? <Badge>You</Badge> : null}
                      {user.status === "disabled" ? <Badge tone="warning">Turned off</Badge> : null}
                    </span>
                    <span className={settings.rowMeta}>{user.email}</span>
                    <span className={settings.rowMeta}>{workspaceText(user)}</span>
                    <span className={settings.rowMeta}>
                      {signInText(user, sso)} · {user.lastActiveAt ? `active ${timeAgo(user.lastActiveAt)}` : "never signed in"}
                    </span>
                    {managed ? <span className={styles.managed}>Managed by your identity provider</span> : null}
                  </span>
                  <span className={cx(settings.rowEnd, styles.actions)}>
                    {canRole ? (
                      <Select
                        className={settings.roleSelect}
                        aria-label={`Organization role for ${user.name}`}
                        value={user.orgRole}
                        disabled={busy === user.id}
                        onChange={(event) => void changeRole(user, event.target.value as IdentityRole)}
                      >
                        {(["owner", "admin", "member", "viewer"] as IdentityRole[])
                          .filter((option) => RANK[option] <= RANK[myRole])
                          .map((option) => (
                            <option key={option} value={option}>
                              {ROLE_LABEL[option]}
                            </option>
                          ))}
                      </Select>
                    ) : (
                      <Muted as="span">
                        <span title={lastOwner ? "The organization needs an owner" : undefined}>{ROLE_LABEL[user.orgRole]}</span>
                      </Muted>
                    )}
                    {canStatus ? (
                      <>
                        <Button size="sm" variant="ghost" disabled={busy === user.id} onClick={() => setActive(user, user.status === "disabled")}>
                          {user.status === "disabled" ? "Turn on" : "Turn off"}
                        </Button>
                        <Button size="sm" variant="ghost" disabled={busy === user.id} onClick={() => remove(user)}>
                          Remove
                        </Button>
                      </>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <Muted>Organization owners and admins can open every workspace. Workspace roles are changed in each workspace's Members settings.</Muted>
      </Card>

      {invites.length > 0 ? (
        <Card>
          <CardHeader title="Pending invitations" meta="In every workspace." />
          <ul className={settings.rows} aria-label="Pending invitations">
            {invites.map((invite) => (
              <li key={invite.id} className={cx(settings.row, styles.row)}>
                <span className={cx(settings.avatar, settings.avatarPending)} aria-hidden="true">
                  ?
                </span>
                <span className={cx(settings.rowMain, styles.main)}>
                  <span className={settings.rowTitle}>{invite.email ?? "Anyone with the link"}</span>
                  <span className={settings.rowMeta}>
                    {ROLE_LABEL[invite.role]} in {invite.workspaceName} · invited by {invite.invitedByName} · expires {new Date(invite.expiresAt).toLocaleDateString()}
                  </span>
                </span>
                <span className={cx(settings.rowEnd, styles.actions)}>
                  {RANK[invite.role] <= RANK[myRole] ? (
                    <Button size="sm" variant="ghost" disabled={busy === invite.id} onClick={() => void resend(invite)}>
                      Resend
                    </Button>
                  ) : null}
                  <Button size="sm" variant="ghost" disabled={busy === invite.id} onClick={() => void revoke(invite)}>
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
          workspaceId={session.currentWorkspaceId}
          workspaceName={session.currentWorkspace?.name ?? "this workspace"}
          workspaces={session.workspaces}
          myRole={myRole}
          smtp={Boolean(me?.smtp)}
          onClose={() => setInviteOpen(false)}
          onCreated={() => void load()}
        />
      ) : null}
    </Stack>
  );
}

function workspaceText(user: OrgUserView): string {
  const listed = user.workspaces.map((w) => `${w.name} (${ROLE_LABEL[w.role].toLowerCase()})`).join(", ");
  if (user.orgRole === "owner" || user.orgRole === "admin") return listed ? `Every workspace · ${listed}` : "Every workspace";
  return listed || "No workspace yet";
}

function signInText(user: OrgUserView, sso: boolean): string {
  const parts: string[] = [];
  if (sso && user.signIn.sso?.length) parts.push(`SSO (${user.signIn.sso.join(", ")})`);
  if (user.signIn.password) parts.push(user.signIn.twoStep ? "Password + two-step" : "Password");
  if (parts.length === 0) parts.push(sso ? "SSO" : "No password");
  return parts.join(" · ");
}

function timeAgo(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  return `on ${new Date(at).toLocaleDateString()}`;
}
