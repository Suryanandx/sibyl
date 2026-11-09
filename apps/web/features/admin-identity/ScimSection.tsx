"use client";

/**
 * Admin → Provisioning (SCIM) (Sibyl Enterprise, `scim`): the SCIM base URL
 * and bearer tokens for the identity provider, and where provisioned people
 * land. A token is shown once; only its hash is kept.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { ScimTokenView } from "@open-gpt-live/protocol";
import { errorText } from "../../lib/gateway-http";
import { Button, Card, CardHeader, Field, Input, Muted, Notice, Row, Stack } from "../../components/ui";
import { scimApi } from "./api";
import { DirectorySettings } from "./DirectorySettings";
import { CopyValue, OnceSecret } from "./parts";
import styles from "./identity.module.css";

export function ScimSection() {
  const [tokens, setTokens] = useState<ScimTokenView[] | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [label, setLabel] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await scimApi.list();
      setTokens(result.tokens);
      setBaseUrl(result.baseUrl);
    } catch (cause) {
      setError(errorText(cause));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function create(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await scimApi.create(label.trim() || "SCIM token");
      setSecret(created.secret);
      setLabel("");
      await load();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(token: ScimTokenView): Promise<void> {
    if (!window.confirm(`Revoke “${token.label}”? The identity provider using it stops syncing.`)) return;
    setBusy(true);
    try {
      await scimApi.revoke(token.id);
      await load();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  if (!tokens) return error ? <Notice tone="danger">{error}</Notice> : <Muted>Loading…</Muted>;

  return (
    <Stack>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Card>
        <CardHeader title="Connect your identity provider" meta="Okta, Microsoft Entra ID, JumpCloud and others create, update and turn off accounts and groups here." />
        <Stack gap={12}>
          <CopyValue label="SCIM base URL" value={baseUrl} />
          <Muted>
            Removing someone in the identity provider turns their Sibyl account off and signs them out everywhere at once. Their chats and work stay.
          </Muted>
        </Stack>
      </Card>

      <Card>
        <CardHeader title="Tokens" meta="The identity provider sends one as a Bearer token." />
        <Stack gap={12}>
          {secret ? (
            <Stack gap={8}>
              <Notice tone="warning">Copy this token now. It won&apos;t be shown again.</Notice>
              <OnceSecret label="SCIM token" value={secret} />
              <Row>
                <Button size="sm" onClick={() => setSecret(null)}>
                  Done
                </Button>
              </Row>
            </Stack>
          ) : null}
          {tokens.length ? (
            <ul className={styles.rows}>
              {tokens.map((token) => (
                <li key={token.id} className={styles.row}>
                  <span className={styles.rowMain}>
                    <span className={styles.rowTitle}>{token.label}</span>
                    <span className={styles.rowMeta}>
                      {token.prefix}… · created {new Date(token.createdAt).toLocaleDateString()}
                      {token.lastUsedAt ? ` · last used ${new Date(token.lastUsedAt).toLocaleString()}` : " · not used yet"}
                    </span>
                  </span>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void revoke(token)}>
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <Muted>No tokens yet.</Muted>
          )}
          <form onSubmit={(event) => void create(event)}>
            <Row>
              <Field label="New token name">
                <Input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Okta" maxLength={60} />
              </Field>
              <Button type="submit" variant="primary" disabled={busy}>
                Create token
              </Button>
            </Row>
          </form>
        </Stack>
      </Card>

      <DirectorySettings showJit={false} />
    </Stack>
  );
}
