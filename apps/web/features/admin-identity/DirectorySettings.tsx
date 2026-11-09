"use client";

/**
 * Where people from the identity provider land (SSO just-in-time accounts
 * and SCIM), and group → workspace role rules. Shown on both the Single
 * sign-on and Provisioning (SCIM) sections: one setting, used by both.
 */
import { useCallback, useEffect, useState } from "react";
import type { DirectorySettingsView, GroupRoleRule } from "@open-gpt-live/protocol";
import { errorText } from "../../lib/gateway-http";
import { Button, Card, CardHeader, Checkbox, Field, Input, Muted, Notice, Row, Select, Stack } from "../../components/ui";
import { directoryApi } from "./api";
import styles from "./identity.module.css";

const ROLES: Array<GroupRoleRule["role"]> = ["admin", "member", "viewer"];

export function DirectorySettings({ showJit }: { showJit: boolean }) {
  const [view, setView] = useState<DirectorySettingsView | null>(null);
  const [rules, setRules] = useState<GroupRoleRule[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await directoryApi.get();
      setView(next);
      setRules(next.groupRoles);
    } catch (cause) {
      setError(errorText(cause));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function save(input: Parameters<typeof directoryApi.save>[0]): Promise<void> {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const next = await directoryApi.save(input);
      setView(next);
      setRules(next.groupRoles);
      setSaved(true);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  if (!view) return error ? <Notice tone="danger">{error}</Notice> : <Muted>Loading…</Muted>;
  const firstWorkspace = view.workspaces[0]?.id ?? "default";

  return (
    <Card>
      <CardHeader title="New people and groups" meta="Accounts the identity provider creates, and the workspace roles its groups give." />
      <Stack gap={14}>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <div className={styles.formGrid}>
          <Field label="New people join">
            <Select value={view.defaultWorkspaceId} disabled={busy} onChange={(event) => void save({ defaultWorkspaceId: event.target.value })}>
              {view.workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="as">
            <Select value={view.defaultRole} disabled={busy} onChange={(event) => void save({ defaultRole: event.target.value })}>
              {ROLES.map((role) => (
                <option key={role} value={role}>
                  {role[0]!.toUpperCase() + role.slice(1)}
                </option>
              ))}
            </Select>
          </Field>
          {showJit ? (
            <div className={styles.full}>
              <Checkbox
                label="Create an account the first time someone signs in with SSO"
                checked={view.jitProvisioning}
                disabled={busy}
                onChange={(event) => void save({ jitProvisioning: event.target.checked })}
              />
            </div>
          ) : null}
        </div>

        <Stack gap={8}>
          <Muted>
            Group rules: people in a group (from the SSO groups claim or a SCIM group) get that role in the workspace. Leaving the group takes it back; roles given
            by hand are never lowered.
          </Muted>
          {rules.map((rule, index) => (
            <div key={index} className={styles.rule}>
              <Field label="Group">
                <Input value={rule.group} onChange={(event) => setRules(rules.map((r, i) => (i === index ? { ...r, group: event.target.value } : r)))} />
              </Field>
              <Field label="Workspace">
                <Select value={rule.workspaceId} onChange={(event) => setRules(rules.map((r, i) => (i === index ? { ...r, workspaceId: event.target.value } : r)))}>
                  {view.workspaces.map((workspace) => (
                    <option key={workspace.id} value={workspace.id}>
                      {workspace.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Role">
                <Select value={rule.role} onChange={(event) => setRules(rules.map((r, i) => (i === index ? { ...r, role: event.target.value as GroupRoleRule["role"] } : r)))}>
                  {ROLES.map((role) => (
                    <option key={role} value={role}>
                      {role[0]!.toUpperCase() + role.slice(1)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button variant="ghost" size="sm" aria-label={`Remove the rule for ${rule.group || "this group"}`} onClick={() => setRules(rules.filter((_, i) => i !== index))}>
                Remove
              </Button>
            </div>
          ))}
          <Row>
            <Button size="sm" onClick={() => setRules([...rules, { group: "", workspaceId: firstWorkspace, role: "member" }])}>
              Add rule
            </Button>
            <Button size="sm" variant="primary" disabled={busy || rules.some((r) => !r.group.trim())} onClick={() => void save({ groupRoles: rules })}>
              Save rules
            </Button>
            {saved ? <Muted as="span">Saved.</Muted> : null}
          </Row>
        </Stack>
      </Stack>
    </Card>
  );
}
