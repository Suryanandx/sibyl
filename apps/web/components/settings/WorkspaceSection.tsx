"use client";

/**
 * Settings → Workspace: the current workspace's name, short icon and
 * instructions (added to every chat in it), its budget, creating another workspace, and
 * deleting this one (owners only; the default workspace stays).
 */
import { useEffect, useState, type FormEvent } from "react";
import type { WorkspaceView } from "@open-gpt-live/protocol";
import { refreshAppSession, useAppSession, useAuthState } from "../../lib/app-session";
import { errorText } from "../../lib/gateway-http";
import { workspacesApi } from "../../features/admin-org/api";
import { BudgetCard } from "../../features/admin-org/BudgetCard";
import { Button, Card, CardHeader, Field, Input, Muted, Notice, Row, Spacer, Stack, Textarea } from "../ui";
import styles from "./settings.module.css";

export default function WorkspaceSection() {
  const session = useAppSession();
  const { me } = useAuthState();
  const workspaceId = session.currentWorkspaceId;
  const view: WorkspaceView | undefined = me?.workspaces.find((workspace) => workspace.id === workspaceId);
  const canEdit = session.can("workspace.settings");
  const canCreate = session.orgRole === "owner" || session.orgRole === "admin";
  const isOwner = (view?.role ?? session.currentWorkspace?.role) === "owner";
  const isDefault = view?.isDefault ?? workspaceId === "default";

  const [name, setName] = useState("");
  const [icon, setIcon] = useState("");
  const [instructions, setInstructions] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    setName(view?.name ?? session.currentWorkspace?.name ?? "");
    setIcon(view?.icon ?? "");
    setInstructions(view?.instructions ?? "");
    setSaved(false);
    setError(null);
  }, [view?.id, view?.name, view?.icon, view?.instructions, session.currentWorkspace?.name]);

  const dirty = Boolean(view) && (name.trim() !== view!.name || icon.trim() !== (view!.icon ?? "") || instructions.trim() !== (view!.instructions ?? ""));

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!canEdit || !dirty) return;
    setSaving(true);
    setError(null);
    try {
      await workspacesApi.update(workspaceId, { name: name.trim(), icon: icon.trim(), instructions: instructions.trim() });
      await refreshAppSession();
      setSaved(true);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setSaving(false);
    }
  }

  async function create(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!newName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const result = await workspacesApi.create(newName.trim());
      await refreshAppSession();
      setNewName("");
      session.switchWorkspace(result.workspace.id);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setCreating(false);
    }
  }

  async function remove(): Promise<void> {
    if (!window.confirm(`Delete ${view?.name ?? "this workspace"}? Members lose access to it. This can't be undone.`)) return;
    setError(null);
    try {
      await workspacesApi.remove(workspaceId);
      await refreshAppSession();
      session.switchWorkspace("default");
    } catch (caught) {
      setError(errorText(caught));
    }
  }

  if (me && !me.authenticated) return null;

  return (
    <Stack aria-label="Workspace">
      <Card as="form" onSubmit={(event) => void save(event)}>
        <CardHeader title="Workspace" meta="Chats, routines and settings are kept per workspace." />
        <div className={styles.fieldRow}>
          <Field label="Name">
            <Input value={name} maxLength={60} disabled={!canEdit} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field label="Initials" className={styles.initials}>
            <Input value={icon} maxLength={4} placeholder="AB" disabled={!canEdit} onChange={(event) => setIcon(event.target.value)} />
          </Field>
        </div>
        <Muted>Initials: up to four characters, shown in the workspace switcher.</Muted>
        <Field label="Instructions" hint="Added to every chat in this workspace.">
          <Textarea
            value={instructions}
            maxLength={8000}
            rows={5}
            disabled={!canEdit}
            placeholder="How Sibyl should work in this workspace: audience, tone, things to always check."
            onChange={(event) => setInstructions(event.target.value)}
          />
        </Field>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        {canEdit ? (
          <Row>
            <Button type="submit" variant="primary" disabled={saving || !dirty || !name.trim()}>
              {saving ? "Saving…" : "Save changes"}
            </Button>
            {saved && !dirty ? (
              <Muted as="span">
                <span role="status">Saved</span>
              </Muted>
            ) : null}
          </Row>
        ) : (
          <Muted>Only workspace admins can change these settings.</Muted>
        )}
      </Card>

      {view && session.can("budgets.manage") ? (
        <BudgetCard
          title="Workspace budget"
          meta="Caps spending in this workspace, on top of the organization budget."
          budget={view.budget ?? {}}
          canEdit
          onSave={async (budget) => {
            await workspacesApi.update(workspaceId, { budget });
            await refreshAppSession();
          }}
        />
      ) : null}

      {canCreate ? (
        <Card as="form" onSubmit={(event) => void create(event)}>
          <CardHeader title="New workspace" />
          <div className={styles.inline}>
            <Input value={newName} maxLength={60} placeholder="Workspace name" aria-label="New workspace name" onChange={(event) => setNewName(event.target.value)} />
            <Button type="submit" disabled={creating || !newName.trim()}>
              {creating ? "Creating…" : "Create"}
            </Button>
          </div>
        </Card>
      ) : null}

      {isOwner && !isDefault ? (
        <Card>
          <Row>
            <div>
              <CardHeader title="Delete workspace" meta="Removes the workspace and everyone’s access to it." />
            </div>
            <Spacer />
            <Button variant="danger" onClick={() => void remove()}>
              Delete
            </Button>
          </Row>
        </Card>
      ) : null}
    </Stack>
  );
}
