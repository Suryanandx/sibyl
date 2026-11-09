"use client";

/**
 * Admin → Session policies (Sibyl Enterprise, part of `sso`): how long
 * sessions last, idle sign-out, the networks people may use Sibyl from, and
 * required two-step verification for password sign-ins.
 */
import { useEffect, useState, type FormEvent } from "react";
import type { SessionPolicyView } from "@open-gpt-live/protocol";
import { errorText } from "../../lib/gateway-http";
import { Button, Card, CardHeader, Checkbox, Field, Input, Muted, Notice, Row, Stack, Textarea } from "../../components/ui";
import { sessionPolicyApi } from "./api";
import styles from "./identity.module.css";

interface Draft {
  maxSessionHours: string;
  idleTimeoutMinutes: string;
  ipAllowlist: string;
  requireMfa: boolean;
}

const draftOf = (view: SessionPolicyView): Draft => ({
  maxSessionHours: view.maxSessionHours?.toString() ?? "",
  idleTimeoutMinutes: view.idleTimeoutMinutes?.toString() ?? "",
  ipAllowlist: view.ipAllowlist.join("\n"),
  requireMfa: view.requireMfa
});

export function SessionPolicySection() {
  const [view, setView] = useState<SessionPolicyView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    sessionPolicyApi
      .get()
      .then((next) => {
        setView(next);
        setDraft(draftOf(next));
      })
      .catch((cause: unknown) => setError(errorText(cause)));
  }, []);

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!draft) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const next = await sessionPolicyApi.save({
        maxSessionHours: draft.maxSessionHours.trim() ? Number(draft.maxSessionHours) : null,
        idleTimeoutMinutes: draft.idleTimeoutMinutes.trim() ? Number(draft.idleTimeoutMinutes) : null,
        ipAllowlist: draft.ipAllowlist.split(/[\s,]+/).map((line) => line.trim()).filter(Boolean),
        requireMfa: draft.requireMfa
      });
      setView(next);
      setDraft(draftOf(next));
      setSaved(true);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  if (!view || !draft) return error ? <Notice tone="danger">{error}</Notice> : <Muted>Loading…</Muted>;
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });

  return (
    <form onSubmit={(event) => void save(event)}>
      <Stack>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        {saved ? <Notice tone="positive">Saved. Open sessions follow the new rules from their next request.</Notice> : null}
        <Card>
          <CardHeader title="Session length" meta="Without limits, a session lasts 30 days from its last use." />
          <div className={styles.formGrid}>
            <Field label="Sign out after (hours)" hint="From sign-in, used or not. 1 to 2160.">
              <Input inputMode="numeric" value={draft.maxSessionHours} onChange={(event) => set({ maxSessionHours: event.target.value })} placeholder="No limit" />
            </Field>
            <Field label="Sign out when idle for (minutes)" hint="No requests or messages for this long. 5 or more.">
              <Input inputMode="numeric" value={draft.idleTimeoutMinutes} onChange={(event) => set({ idleTimeoutMinutes: event.target.value })} placeholder="No limit" />
            </Field>
          </div>
        </Card>

        <Card>
          <CardHeader title="Allowed networks" meta="Sign-in and every request must come from these addresses. Empty: anywhere." />
          <Stack gap={10}>
            <Field label="Addresses or CIDR ranges, one per line" hint={view.yourIp ? `Your address is ${view.yourIp}; it must stay in the list.` : undefined}>
              <Textarea mono rows={4} value={draft.ipAllowlist} onChange={(event) => set({ ipAllowlist: event.target.value })} placeholder={"203.0.113.0/24\n2001:db8::/32"} />
            </Field>
            <Muted>The owner token (SIBYL_OWNER_TOKEN) is an API key and isn&apos;t limited by this list: keep it safe as a way back in.</Muted>
          </Stack>
        </Card>

        <Card>
          <CardHeader title="Two-step verification" />
          <Checkbox
            label="Require two-step verification for password sign-ins (people without it set it up at their next sign-in)"
            checked={draft.requireMfa}
            onChange={(event) => set({ requireMfa: event.target.checked })}
          />
          <Muted>Single sign-on relies on your identity provider&apos;s own MFA.</Muted>
        </Card>

        <Row>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? "Saving…" : "Save policies"}
          </Button>
        </Row>
      </Stack>
    </form>
  );
}
