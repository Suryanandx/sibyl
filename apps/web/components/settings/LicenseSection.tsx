"use client";

/**
 * Settings → Licence: which edition is running and what the licence key
 * enables. The owner can paste or remove a key (stored by the gateway, never
 * shown again). Reads GET /api/license; see LICENSING.md.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useAppSession } from "../../lib/app-session";
import { errorText, gatewayRequest } from "../../lib/gateway-http";
import { Badge, Button, Card, CardHeader, Field, Muted, Notice, Row, Stack, Textarea } from "../ui";
import styles from "./settings.module.css";
import { ENTERPRISE } from "../../lib/edition";

interface LicenseFeatureView {
  id: string;
  title: string;
  description: string;
  enabled: boolean;
}

interface LicenseState {
  edition: "oss" | "enterprise";
  status: "none" | "valid" | "expired" | "invalid";
  reason?: string;
  features: string[];
  licensee?: string;
  seats?: number;
  expiresAt?: string;
  source: "env" | "stored" | "none";
  catalog: LicenseFeatureView[];
  restartRequired: boolean;
}

function formatDate(iso: string | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

export default function LicenseSection() {
  const session = useAppSession();
  const isOwner = session.orgRole === "owner";
  const [state, setState] = useState<LicenseState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await gatewayRequest<LicenseState>("/api/license"));
      setError(null);
    } catch (cause) {
      setError(`Couldn't load the licence: ${errorText(cause)}`);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function apply(event: FormEvent): Promise<void> {
    event.preventDefault();
    const key = draft.trim();
    if (!key) return;
    setBusy(true);
    setNotice(null);
    try {
      const next = await gatewayRequest<LicenseState>("/api/license", { method: "POST", body: { key } });
      setState(next);
      setDraft("");
      setError(null);
      setNotice(next.restartRequired ? "Licence saved. Restart Sibyl to load the enterprise modules." : "Licence saved.");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    setBusy(true);
    setNotice(null);
    try {
      setState(await gatewayRequest<LicenseState>("/api/license", { method: "DELETE" }));
      setError(null);
      setNotice("Licence removed. Sibyl now runs as the open source edition.");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  if (!state) {
    return error ? <Notice tone="danger">{error}</Notice> : <Muted>Loading licence…</Muted>;
  }

  const enterprise = state.edition === "enterprise";
  const canEdit = isOwner && state.source !== "env";

  return (
    <Stack>
      <Card>
        <CardHeader title={enterprise ? `${ENTERPRISE.name} licence` : "Open source edition"} actions={<Badge tone={enterprise ? "accent" : "neutral"}>{enterprise ? "Enterprise" : "MIT"}</Badge>} />
        {enterprise ? (
          <dl className={styles.facts}>
            <div>
              <dt>Licensed to</dt>
              <dd>{state.licensee}</dd>
            </div>
            <div>
              <dt>Seats</dt>
              <dd>{state.seats ?? "—"}</dd>
            </div>
            <div>
              <dt>Expires</dt>
              <dd>{formatDate(state.expiresAt)}</dd>
            </div>
          </dl>
        ) : (
          <Muted>
            Sibyl is free and open source (MIT), including teams and workspaces. The enterprise controls — custom roles, policies, SSO, SCIM, the audit
            log, advanced usage controls, call recordings and the HubSpot and Salesforce connectors — come with a licence from {ENTERPRISE.name} by{" "}
            {ENTERPRISE.by}.{" "}
            <a href={ENTERPRISE.url} target="_blank" rel="noreferrer">
              {ENTERPRISE.contactLabel}
            </a>
          </Muted>
        )}
        {state.status === "expired" ? (
          <Notice tone="warning">
            The licence for {state.licensee} expired on {formatDate(state.expiresAt)}. Enterprise features are off; all your data is still here.
          </Notice>
        ) : null}
        {state.status === "invalid" ? (
          <Notice tone="warning">The configured licence key is not valid ({state.reason}). Sibyl runs as the open source edition.</Notice>
        ) : null}
      </Card>

      <Card>
        <CardHeader title="Enterprise features" />
        <ul className={styles.rows}>
          {state.catalog.map((feature) => (
            <li key={feature.id} className={styles.row}>
              <span className={styles.rowMain}>
                <span className={styles.rowTitle}>{feature.title}</span>
                <span className={styles.rowMeta}>{feature.description}</span>
              </span>
              <Badge tone={feature.enabled ? "positive" : "outline"}>{feature.enabled ? "Enabled" : "Not licensed"}</Badge>
            </li>
          ))}
        </ul>
      </Card>

      {error ? <Notice tone="danger">{error}</Notice> : null}
      {notice ? <Notice tone="positive">{notice}</Notice> : null}

      {state.source === "env" ? (
        <Muted>The licence key is set on the server (SIBYL_LICENSE_KEY) and can only be changed there.</Muted>
      ) : canEdit ? (
        <Card as="form" onSubmit={(event) => void apply(event)}>
          <Field label={state.source === "stored" ? "Replace licence key" : "Licence key"} hint="Keys are checked offline on this server; nothing is sent anywhere.">
            <Textarea
              mono
              placeholder="sibyl1.…"
              rows={3}
              spellCheck={false}
              autoComplete="off"
              value={draft}
              disabled={busy}
              onChange={(event) => setDraft(event.target.value)}
            />
          </Field>
          <Row>
            <Button type="submit" variant="primary" disabled={busy || !draft.trim()}>
              Apply key
            </Button>
            {state.source === "stored" ? (
              <Button variant="danger" disabled={busy} onClick={() => void remove()}>
                Remove key
              </Button>
            ) : null}
          </Row>
        </Card>
      ) : (
        <Muted>Only the owner can change the licence key.</Muted>
      )}
    </Stack>
  );
}
