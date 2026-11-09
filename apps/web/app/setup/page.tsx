"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { AuthMeResponse } from "@open-gpt-live/protocol";
import { readOwnerToken, writeOwnerToken } from "../../components/SignIn";
import { GatewayError, gatewayRequest } from "../../lib/gateway-http";
import { refreshAppSession, useAuthState } from "../../lib/app-session";
import { AuthCard, AuthError, AuthField } from "../login/auth-ui";
import { fetchSignupOptions } from "../../features/onboarding/api";

/** /setup — first run: create the owner account (only while there are no accounts). */
export default function SetupPage() {
  const { status, me } = useAuthState();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [ownerToken, setOwnerToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setOwnerToken(readOwnerToken() ?? "");
  }, []);

  // Accounts exist already: this page is done.
  useEffect(() => {
    if (status === "ready" && me && !me.setupAvailable) window.location.replace(me.authenticated ? "/" : "/login");
  }, [status, me]);

  // Hosted Sibyl has no owner setup: people sign up instead.
  useEffect(() => {
    void fetchSignupOptions().then((options) => {
      if (options?.hosted) window.location.replace("/signup");
    });
  }, []);

  // No accounts and no owner token: Sibyl works without accounts too.
  const local = me?.authenticated === true && me.principal === "local";

  const needsToken = Boolean(me?.ownerTokenRequired);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    if (password.length < 8) {
      setError("Use at least 8 characters for the password.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const token = ownerToken.trim() || null;
      await gatewayRequest<AuthMeResponse>("/api/auth/setup", {
        method: "POST",
        body: { name, email, password },
        ownerToken: token,
        workspaceId: null
      });
      // The owner token stays an API key; people sign in with their account now.
      if (token) writeOwnerToken(token);
      await refreshAppSession();
      // Straight into onboarding (profile, model access, style, …).
      window.location.replace("/welcome");
    } catch (caught) {
      setError(caught instanceof GatewayError ? caught.message : "Couldn't create the account. Try again.");
      setBusy(false);
    }
  }

  return (
    <AuthCard
      title="Set up Sibyl"
      lead="Create the owner account. You can invite your team once you're in."
    >
      <form className="identForm" onSubmit={(event) => void submit(event)} noValidate>
        <AuthField label="Your name" value={name} onChange={setName} autoComplete="name" autoFocus />
        <AuthField label="Email" type="email" value={email} onChange={setEmail} autoComplete="email" />
        <AuthField
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          hint="At least 8 characters."
        />
        {needsToken ? (
          <AuthField
            label="Owner token"
            type="password"
            value={ownerToken}
            onChange={setOwnerToken}
            autoComplete="off"
            hint="The SIBYL_OWNER_TOKEN value from the server's configuration."
          />
        ) : null}
        <AuthError message={error} />
        <button
          type="submit"
          className="darkBtn identSubmit"
          disabled={busy || !email.trim() || !password || (needsToken && !ownerToken.trim())}
        >
          {busy ? "Creating…" : "Create owner account"}
        </button>
      </form>
      {local ? (
        <p className="identFoot">
          Just you on this computer? <a href="/welcome">Continue without an account</a>. You can create one later in Settings → Members.
        </p>
      ) : null}
    </AuthCard>
  );
}
