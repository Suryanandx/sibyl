"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { errorText } from "../../lib/gateway-http";
import { useAuthState } from "../../lib/app-session";
import { Divider, ProviderButtons, signupApi, signupErrorMessage, useSignupOptions } from "../../features/signup";
import styles from "../../features/signup/signup.module.css";
import { AuthCard, AuthError, AuthField } from "../login/auth-ui";

/** /signup — hosted Sibyl: Continue with Google / Microsoft, or an email with a link or a password. */
export default function SignupPage() {
  const { status, me } = useAuthState();
  const options = useSignupOptions();
  const [email, setEmail] = useState("");
  const [method, setMethod] = useState<"magic_link" | "password">("magic_link");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("signin_error");
    if (code) setError(signupErrorMessage(code, params.get("provider")));
    const given = params.get("email");
    if (given) setEmail(given);
  }, []);

  // Signed in already, or a self-hosted server (people join by invitation): sign-in instead.
  useEffect(() => {
    if (status === "ready" && me?.authenticated && me.principal === "user") window.location.replace("/");
  }, [status, me]);
  useEffect(() => {
    if (options && !options.hosted) window.location.replace("/login");
  }, [options]);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    if (method === "password" && password.length < 8) {
      setError("Use at least 8 characters for the password.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const sent = await signupApi.email({ email: email.trim(), method, ...(method === "password" ? { password } : {}) });
      const target = method === "password" ? "/signup/verify" : "/signup/check";
      window.location.assign(`${target}?email=${encodeURIComponent(sent.email)}`);
    } catch (caught) {
      setError(errorText(caught));
      setBusy(false);
    }
  }

  const emailOn = options?.email ?? true;
  return (
    <AuthCard title="Create your Sibyl account" lead="Your team's voice assistant. Bring your own OpenRouter key, or use AI credits.">
      <ProviderButtons options={options} next="/welcome" />
      {emailOn ? (
        <>
          {options?.google || options?.microsoft ? <Divider>or use your email</Divider> : null}
          <form className="identForm" onSubmit={(event) => void submit(event)} noValidate>
            <AuthField label="Work email" type="email" value={email} onChange={setEmail} autoComplete="email" autoFocus={!options?.google && !options?.microsoft} />
            <fieldset className={styles.methods}>
              <legend className={styles.legend}>How do you want to sign in?</legend>
              <label className={styles.method}>
                <input type="radio" name="method" value="magic_link" checked={method === "magic_link"} onChange={() => setMethod("magic_link")} />
                Email me a link
              </label>
              <label className={styles.method}>
                <input type="radio" name="method" value="password" checked={method === "password"} onChange={() => setMethod("password")} />
                Set a password
              </label>
            </fieldset>
            {method === "password" ? (
              <AuthField label="Password" type="password" value={password} onChange={setPassword} autoComplete="new-password" hint="At least 8 characters. We'll email you a code to confirm the address." />
            ) : null}
            <AuthError message={error} />
            <button type="submit" className="darkBtn identSubmit" disabled={busy || !email.trim() || (method === "password" && !password)}>
              {busy ? "Sending…" : method === "password" ? "Send code" : "Send link"}
            </button>
          </form>
        </>
      ) : (
        <>
          <AuthError message={error} />
          {!options?.google && !options?.microsoft ? <p className="identNote">Sign-up isn&apos;t open on this server yet.</p> : null}
        </>
      )}
      <p className="identFoot">
        Already have an account? <Link href="/login">Sign in</Link>
      </p>
    </AuthCard>
  );
}
