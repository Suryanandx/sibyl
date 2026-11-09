"use client";

/**
 * Settings → Sign-in security: two-step verification for your own account
 * (open source). Turning it on shows a setup key for an authenticator app,
 * checks one code, then shows the recovery codes once. Turning it off or
 * replacing the recovery codes needs a current code.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { MfaSetupResponse, MfaStatusView } from "@open-gpt-live/protocol";
import { useAppSession } from "../../lib/app-session";
import { errorText } from "../../lib/gateway-http";
import { Badge, Button, Card, CardHeader, Field, Input, Muted, Notice, Row, Stack } from "../../components/ui";
import { mfaApi } from "./api";
import { RecoveryCodes, SecretKey } from "./parts";

export function TwoStepSection() {
  const session = useAppSession();
  const [status, setStatus] = useState<MfaStatusView | null>(null);
  const [setup, setSetup] = useState<MfaSetupResponse | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState("");
  const [mode, setMode] = useState<"idle" | "disable" | "regenerate">("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await mfaApi.status());
      setError(null);
    } catch (cause) {
      setError(errorText(cause));
    }
  }, []);

  useEffect(() => {
    if (session.user) void load();
  }, [load, session.user]);

  async function run(work: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  if (!session.user) {
    return <Muted>Two-step verification is for people who sign in with an account (not the owner token).</Muted>;
  }
  if (!status) return error ? <Notice tone="danger">{error}</Notice> : <Muted>Loading…</Muted>;
  if (status.passwordSignIn === false && !status.enabled) {
    return <Muted>You sign in with single sign-on, so your identity provider asks for the second step.</Muted>;
  }

  const enable = (event: FormEvent) => {
    event.preventDefault();
    if (!setup) return;
    void run(async () => {
      const result = await mfaApi.enable(setup.setupToken, code.replace(/\s/g, ""));
      setStatus(result.status);
      setCodes(result.recoveryCodes);
      setSetup(null);
      setCode("");
    });
  };

  const confirm = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      if (mode === "disable") {
        setStatus((await mfaApi.disable(code)).status);
      } else {
        const result = await mfaApi.newRecoveryCodes(code);
        setStatus(result.status);
        setCodes(result.recoveryCodes);
      }
      setMode("idle");
      setCode("");
    });
  };

  return (
    <Stack>
      <Card>
        <CardHeader
          title="Two-step verification"
          meta="A code from an authenticator app on your phone, asked for after your password."
          actions={<Badge tone={status.enabled ? "positive" : "outline"}>{status.enabled ? "On" : "Off"}</Badge>}
        />
        {!status.available && !status.enabled ? (
          <Notice tone="warning">Two-step verification needs the gateway&apos;s secrets key (SIBYL_SECRET_KEY or data/secret.key).</Notice>
        ) : null}
        {error ? <Notice tone="danger">{error}</Notice> : null}

        {codes ? (
          <Stack gap={10}>
            <Muted>
              Save these recovery codes somewhere safe. Each one signs you in once if you lose your phone. They won&apos;t be shown again.
            </Muted>
            <RecoveryCodes codes={codes} />
            <Row>
              <Button variant="primary" onClick={() => setCodes(null)}>
                Done
              </Button>
            </Row>
          </Stack>
        ) : setup ? (
          <form onSubmit={enable}>
            <Stack gap={12}>
              <Muted>Add Sibyl to your authenticator app (1Password, Google Authenticator, Authy…) with this key, then enter the code it shows.</Muted>
              <SecretKey secret={setup.secret} otpauthUrl={setup.otpauthUrl} />
              <Field label="Code from the app">
                <Input value={code} onChange={(event) => setCode(event.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={8} autoFocus />
              </Field>
              <Row>
                <Button type="submit" variant="primary" disabled={busy || code.replace(/\s/g, "").length !== 6}>
                  {busy ? "Checking…" : "Turn on"}
                </Button>
                <Button variant="ghost" onClick={() => setSetup(null)}>
                  Cancel
                </Button>
              </Row>
            </Stack>
          </form>
        ) : mode !== "idle" ? (
          <form onSubmit={confirm}>
            <Stack gap={12}>
              <Field label="Current code (or a recovery code)">
                <Input value={code} onChange={(event) => setCode(event.target.value)} autoComplete="one-time-code" autoFocus />
              </Field>
              <Row>
                <Button type="submit" variant={mode === "disable" ? "danger" : "primary"} disabled={busy || !code.trim()}>
                  {mode === "disable" ? "Turn off" : "Make new codes"}
                </Button>
                <Button variant="ghost" onClick={() => setMode("idle")}>
                  Cancel
                </Button>
              </Row>
            </Stack>
          </form>
        ) : status.enabled ? (
          <Stack gap={10}>
            <Muted>
              {status.recoveryCodesLeft} recovery code{status.recoveryCodesLeft === 1 ? "" : "s"} left.
              {status.enabledAt ? ` On since ${new Date(status.enabledAt).toLocaleDateString()}.` : ""}
            </Muted>
            <Row>
              <Button onClick={() => setMode("regenerate")}>New recovery codes</Button>
              <Button variant="danger" onClick={() => setMode("disable")}>
                Turn off
              </Button>
            </Row>
          </Stack>
        ) : (
          <Row>
            <Button variant="primary" disabled={busy || !status.available} onClick={() => void run(async () => setSetup(await mfaApi.setup()))}>
              Turn on
            </Button>
          </Row>
        )}
      </Card>
    </Stack>
  );
}
