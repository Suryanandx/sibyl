"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { errorText } from "../../../lib/gateway-http";
import { goAfterSignup, signupApi } from "../../../features/signup";
import { SibylLoader } from "../../../components/SibylLoader";
import { AuthCard, AuthError } from "../../login/auth-ui";

/** /signup/link?token= — an emailed sign-in or sign-up link (redeemed with a POST, so mail scanners can't use it up). */
export default function MagicLinkPage() {
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token") ?? "";
    // The token leaves the address bar (and the history) at once.
    window.history.replaceState(null, "", "/signup/link");
    if (!token) {
      setError("This link is incomplete. Open it from the email again.");
      return;
    }
    signupApi
      .link(token)
      .then(goAfterSignup)
      .catch((caught) => setError(errorText(caught)));
  }, []);

  if (error) {
    return (
      <AuthCard title="This link doesn't work" lead="Links work once, for 15 minutes.">
        <AuthError message={error} />
        <p className="identFoot">
          <Link href="/login">Sign in</Link> or <Link href="/signup">sign up</Link> to get a new one.
        </p>
      </AuthCard>
    );
  }
  return (
    <AuthCard title="Signing you in…">
      <SibylLoader size={40} state="thinking" />
    </AuthCard>
  );
}
