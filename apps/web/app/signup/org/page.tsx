"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import type { SignupTicketView } from "@open-gpt-live/protocol";
import { GatewayError, errorText } from "../../../lib/gateway-http";
import { refreshAppSession } from "../../../lib/app-session";
import { signupApi } from "../../../features/signup";
import { suggestOrgName } from "../../../features/signup/naming";
import styles from "../../../features/signup/signup.module.css";
import { AuthCard, AuthError, AuthField } from "../../login/auth-ui";

/** /signup/org — the verified address names its organization (POST /api/orgs), then onboarding. */
export default function NameOrgPage() {
  const [ticket, setTicket] = useState<SignupTicketView | null>(null);
  const [missing, setMissing] = useState(false);
  const [orgName, setOrgName] = useState("");
  const [workspaceName, setWorkspaceName] = useState("General");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    signupApi
      .ticket()
      .then((view) => {
        setTicket(view);
        setOrgName((current) => current || suggestOrgName(view));
      })
      .catch(() => setMissing(true));
  }, []);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy || !orgName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await signupApi.createOrg(orgName.trim(), workspaceName.trim() || undefined);
      await refreshAppSession();
      window.location.replace("/welcome");
    } catch (caught) {
      if (caught instanceof GatewayError && (caught.code === "signup_required" || caught.status === 401)) setMissing(true);
      setError(errorText(caught));
      setBusy(false);
    }
  }

  if (missing) {
    return (
      <AuthCard title="Let's start again" lead="Your sign-up expired or was already used. Verify your email address again to continue.">
        <AuthError message={error} />
        <Link className="darkBtn identSubmit" href="/signup">
          Back to sign-up
        </Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Name your organization" lead="It's what your team sees when they join. You can change it later in Admin.">
      {ticket ? (
        <p className={styles.who}>
          Signing up as <strong>{ticket.email}</strong>
        </p>
      ) : null}
      <form className="identForm" onSubmit={(event) => void submit(event)} noValidate>
        <AuthField label="Organization name" value={orgName} onChange={setOrgName} autoComplete="organization" autoFocus />
        <AuthField label="First workspace" value={workspaceName} onChange={setWorkspaceName} autoComplete="off" hint="Workspaces keep chats, knowledge and tools for one team or project." />
        <AuthError message={error} />
        <button type="submit" className="darkBtn identSubmit" disabled={busy || !orgName.trim() || !ticket}>
          {busy ? "Creating…" : "Create organization"}
        </button>
      </form>
      <p className="identFoot">
        Not you?{" "}
        <button
          type="button"
          className={styles.linkButton}
          onClick={() => void signupApi.clearTicket().finally(() => window.location.assign("/signup"))}
        >
          Start over
        </button>
      </p>
    </AuthCard>
  );
}
