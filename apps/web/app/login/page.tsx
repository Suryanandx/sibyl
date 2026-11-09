"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import type { MfaChallengeView, SignInResponse } from "@open-gpt-live/protocol";
import { GatewayError, errorText } from "../../lib/gateway-http";
import { refreshAppSession, useAuthState } from "../../lib/app-session";
import { MfaStep, SignInOptions, ssoErrorMessage, useSignInProviders } from "../../features/admin-identity";
import { Divider, OrgChooser, ProviderButtons, goAfterSignup, signupApi, signupErrorMessage, useSignupOptions } from "../../features/signup";
import styles from "../../features/signup/signup.module.css";
import { AuthCard, AuthError, AuthField, nextPath } from "./auth-ui";

type Choice = { kind: "password"; organizations: Array<{ id: string; name: string }> } | { kind: "link"; organizations: Array<{ id: string; name: string }> };

/**
 * /login — every way in: the organization's single sign-on (Sibyl
 * Enterprise), Continue with Google / Microsoft, an emailed sign-in link,
 * or email and password (+ two-step verification). An address in several
 * organizations (hosted) chooses one.
 */
export default function LoginPage() {
  const { status, me } = useAuthState();
  const providers = useSignInProviders();
  const options = useSignupOptions();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"password" | "link">("password");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [challenge, setChallenge] = useState<MfaChallengeView | null>(null);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [choosing, setChoosing] = useState<string | null>(null);

  // Already signed in, or there are no accounts yet: go where it makes sense.
  useEffect(() => {
    if (status !== "ready" || !me) return;
    if (me.authenticated && me.principal === "user") window.location.replace(nextPath());
    else if (me.next === "setup") window.location.replace("/setup");
  }, [status, me]);

  // A failed SSO (?sso_error=) or Google / Microsoft sign-in (?signin_error=); a pending organization choice (?choose=1).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sso = params.get("sso_error");
    if (sso) setError(ssoErrorMessage(sso));
    const signin = params.get("signin_error");
    if (signin) setError(signupErrorMessage(signin, params.get("provider")));
    if (params.get("choose") === "1") {
      signupApi
        .choices()
        .then((result) => setChoice({ kind: "link", organizations: result.organizations }))
        .catch((caught) => setError(errorText(caught)));
    }
  }, []);

  async function finish(_result: SignInResponse): Promise<void> {
    await refreshAppSession();
    window.location.replace(nextPath());
  }

  async function signInWithPassword(org?: string): Promise<void> {
    const result = await signupApi.login(email, password, org);
    if ("choose" in result) {
      setChoice({ kind: "password", organizations: result.choose });
      setBusy(false);
      return;
    }
    if (result.mfa) {
      setChallenge(result.mfa);
      setBusy(false);
      return;
    }
    await finish(result);
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === "link") {
        const sent = await signupApi.email({ email: email.trim(), method: "magic_link", next: nextPath() });
        window.location.assign(`/signup/check?signin=1&email=${encodeURIComponent(sent.email)}`);
        return;
      }
      await signInWithPassword();
    } catch (caught) {
      setError(caught instanceof GatewayError ? caught.message : "Couldn't sign in. Try again.");
      setBusy(false);
    }
  }

  async function choose(orgId: string): Promise<void> {
    if (!choice) return;
    setChoosing(orgId);
    setError(null);
    try {
      if (choice.kind === "password") await signInWithPassword(orgId);
      else await goAfterSignup(await signupApi.choose(orgId));
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setChoosing(null);
    }
  }

  if (challenge) {
    return (
      <AuthCard
        title={challenge.step === "enroll" ? "Set up two-step verification" : "Two-step verification"}
        lead={challenge.step === "enroll" ? undefined : "Enter the code from your authenticator app."}
      >
        <MfaStep
          challenge={challenge}
          onSignedIn={finish}
          onRestart={() => {
            setChallenge(null);
            setPassword("");
            setError("That took too long. Enter your password again.");
          }}
        />
      </AuthCard>
    );
  }

  if (choice) {
    return (
      <AuthCard title="Choose an organization" lead="Your address belongs to more than one. You can switch later.">
        <OrgChooser organizations={choice.organizations} busy={choosing} onChoose={(id) => void choose(id)} />
        <AuthError message={error} />
        <p className="identFoot">
          <button type="button" className={styles.linkButton} onClick={() => setChoice(null)}>
            Back
          </button>
        </p>
      </AuthCard>
    );
  }

  const linkOn = Boolean(options?.email);
  const external = Boolean(options?.google || options?.microsoft);
  return (
    <AuthCard title="Sign in to Sibyl" lead={providers.length || external ? undefined : "Use the email and password for your account."}>
      <SignInOptions providers={providers} next={nextPath()} />
      <ProviderButtons options={options} next={nextPath()} />
      {external && providers.length === 0 ? <Divider>or use your email</Divider> : null}
      <form className="identForm" onSubmit={(event) => void submit(event)} noValidate>
        <AuthField label="Email" type="email" value={email} onChange={setEmail} autoComplete="email" autoFocus={providers.length === 0 && !external} />
        {mode === "password" ? (
          <AuthField label="Password" type="password" value={password} onChange={setPassword} autoComplete="current-password" invalid={Boolean(error)} />
        ) : null}
        <AuthError message={error} />
        <button type="submit" className="darkBtn identSubmit" disabled={busy || !email.trim() || (mode === "password" && !password)}>
          {busy ? (mode === "link" ? "Sending…" : "Signing in…") : mode === "link" ? "Email me a sign-in link" : "Sign in"}
        </button>
      </form>
      {linkOn ? (
        <p className="identFoot">
          <button type="button" className={styles.linkButton} onClick={() => setMode(mode === "password" ? "link" : "password")}>
            {mode === "password" ? "Email me a sign-in link instead" : "Use my password instead"}
          </button>
        </p>
      ) : null}
      <p className="identFoot">
        {options?.hosted ? (
          <>
            New to Sibyl? <Link href="/signup">Create an account</Link>
          </>
        ) : (
          <>Don&apos;t have an account? Ask an admin for an invitation link.</>
        )}
      </p>
    </AuthCard>
  );
}
