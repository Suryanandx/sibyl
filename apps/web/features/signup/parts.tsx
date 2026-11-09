"use client";

/**
 * Pieces of the sign-up and sign-in screens: Continue with Google /
 * Microsoft, the 6-digit code field and the "which organization?" chooser.
 */
import { useEffect, useRef, type ReactNode } from "react";
import type { SignupOptionsView } from "@open-gpt-live/protocol";
import { signupApi } from "./api";
import styles from "./signup.module.css";

function GoogleMark() {
  // The four-colour "G" (Google's sign-in branding guidelines ask for it on the button).
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.1C12.5 13.6 17.8 9.5 24 9.5Z" />
      <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.7 6c4.5-4.2 6.9-10.3 6.9-17.7Z" />
      <path fill="#FBBC05" d="M10.6 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.7 10.7l7.9-6.1Z" />
      <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.7-6c-2.1 1.4-4.9 2.3-8.2 2.3-6.2 0-11.5-4.1-13.4-9.9l-7.9 6.1C6.6 42.6 14.6 48 24 48Z" />
    </svg>
  );
}

function MicrosoftMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 21 21" aria-hidden>
      <path fill="#F25022" d="M1 1h9v9H1z" />
      <path fill="#7FBA00" d="M11 1h9v9h-9z" />
      <path fill="#00A4EF" d="M1 11h9v9H1z" />
      <path fill="#FFB900" d="M11 11h9v9h-9z" />
    </svg>
  );
}

/** Continue with Google / Microsoft (only the ones this server has a sign-in app for); with `invite`, accepts that invitation. */
export function ProviderButtons({ options, next = "/", invite }: { options: SignupOptionsView | null; next?: string; invite?: string }) {
  if (!options || (!options.google && !options.microsoft)) return null;
  return (
    <div className={styles.providers}>
      {options.google ? (
        <a className={`ghostBtn ${styles.provider}`} href={signupApi.oauthUrl("google", next, invite)}>
          <GoogleMark />
          Continue with Google
        </a>
      ) : null}
      {options.microsoft ? (
        <a className={`ghostBtn ${styles.provider}`} href={signupApi.oauthUrl("microsoft", next, invite)}>
          <MicrosoftMark />
          Continue with Microsoft
        </a>
      ) : null}
    </div>
  );
}

export function Divider({ children }: { children: ReactNode }) {
  return <div className={styles.divider}>{children}</div>;
}

/** One field for the 6-digit code: numeric keyboard, one-time-code autofill, paste-friendly. */
export function CodeField({ value, onChange, invalid, disabled }: { value: string; onChange: (value: string) => void; invalid?: boolean; disabled?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <label className="identField">
      <span className="identLabel">6-digit code</span>
      <input
        ref={ref}
        className={`identInput ${styles.code}`}
        value={value}
        onChange={(event) => onChange(event.target.value.replace(/\D/g, "").slice(0, 6))}
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        maxLength={6}
        aria-invalid={invalid || undefined}
        disabled={disabled}
      />
    </label>
  );
}

/** "Your address is in more than one organization": pick one. */
export function OrgChooser({ organizations, busy, onChoose }: { organizations: Array<{ id: string; name: string }>; busy: string | null; onChoose: (id: string) => void }) {
  return (
    <ul className={styles.orgs} aria-label="Your organizations">
      {organizations.map((org) => (
        <li key={org.id}>
          <button type="button" className={`ghostBtn ${styles.org}`} disabled={busy !== null} onClick={() => onChoose(org.id)}>
            <span className={styles.orgInitial} aria-hidden>
              {org.name.slice(0, 1).toUpperCase()}
            </span>
            <span className={styles.orgName}>{org.name}</span>
            <span className={styles.orgGo} aria-hidden>
              {busy === org.id ? "…" : "→"}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
