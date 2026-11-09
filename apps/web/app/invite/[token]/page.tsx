"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { InvitePreview, MfaChallengeView, SignInResponse } from "@open-gpt-live/protocol";
import { writeWorkspaceId } from "../../../components/SignIn";
import { GatewayError, gatewayRequest } from "../../../lib/gateway-http";
import { refreshAppSession, useAuthState } from "../../../lib/app-session";
import { MfaStep } from "../../../features/admin-identity";
import { AuthCard, AuthError, AuthField } from "../../login/auth-ui";

const ROLE_TEXT: Record<InvitePreview["role"], string> = {
  owner: "an owner",
  admin: "an admin",
  member: "a member",
  viewer: "a viewer"
};

/** /invite/<token> — accept an invitation: create an account, or join with the signed-in one. */
export default function InvitePage({ params }: { params: { token: string } }) {
  const token = params.token;
  const { status, me } = useAuthState();
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The organization requires two-step verification: the new account adds it before its first session.
  const [challenge, setChallenge] = useState<{ mfa: MfaChallengeView; workspaceId?: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    gatewayRequest<InvitePreview>(`/api/invites/${encodeURIComponent(token)}`, { ownerToken: null, workspaceId: null })
      .then((result) => {
        if (cancelled) return;
        setPreview(result);
        if (result.email) setEmail(result.email);
      })
      .catch((caught) => {
        if (!cancelled) setLoadError(caught instanceof GatewayError ? caught.message : "This invitation link isn't valid.");
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const newAccount = useRef(false);
  const signedInUser = me?.authenticated && me.principal === "user" ? me.user : null;

  async function accept(body: Record<string, string>): Promise<void> {
    if (busy) return;
    // A new account (name, email, password) starts with onboarding.
    newAccount.current = Boolean(body.password);
    setBusy(true);
    setError(null);
    try {
      const result = await gatewayRequest<SignInResponse>(`/api/invites/${encodeURIComponent(token)}/accept`, {
        method: "POST",
        body,
        ownerToken: null,
        workspaceId: null
      });
      if (result.mfa) {
        setChallenge({ mfa: result.mfa, ...(result.workspaceId ? { workspaceId: result.workspaceId } : {}) });
        setBusy(false);
        return;
      }
      await finish(result);
    } catch (caught) {
      setError(caught instanceof GatewayError ? caught.message : "Couldn't accept the invitation. Try again.");
      setBusy(false);
    }
  }

  async function finish(result: SignInResponse): Promise<void> {
    const workspaceId = result.workspaceId ?? challenge?.workspaceId;
    if (workspaceId) writeWorkspaceId(workspaceId);
    await refreshAppSession();
    window.location.replace(newAccount.current ? "/welcome" : "/");
  }

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (password.length < 8) {
      setError("Use at least 8 characters for the password.");
      return;
    }
    void accept({ name, email, password });
  }

  if (challenge) {
    return (
      <AuthCard title="Set up two-step verification">
        <MfaStep
          challenge={challenge.mfa}
          onSignedIn={finish}
          onRestart={() => {
            setChallenge(null);
            window.location.replace("/login");
          }}
        />
      </AuthCard>
    );
  }

  if (loadError) {
    return (
      <AuthCard title="Invitation not available" lead={loadError}>
        <a className="ghostBtn identSubmit" href="/login">
          Go to sign in
        </a>
      </AuthCard>
    );
  }
  if (!preview || status === "loading" || status === "idle") {
    return <AuthCard title="Opening invitation…" />;
  }
  if (preview.status !== "pending") {
    return (
      <AuthCard
        title={preview.status === "accepted" ? "Invitation already used" : "Invitation expired"}
        lead={preview.status === "accepted" ? "This link has already been used. Sign in to continue." : "Ask whoever invited you for a new link."}
      >
        <a className="ghostBtn identSubmit" href="/login">
          Go to sign in
        </a>
      </AuthCard>
    );
  }

  const lead = (
    <>
      {preview.invitedByName} invited you to <strong>{preview.workspaceName}</strong> as {ROLE_TEXT[preview.role]}.
    </>
  );

  // Signed in already: join with this account.
  if (signedInUser) {
    const wrongAccount = Boolean(preview.email && preview.email !== signedInUser.email);
    return (
      <AuthCard title={`Join ${preview.workspaceName}`} lead={lead}>
        <p className="identNote">
          Signed in as <strong>{signedInUser.email}</strong>.
          {wrongAccount ? ` This invitation is for ${preview.email}.` : ""}
        </p>
        <AuthError message={error} />
        <button type="button" className="darkBtn identSubmit" disabled={busy || wrongAccount} onClick={() => void accept({})}>
          {busy ? "Joining…" : "Join workspace"}
        </button>
      </AuthCard>
    );
  }

  // The invited email has an account: sign in first, then come back here.
  if (preview.accountExists) {
    return (
      <AuthCard title={`Join ${preview.workspaceName}`} lead={lead}>
        <p className="identNote">You already have an account. Sign in to accept the invitation.</p>
        <a className="darkBtn identSubmit" href={`/login?next=${encodeURIComponent(`/invite/${token}`)}`}>
          Sign in
        </a>
      </AuthCard>
    );
  }

  return (
    <AuthCard title={`Join ${preview.workspaceName}`} lead={lead}>
      <form className="identForm" onSubmit={submit} noValidate>
        <AuthField label="Your name" value={name} onChange={setName} autoComplete="name" autoFocus />
        <AuthField label="Email" type="email" value={email} onChange={setEmail} autoComplete="email" disabled={Boolean(preview.email)} />
        <AuthField label="Password" type="password" value={password} onChange={setPassword} autoComplete="new-password" hint="At least 8 characters." />
        <AuthError message={error} />
        <button type="submit" className="darkBtn identSubmit" disabled={busy || !email.trim() || !password}>
          {busy ? "Creating account…" : "Create account and join"}
        </button>
      </form>
      <p className="identFoot">
        Already have an account? <a href={`/login?next=${encodeURIComponent(`/invite/${token}`)}`}>Sign in</a>
      </p>
    </AuthCard>
  );
}
