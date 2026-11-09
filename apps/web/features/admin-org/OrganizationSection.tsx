"use client";

/**
 * Admin → Organization: the organization's name (workspace switcher,
 * invitation emails), where new people land and the role invitations start
 * with, every workspace with its member count (create, rename, delete through
 * the same workspace routes as Settings → Workspace), the organization budget
 * and a licence summary.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { OrgDefaultRole, OrgView, OrgWorkspaceView } from "@open-gpt-live/protocol";
import { ROLE_HELP, ROLE_LABEL } from "../../components/settings/MembersSection";
import settings from "../../components/settings/settings.module.css";
import { Badge, Button, ButtonLink, Card, CardHeader, Field, Input, Muted, Notice, Row, Select, Stack, cx } from "../../components/ui";
import { refreshAppSession, useAppSession, useAuthState } from "../../lib/app-session";
import { errorText } from "../../lib/gateway-http";
import { paths } from "../../lib/routes";
import { orgApi, workspacesApi } from "./api";
import { BudgetCard } from "./BudgetCard";
import styles from "./admin-org.module.css";
import { ENTERPRISE } from "../../lib/edition";

const DEFAULT_ROLES: OrgDefaultRole[] = ["admin", "member", "viewer"];

export function OrganizationSection() {
  const { me } = useAuthState();
  const [view, setView] = useState<OrgView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setView(await orgApi.get());
      setError(null);
    } catch (caught) {
      setError(errorText(caught));
    }
  }, []);

  // Reload when who we are changes (another admin renamed a workspace, a role changed).
  useEffect(() => {
    void load();
  }, [load, me]);

  if (!view) return error ? <Notice tone="danger">{error}</Notice> : <Muted>Loading the organization…</Muted>;

  return (
    <Stack>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <SettingsCard view={view} onSaved={setView} />
      <BudgetCard
        title="Organization budget"
        meta="Caps spending across every workspace. Each workspace can also have its own (Settings → Workspace)."
        budget={view.settings.budget}
        limits={view.settings.budgetLimits}
        spent={view.settings.spent}
        canEdit
        onSave={async (budget) => setView(await orgApi.save({ budget }))}
      />
      <WorkspacesCard workspaces={view.workspaces} onChanged={load} />
      <LicenceCard license={view.license} />
    </Stack>
  );
}

function SettingsCard({ view, onSaved }: { view: OrgView; onSaved(view: OrgView): void }) {
  const [name, setName] = useState(view.settings.name);
  const [defaultWorkspaceId, setDefaultWorkspaceId] = useState(view.settings.defaultWorkspaceId ?? "");
  const [defaultRole, setDefaultRole] = useState<OrgDefaultRole>(view.settings.defaultRole);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(view.settings.name);
    setDefaultWorkspaceId(view.settings.defaultWorkspaceId ?? "");
    setDefaultRole(view.settings.defaultRole);
  }, [view.settings.name, view.settings.defaultWorkspaceId, view.settings.defaultRole]);

  const dirty =
    name.trim() !== view.settings.name || defaultWorkspaceId !== (view.settings.defaultWorkspaceId ?? "") || defaultRole !== view.settings.defaultRole;

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      onSaved(await orgApi.save({ name: name.trim(), defaultWorkspaceId: defaultWorkspaceId || null, defaultRole }));
      await refreshAppSession();
      setSaved(true);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card as="form" onSubmit={(event) => void save(event)}>
      <CardHeader title="Organization" meta="Shown in the workspace switcher and in invitation emails." />
      <Field label="Name">
        <Input value={name} maxLength={80} placeholder="Your company or team" onChange={(event) => setName(event.target.value)} />
      </Field>
      <div className={settings.fieldRow}>
        <Field label="New people also join" hint="Everyone who accepts an invitation is added to this workspace too.">
          <Select value={defaultWorkspaceId} onChange={(event) => setDefaultWorkspaceId(event.target.value)}>
            <option value="">Only the workspace they're invited to</option>
            {view.workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Default role" hint={`${ROLE_HELP[defaultRole]} Preselected when inviting.`}>
          <Select value={defaultRole} onChange={(event) => setDefaultRole(event.target.value as OrgDefaultRole)}>
            {DEFAULT_ROLES.map((role) => (
              <option key={role} value={role}>
                {ROLE_LABEL[role]}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Row>
        <Button type="submit" variant="primary" disabled={busy || !dirty}>
          {busy ? "Saving…" : "Save changes"}
        </Button>
        {saved && !dirty ? (
          <Muted as="span">
            <span role="status">Saved</span>
          </Muted>
        ) : null}
      </Row>
    </Card>
  );
}

function WorkspacesCard({ workspaces, onChanged }: { workspaces: OrgWorkspaceView[]; onChanged(): Promise<void> }) {
  const session = useAppSession();
  const isOwner = session.orgRole === "owner";
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(key: string, work: () => Promise<unknown>): Promise<void> {
    setBusy(key);
    setError(null);
    try {
      await work();
      await Promise.all([onChanged(), refreshAppSession()]);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(null);
    }
  }

  const rename = (workspace: OrgWorkspaceView) => (event: FormEvent) => {
    event.preventDefault();
    const name = draft.trim();
    if (!name || name === workspace.name) return setEditing(null);
    void run(workspace.id, async () => {
      await workspacesApi.update(workspace.id, { name });
      setEditing(null);
    });
  };

  const remove = (workspace: OrgWorkspaceView) => {
    if (!window.confirm(`Delete ${workspace.name}? Its ${workspace.memberCount} member${workspace.memberCount === 1 ? "" : "s"} lose access to it. This can't be undone.`)) return;
    void run(workspace.id, async () => {
      await workspacesApi.remove(workspace.id);
      if (session.currentWorkspaceId === workspace.id) session.switchWorkspace("default");
    });
  };

  const create = (event: FormEvent) => {
    event.preventDefault();
    const name = newName.trim();
    if (!name) return;
    void run("new", async () => {
      await workspacesApi.create(name);
      setNewName("");
    });
  };

  return (
    <Card>
      <CardHeader title="Workspaces" meta="Chats, knowledge, routines and settings are kept per workspace." />
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <ul className={settings.rows} aria-label="Workspaces">
        {workspaces.map((workspace) => (
          <li key={workspace.id} className={cx(settings.row, styles.row)}>
            <span className={settings.avatar} aria-hidden="true">
              {workspace.icon ?? workspace.name.slice(0, 2).toUpperCase()}
            </span>
            {editing === workspace.id ? (
              <form className={styles.renameForm} onSubmit={rename(workspace)}>
                <Input autoFocus value={draft} maxLength={60} aria-label={`New name for ${workspace.name}`} onChange={(event) => setDraft(event.target.value)} />
                <Button type="submit" size="sm" variant="primary" disabled={busy === workspace.id || !draft.trim()}>
                  Save
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                  Cancel
                </Button>
              </form>
            ) : (
              <>
                <span className={cx(settings.rowMain, styles.main)}>
                  <span className={settings.rowTitle}>
                    {workspace.name}
                    {workspace.isDefault ? <Badge>Default</Badge> : null}
                  </span>
                  <span className={settings.rowMeta}>
                    {workspace.memberCount} {workspace.memberCount === 1 ? "person" : "people"}
                  </span>
                </span>
                <span className={cx(settings.rowEnd, styles.actions)}>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() => {
                      setEditing(workspace.id);
                      setDraft(workspace.name);
                    }}
                  >
                    Rename
                  </Button>
                  {isOwner && !workspace.isDefault ? (
                    <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => remove(workspace)}>
                      Delete
                    </Button>
                  ) : null}
                </span>
              </>
            )}
          </li>
        ))}
      </ul>
      <form className={settings.inline} onSubmit={create}>
        <Input value={newName} maxLength={60} placeholder="New workspace name" aria-label="New workspace name" onChange={(event) => setNewName(event.target.value)} />
        <Button type="submit" disabled={busy === "new" || !newName.trim()}>
          {busy === "new" ? "Creating…" : "Create workspace"}
        </Button>
      </form>
      {!isOwner ? <Muted>Only organization owners can delete workspaces.</Muted> : null}
    </Card>
  );
}

function LicenceCard({ license }: { license: OrgView["license"] }) {
  const enterprise = license.edition === "enterprise";
  const seats = license.seats !== undefined ? `${license.activeUsers} of ${license.seats} seats in use` : `${license.activeUsers} active ${license.activeUsers === 1 ? "person" : "people"}`;
  const status =
    license.status === "expired" ? "Licence expired — running as the open-source edition." : license.status === "invalid" ? "The licence key isn't valid — running as the open-source edition." : null;
  return (
    <Card>
      <CardHeader
        title="Licence"
        actions={
          <ButtonLink variant="ghost" size="sm" href={paths.settings("licence")}>
            {enterprise ? "Licence details" : "Add a licence key"}
          </ButtonLink>
        }
      />
      <dl className={settings.facts}>
        <div>
          <dt>Edition</dt>
          <dd>{enterprise ? `Enterprise (${ENTERPRISE.name})` : "Open source"}</dd>
        </div>
        {license.licensee ? (
          <div>
            <dt>Licensed to</dt>
            <dd>{license.licensee}</dd>
          </div>
        ) : null}
        <div>
          <dt>People</dt>
          <dd>{seats}</dd>
        </div>
        {license.expiresAt ? (
          <div>
            <dt>Expires</dt>
            <dd>{new Date(license.expiresAt).toLocaleDateString()}</dd>
          </div>
        ) : null}
      </dl>
      {status ? <Notice tone="warning">{status}</Notice> : null}
      {license.seats !== undefined && license.activeUsers > license.seats ? (
        <Notice tone="warning">More people are active than the licence has seats. Turn off accounts or add seats.</Notice>
      ) : null}
    </Card>
  );
}
