"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { errorText } from "../../../lib/gateway-http";
import { CodeField, goAfterSignup, signupApi } from "../../../features/signup";
import { AuthCard, AuthError } from "../../login/auth-ui";

/** /signup/verify?email= — the 6-digit code from a password sign-up. */
export default function VerifyPage() {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tried = useRef("");

  useEffect(() => {
    setEmail(new URLSearchParams(window.location.search).get("email") ?? "");
  }, []);

  async function verify(value: string): Promise<void> {
    if (busy || value.length !== 6) return;
    tried.current = value;
    setBusy(true);
    setError(null);
    try {
      await goAfterSignup(await signupApi.code(email, value));
    } catch (caught) {
      setError(errorText(caught));
      setBusy(false);
    }
  }

  // The sixth digit (typed or pasted) sends it.
  useEffect(() => {
    if (code.length === 6 && code !== tried.current) void verify(code);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  return (
    <AuthCard
      title="Check your email"
      lead={
        <>
          We sent a 6-digit code to <strong>{email || "your address"}</strong>. It expires in 15 minutes.
        </>
      }
    >
      <form
        className="identForm"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          void verify(code);
        }}
        noValidate
      >
        <CodeField value={code} onChange={setCode} invalid={Boolean(error)} disabled={busy} />
        <AuthError message={error} />
        <button type="submit" className="darkBtn identSubmit" disabled={busy || code.length !== 6}>
          {busy ? "Checking…" : "Continue"}
        </button>
      </form>
      <p className="identFoot">
        No email? Check spam, or <Link href={`/signup?email=${encodeURIComponent(email)}`}>send a new code</Link>.
      </p>
    </AuthCard>
  );
}
