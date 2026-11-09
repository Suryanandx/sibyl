"use client";

/**
 * The second step of a password sign-in (on /login and /invite/<token>):
 * enter the code from an authenticator app (or a recovery code), or — when
 * the organization requires two-step verification and the person has none —
 * add an authenticator first. After enrolling, the recovery codes are shown
 * once before continuing.
 */
import { useState, type FormEvent } from "react";
import type { MfaChallengeView, SignInResponse } from "@open-gpt-live/protocol";
import { GatewayError } from "../../lib/gateway-http";
import { AuthError, AuthField } from "../../app/login/auth-ui";
import { mfaProof, signInApi } from "./api";
import { RecoveryCodes, SecretKey } from "./parts";
import styles from "./identity.module.css";

export function MfaStep({
  challenge,
  onSignedIn,
  onRestart
}: {
  challenge: MfaChallengeView;
  /** Signed in (after any recovery codes were acknowledged). */
  onSignedIn: (result: SignInResponse) => void | Promise<void>;
  /** The challenge expired: go back to the password step. */
  onRestart: () => void;
}) {
  const [code, setCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<SignInResponse | null>(null);
  const enrolling = challenge.step === "enroll";

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy || !code.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await signInApi.verify(challenge.challenge, useRecovery ? { recoveryCode: code.trim() } : (mfaProof(code) as { code: string }), challenge.org);
      if (result.recoveryCodes?.length) {
        setDone(result);
        setBusy(false);
        return;
      }
      await onSignedIn(result);
    } catch (caught) {
      if (caught instanceof GatewayError && caught.code === "challenge_expired") {
        onRestart();
        return;
      }
      setError(caught instanceof GatewayError ? caught.message : "Couldn't check the code. Try again.");
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="identForm">
        <p className="identNote">
          <strong>Save your recovery codes.</strong> Each one signs you in once if you lose your phone. They won&apos;t be shown again.
        </p>
        <RecoveryCodes codes={done.recoveryCodes ?? []} />
        <button type="button" className="darkBtn identSubmit" onClick={() => void onSignedIn(done)}>
          I saved them — continue
        </button>
      </div>
    );
  }

  return (
    <form className="identForm" onSubmit={(event) => void submit(event)} noValidate>
      {enrolling ? (
        <div className={styles.enroll}>
          <p className="identNote">Your organization requires two-step verification. Add Sibyl to an authenticator app (1Password, Google Authenticator, Authy…):</p>
          <SecretKey secret={challenge.secret ?? ""} otpauthUrl={challenge.otpauthUrl ?? ""} />
        </div>
      ) : null}
      <AuthField
        label={useRecovery ? "Recovery code" : enrolling ? "Code from the app" : "Code from your authenticator app"}
        value={code}
        onChange={setCode}
        autoComplete="one-time-code"
        autoFocus
        invalid={Boolean(error)}
        {...(useRecovery ? {} : { hint: "6 digits, it changes every 30 seconds." })}
      />
      <AuthError message={error} />
      <button type="submit" className="darkBtn identSubmit" disabled={busy || !code.trim()}>
        {busy ? "Checking…" : enrolling ? "Turn on and sign in" : "Sign in"}
      </button>
      {!enrolling ? (
        <button
          type="button"
          className={styles.linkButton}
          onClick={() => {
            setUseRecovery((value) => !value);
            setCode("");
            setError(null);
          }}
        >
          {useRecovery ? "Use a code from the app instead" : "Lost your phone? Use a recovery code"}
        </button>
      ) : null}
    </form>
  );
}
