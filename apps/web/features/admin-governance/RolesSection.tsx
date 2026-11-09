"use client";

/**
 * Admin → Roles (Sibyl Enterprise, `custom_roles`): custom roles built from
 * the permission catalogue, who has them (organization-wide or in one
 * workspace), and which roles or people may use each shared connection.
 * The gateway enforces all of it through authorize().
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type { AdminCustomRoleView, AdminResourceGrantView, AdminRolesState } from "@open-gpt-live/protocol";
import { errorText } from "../../lib/gateway-http";
import { Badge, Button, Card, CardHeader, Checkbox, Field, Input, Muted, Notice, Row, Select, Stack } from "../../components/ui";
import { governanceApi, groupPermissions } from "./api";
import styles from "./admin-governance.module.css";

type Draft = { id?: string; name: string; description: string; permissions: string[] };

export function RolesSection() {
  const [state, setState] = useState<AdminRolesState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);

  const load = useCallback(async () => {
    try {
      setState(await governanceApi.roles());
      setError(null);
    } catch (cause) {
      setError(errorText(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (work: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setNotice(null);
    try {
      await work();
      setError(null);
      if (done) setNotice(done);
      await load();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  if (!state) return error ? <Notice tone="danger">{error}</Notice> : <Muted>Loading roles…</Muted>;

  const roleName = (roleId: string) =>
    state.roles.find((r) => r.id === roleId)?.name ?? state.builtInRoles.find((r) => r.id === roleId)?.name ?? roleId;
  const personName = (userId: string) => {
    const person = state.people.find((p) => p.id === userId);
    return person ? `${person.name} (${person.email})` : userId;
  };
  const scopeName = (scope: string) => (scope === "org" ? "Whole organization" : state.workspaces.find((w) => w.id === scope)?.name ?? scope);

  return (
    <Stack>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {notice ? <Notice tone="positive">{notice}</Notice> : null}

      <Card>
        <CardHeader
          title="Custom roles"
          meta="A custom role decides what a person may do instead of their built-in role (Owner, Admin, Member, Viewer). Organization owners are never limited."
          actions={
            draft ? null : (
              <Button variant="primary" size="sm" onClick={() => setDraft({ name: "", description: "", permissions: ["chat.use"] })}>
                New role
              </Button>
            )
          }
        />
        {draft ? (
          <RoleEditor
            draft={draft}
            permissions={state.permissions}
            busy={busy}
            onChange={setDraft}
            onCancel={() => setDraft(null)}
            onSave={() =>
              void run(async () => {
                await governanceApi.saveRole(draft.id, { name: draft.name, description: draft.description, permissions: draft.permissions });
                setDraft(null);
              }, draft.id ? "Role saved." : "Role created.")
            }
          />
        ) : null}
        {state.roles.length === 0 && !draft ? <Muted>No custom roles yet. Everyone uses the built-in roles.</Muted> : null}
        <ul className={styles.rows}>
          {state.roles.map((role) => (
            <li key={role.id} className={styles.row}>
              <span className={styles.rowMain}>
                <span className={styles.rowTitle}>
                  {role.name}
                  <Badge tone="outline">{role.permissions.length} permissions</Badge>
                </span>
                {role.description ? <span className={styles.rowMeta}>{role.description}</span> : null}
                <span className={styles.details}>{role.permissions.join(", ")}</span>
              </span>
              <span className={styles.rowEnd}>
                <Button size="sm" disabled={busy} onClick={() => setDraft({ id: role.id, name: role.name, description: role.description ?? "", permissions: role.permissions })}>
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(`Delete the role “${role.name}”? People who have it go back to their built-in role.`)) {
                      void run(() => governanceApi.deleteRole(role.id), "Role deleted.");
                    }
                  }}
                >
                  Delete
                </Button>
              </span>
            </li>
          ))}
        </ul>
      </Card>

      <Assignments state={state} busy={busy} roleName={roleName} personName={personName} scopeName={scopeName} run={run} />
      <Grants state={state} busy={busy} roleName={roleName} personName={personName} run={run} />
    </Stack>
  );
}

function RoleEditor({
  draft,
  permissions,
  busy,
  onChange,
  onCancel,
  onSave
}: {
  draft: Draft;
  permissions: AdminRolesState["permissions"];
  busy: boolean;
  onChange(draft: Draft): void;
  onCancel(): void;
  onSave(): void;
}) {
  const toggle = (permission: string, on: boolean) =>
    onChange({ ...draft, permissions: on ? [...draft.permissions, permission] : draft.permissions.filter((p) => p !== permission) });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave();
  };
  return (
    <Card as="form" onSubmit={submit}>
      <div className={styles.formGrid}>
        <Field label="Name">
          <Input value={draft.name} maxLength={60} required onChange={(e) => onChange({ ...draft, name: e.target.value })} placeholder="e.g. Sales" />
        </Field>
        <Field label="Description">
          <Input value={draft.description} maxLength={300} onChange={(e) => onChange({ ...draft, description: e.target.value })} placeholder="What this role is for" />
        </Field>
      </div>
      {groupPermissions(permissions).map((group) => (
        <fieldset key={group.area} className={styles.group}>
          <legend>{group.area}</legend>
          <div className={styles.checks}>
            {group.items.map((permission) => (
              <Checkbox
                key={permission.id}
                label={
                  <span className={styles.mono}>
                    {permission.id}
                    {permission.org ? " (org-wide assignments only)" : ""}
                  </span>
                }
                checked={draft.permissions.includes(permission.id)}
                onChange={(e) => toggle(permission.id, e.target.checked)}
              />
            ))}
          </div>
        </fieldset>
      ))}
      <Row>
        <Button type="submit" variant="primary" disabled={busy || !draft.name.trim()}>
          {draft.id ? "Save role" : "Create role"}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </Row>
    </Card>
  );
}

function Assignments({
  state,
  busy,
  roleName,
  personName,
  scopeName,
  run
}: {
  state: AdminRolesState;
  busy: boolean;
  roleName(id: string): string;
  personName(id: string): string;
  scopeName(scope: string): string;
  run(work: () => Promise<unknown>, done?: string): Promise<void>;
}) {
  const [userId, setUserId] = useState("");
  const [scope, setScope] = useState("org");
  const [roleId, setRoleId] = useState("");
  const ready = userId && roleId;
  return (
    <Card>
      <CardHeader title="Who has a custom role" meta="Organization-wide, or in one workspace (a workspace assignment wins there)." />
      {state.assignments.length === 0 ? <Muted>Nobody has a custom role.</Muted> : null}
      <ul className={styles.rows}>
        {state.assignments.map((a) => (
          <li key={`${a.userId}:${a.scope}`} className={styles.row}>
            <span className={styles.rowMain}>
              <span className={styles.rowTitle}>{personName(a.userId)}</span>
              <span className={styles.rowMeta}>
                {roleName(a.roleId)} · {scopeName(a.scope)}
              </span>
            </span>
            <Button size="sm" disabled={busy} onClick={() => void run(() => governanceApi.assign({ userId: a.userId, scope: a.scope, roleId: null }), "Custom role removed.")}>
              Remove
            </Button>
          </li>
        ))}
      </ul>
      {state.roles.length ? (
        <div className={styles.formGrid}>
          <Field label="Person">
            <Select value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">Choose…</option>
              {state.people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.email})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Where">
            <Select value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="org">Whole organization</option>
              {state.workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Role">
            <Select value={roleId} onChange={(e) => setRoleId(e.target.value)}>
              <option value="">Choose…</option>
              {state.roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      ) : null}
      {state.roles.length ? (
        <Row>
          <Button disabled={busy || !ready} onClick={() => void run(() => governanceApi.assign({ userId, scope, roleId }), "Role assigned.")}>
            Assign role
          </Button>
        </Row>
      ) : null}
    </Card>
  );
}

function Grants({
  state,
  busy,
  roleName,
  personName,
  run
}: {
  state: AdminRolesState;
  busy: boolean;
  roleName(id: string): string;
  personName(id: string): string;
  run(work: () => Promise<unknown>, done?: string): Promise<void>;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [roles, setRoles] = useState<string[]>([]);
  const [people, setPeople] = useState<string[]>([]);
  const grantFor = useMemo(() => new Map(state.grants.map((g) => [g.resource.id, g] as const)), [state.grants]);
  const allRoles: Array<Pick<AdminCustomRoleView, "id" | "name">> = [...state.builtInRoles, ...state.roles];
  const open = (connectionId: string, grant: AdminResourceGrantView | undefined) => {
    setEditing(connectionId);
    setRoles(grant?.roles ?? []);
    setPeople(grant?.userIds ?? []);
  };
  const flip = (list: string[], value: string, on: boolean) => (on ? [...list, value] : list.filter((v) => v !== value));
  return (
    <Card>
      <CardHeader title="Who may use each shared connection" meta="Without a rule, everyone who may use integrations in the workspace can use it. Organization owners always can." />
      {state.connections.length === 0 ? <Muted>No shared connections yet. Connect one in Integrations, shared with a workspace.</Muted> : null}
      <ul className={styles.rows}>
        {state.connections.map((connection) => {
          const grant = grantFor.get(connection.id);
          return (
            <li key={connection.id} className={styles.row}>
              <span className={styles.rowMain}>
                <span className={styles.rowTitle}>
                  {connection.name}
                  <Badge tone="outline">{connection.connectorId}</Badge>
                </span>
                <span className={styles.rowMeta}>
                  {grant ? `Only: ${[...grant.roles.map(roleName), ...grant.userIds.map(personName)].join(", ")}` : "Everyone with integrations access"}
                </span>
              </span>
              {editing === connection.id ? null : (
                <Button size="sm" disabled={busy} onClick={() => open(connection.id, grant)}>
                  Change
                </Button>
              )}
              {editing === connection.id ? (
                <Stack className={styles.rowMain}>
                  <fieldset className={styles.group}>
                    <legend>Roles</legend>
                    <div className={styles.checks}>
                      {allRoles.map((role) => (
                        <Checkbox key={role.id} label={role.name} checked={roles.includes(role.id)} onChange={(e) => setRoles(flip(roles, role.id, e.target.checked))} />
                      ))}
                    </div>
                  </fieldset>
                  <fieldset className={styles.group}>
                    <legend>People</legend>
                    <div className={styles.checks}>
                      {state.people.map((person) => (
                        <Checkbox key={person.id} label={person.name} checked={people.includes(person.id)} onChange={(e) => setPeople(flip(people, person.id, e.target.checked))} />
                      ))}
                    </div>
                  </fieldset>
                  <Row>
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await governanceApi.setGrant({ resource: { kind: "connection", id: connection.id, name: connection.name }, roles, userIds: people });
                          setEditing(null);
                        }, roles.length || people.length ? "Access rule saved." : "Access rule removed.")
                      }
                    >
                      Save
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                      Cancel
                    </Button>
                  </Row>
                </Stack>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
