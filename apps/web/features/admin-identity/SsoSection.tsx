"use client";

/**
 * Admin → Single sign-on (Sibyl Enterprise, `sso`): identity providers
 * (OpenID Connect or SAML), the email domains each one claims, enforced SSO
 * with a break-glass owner, and where new people land.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { SsoConfigView, SsoProviderInput, SsoProviderView } from "@open-gpt-live/protocol";
import { errorText } from "../../lib/gateway-http";
import { Badge, Button, Card, CardHeader, Checkbox, Field, Input, Muted, Notice, Row, Select, Stack, Textarea } from "../../components/ui";
import { ssoApi } from "./api";
import { DirectorySettings } from "./DirectorySettings";
import { CopyValue } from "./parts";
import styles from "./identity.module.css";

type Draft = {
  kind: "oidc" | "saml";
  label: string;
  domains: string;
  enabled: boolean;
  issuer: string;
  clientId: string;
  clientSecret: string;
  groupsClaim: string;
  entryPoint: string;
  idpIssuer: string;
  certificate: string;
  emailAttribute: string;
  groupsAttribute: string;
};

const EMPTY: Draft = {
  kind: "oidc",
  label: "",
  domains: "",
  enabled: true,
  issuer: "",
  clientId: "",
  clientSecret: "",
  groupsClaim: "groups",
  entryPoint: "",
  idpIssuer: "",
  certificate: "",
  emailAttribute: "email",
  groupsAttribute: "groups"
};

function draftOf(provider: SsoProviderView): Draft {
  return {
    ...EMPTY,
    kind: provider.kind,
    label: provider.label,
    domains: provider.domains.join(", "),
    enabled: provider.enabled,
    issuer: provider.oidc?.issuer ?? "",
    clientId: provider.oidc?.clientId ?? "",
    groupsClaim: provider.oidc?.groupsClaim ?? "groups",
    entryPoint: provider.saml?.entryPoint ?? "",
    idpIssuer: provider.saml?.idpIssuer ?? "",
    emailAttribute: provider.saml?.emailAttribute ?? "email",
    groupsAttribute: provider.saml?.groupsAttribute ?? "groups"
  };
}

function inputOf(draft: Draft, editing: boolean): SsoProviderInput {
  const domains = draft.domains.split(/[\s,]+/).map((d) => d.trim()).filter(Boolean);
  const base = { ...(editing ? {} : { kind: draft.kind }), label: draft.label, domains, enabled: draft.enabled };
  if (draft.kind === "oidc") {
    return { ...base, oidc: { issuer: draft.issuer, clientId: draft.clientId, groupsClaim: draft.groupsClaim, ...(draft.clientSecret ? { clientSecret: draft.clientSecret } : {}) } };
  }
  return {
    ...base,
    saml: {
      entryPoint: draft.entryPoint,
      idpIssuer: draft.idpIssuer,
      emailAttribute: draft.emailAttribute,
      groupsAttribute: draft.groupsAttribute,
      ...(draft.certificate.trim() ? { certificate: draft.certificate } : {})
    }
  };
}

export function SsoSection() {
  const [config, setConfig] = useState<SsoConfigView | null>(null);
  const [editing, setEditing] = useState<{ id?: string; draft: Draft } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setConfig(await ssoApi.config());
    } catch (cause) {
      setError(errorText(cause));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function run(work: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await work();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (!editing) return;
    void run(async () => {
      const input = inputOf(editing.draft, Boolean(editing.id));
      if (editing.id) await ssoApi.update(editing.id, input);
      else await ssoApi.add(input);
      setEditing(null);
      await load();
      setMessage(editing.id ? "Provider saved." : "Provider added. Register the values below with your identity provider, then try signing in.");
    });
  }

  if (!config) return error ? <Notice tone="danger">{error}</Notice> : <Muted>Loading…</Muted>;
  const set = (patch: Partial<Draft>) => setEditing((current) => (current ? { ...current, draft: { ...current.draft, ...patch } } : current));

  return (
    <Stack>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {message ? <Notice tone="positive">{message}</Notice> : null}

      <Card>
        <CardHeader
          title="Identity providers"
          meta="People whose email is in a provider's domains see “Continue with …” on the sign-in screen."
        />
        {config.providers.length === 0 && !editing ? <Muted>No identity providers yet.</Muted> : null}
        <ul className={styles.rows}>
          {config.providers.map((provider) => (
            <li key={provider.id} className={styles.row}>
              <span className={styles.rowMain}>
                <span className={styles.rowTitle}>
                  {provider.label}
                  <Badge tone="outline">{provider.kind === "oidc" ? "OpenID Connect" : "SAML"}</Badge>
                  {provider.enabled ? null : <Badge tone="warning">Off</Badge>}
                </span>
                <span className={styles.rowMeta}>{provider.domains.join(", ")}</span>
                {provider.oidc ? <CopyValue label="Redirect URI" value={provider.oidc.redirectUri} /> : null}
                {provider.saml ? (
                  <>
                    <CopyValue label="SP entity ID (audience)" value={provider.saml.spEntityId} />
                    <CopyValue label="ACS URL" value={provider.saml.acsUrl} />
                    <span className={styles.rowMeta}>
                      Signing certificate: {provider.saml.certificate ? `${provider.saml.certificate.subject}, valid until ${provider.saml.certificate.expiresAt.slice(0, 10)}` : "unreadable"}
                    </span>
                  </>
                ) : null}
              </span>
              <span className={styles.rowEnd}>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const result = await ssoApi.test(provider.id);
                      if (result.ok) setMessage(result.message);
                      else setError(result.message);
                    })
                  }
                >
                  Check
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing({ id: provider.id, draft: draftOf(provider) })}>
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(`Remove ${provider.label}? People who sign in with it will need another way in.`)) {
                      void run(async () => {
                        await ssoApi.remove(provider.id);
                        await load();
                      });
                    }
                  }}
                >
                  Remove
                </Button>
              </span>
            </li>
          ))}
        </ul>

        {editing ? null : (
          <Row>
            <Button size="sm" onClick={() => setEditing({ draft: EMPTY })}>
              Add provider
            </Button>
          </Row>
        )}
        {editing ? (
          <form onSubmit={submit}>
            <Stack gap={14}>
              <div className={styles.formGrid}>
                {editing.id ? null : (
                  <Field label="Protocol">
                    <Select value={editing.draft.kind} onChange={(event) => set({ kind: event.target.value as Draft["kind"] })}>
                      <option value="oidc">OpenID Connect</option>
                      <option value="saml">SAML 2.0</option>
                    </Select>
                  </Field>
                )}
                <Field label="Name on the sign-in button" hint="For example Okta, Microsoft Entra or Google.">
                  <Input value={editing.draft.label} onChange={(event) => set({ label: event.target.value })} required />
                </Field>
                <Field label="Email domains" hint="Comma-separated, e.g. example.com. Only these addresses can sign in with this provider." className={styles.full}>
                  <Input value={editing.draft.domains} onChange={(event) => set({ domains: event.target.value })} required />
                </Field>
                {editing.draft.kind === "oidc" ? (
                  <>
                    <Field label="Issuer URL" hint="Sibyl reads <issuer>/.well-known/openid-configuration." className={styles.full}>
                      <Input value={editing.draft.issuer} onChange={(event) => set({ issuer: event.target.value })} placeholder="https://example.okta.com" required />
                    </Field>
                    <Field label="Client ID">
                      <Input value={editing.draft.clientId} onChange={(event) => set({ clientId: event.target.value })} required />
                    </Field>
                    <Field label="Client secret" hint={editing.id ? "Leave empty to keep the stored secret." : "Stored encrypted in the vault. Leave empty for a public client (PKCE only)."}>
                      <Input type="password" autoComplete="off" value={editing.draft.clientSecret} onChange={(event) => set({ clientSecret: event.target.value })} />
                    </Field>
                    <Field label="Groups claim" hint="ID token claim listing the person's groups.">
                      <Input value={editing.draft.groupsClaim} onChange={(event) => set({ groupsClaim: event.target.value })} />
                    </Field>
                  </>
                ) : (
                  <>
                    <Field label="Single sign-on URL" hint="The IdP's SAML endpoint (HTTP-Redirect binding)." className={styles.full}>
                      <Input value={editing.draft.entryPoint} onChange={(event) => set({ entryPoint: event.target.value })} required />
                    </Field>
                    <Field label="IdP entity ID (issuer)" hint="Optional; checked when set.">
                      <Input value={editing.draft.idpIssuer} onChange={(event) => set({ idpIssuer: event.target.value })} />
                    </Field>
                    <Field label="Email attribute">
                      <Input value={editing.draft.emailAttribute} onChange={(event) => set({ emailAttribute: event.target.value })} />
                    </Field>
                    <Field label="Groups attribute">
                      <Input value={editing.draft.groupsAttribute} onChange={(event) => set({ groupsAttribute: event.target.value })} />
                    </Field>
                    <Field label="IdP signing certificate (PEM)" hint={editing.id ? "Leave empty to keep the current certificate." : "Assertions must be signed with this certificate."} className={styles.full}>
                      <Textarea mono rows={5} value={editing.draft.certificate} onChange={(event) => set({ certificate: event.target.value })} />
                    </Field>
                  </>
                )}
                <div className={styles.full}>
                  <Checkbox label="Show on the sign-in screen" checked={editing.draft.enabled} onChange={(event) => set({ enabled: event.target.checked })} />
                </div>
              </div>
              <Row>
                <Button type="submit" variant="primary" disabled={busy}>
                  {busy ? "Saving…" : editing.id ? "Save" : "Add provider"}
                </Button>
                <Button variant="ghost" onClick={() => setEditing(null)}>
                  Cancel
                </Button>
              </Row>
            </Stack>
          </form>
        ) : null}
      </Card>

      <Card>
        <CardHeader
          title={
            <>
              Require single sign-on <Badge tone={config.enforce ? "positive" : "outline"}>{config.enforce ? "Required" : "Optional"}</Badge>
            </>
          }
          meta="Password sign-in is refused for emails in the providers' domains. One owner keeps a password (and two-step verification) as a way in if the identity provider is down."
        />
        <Stack gap={12}>
          <Field label="Break-glass owner">
            <Select
              value={config.breakGlassUserId ?? ""}
              disabled={busy}
              onChange={(event) =>
                void run(async () => {
                  setConfig(await ssoApi.saveConfig({ breakGlassUserId: event.target.value || null }));
                })
              }
            >
              <option value="">Choose an owner…</option>
              {config.owners.map((owner) => (
                <option key={owner.id} value={owner.id}>
                  {owner.name} ({owner.email})
                </option>
              ))}
            </Select>
          </Field>
          <Row>
            <Button
              variant={config.enforce ? "secondary" : "primary"}
              disabled={busy || (!config.enforce && config.providers.every((p) => !p.enabled))}
              onClick={() =>
                void run(async () => {
                  setConfig(await ssoApi.saveConfig({ enforce: !config.enforce }));
                })
              }
            >
              {config.enforce ? "Allow passwords again" : "Require SSO"}
            </Button>
          </Row>
        </Stack>
      </Card>

      <DirectorySettings showJit />
    </Stack>
  );
}
