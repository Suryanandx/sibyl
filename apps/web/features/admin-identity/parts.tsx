"use client";

/** Small shared pieces: an authenticator key to copy, recovery codes, a copy-once secret. */
import { useState } from "react";
import styles from "./identity.module.css";

function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  return [
    copied,
    (text) => {
      void navigator.clipboard
        ?.writeText(text)
        .then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1600);
        })
        .catch(() => undefined);
    }
  ];
}

/** The base32 key in groups of four, a copy button, and a link authenticator apps on this device can open. */
export function SecretKey({ secret, otpauthUrl }: { secret: string; otpauthUrl: string }) {
  const [copied, copy] = useCopy();
  const grouped = secret.match(/.{1,4}/g)?.join(" ") ?? secret;
  return (
    <div className={styles.secretBox}>
      <span className={styles.secretLabel}>Setup key</span>
      <code className={styles.secretValue}>{grouped}</code>
      <div className={styles.secretActions}>
        <button type="button" className={styles.linkButton} onClick={() => copy(secret)}>
          {copied ? "Copied" : "Copy key"}
        </button>
        {otpauthUrl ? (
          <a className={styles.linkButton} href={otpauthUrl}>
            Open in authenticator app
          </a>
        ) : null}
      </div>
    </div>
  );
}

export function RecoveryCodes({ codes }: { codes: string[] }) {
  const [copied, copy] = useCopy();
  return (
    <div className={styles.secretBox}>
      <ul className={styles.codes} aria-label="Recovery codes">
        {codes.map((code) => (
          <li key={code}>
            <code>{code}</code>
          </li>
        ))}
      </ul>
      <div className={styles.secretActions}>
        <button type="button" className={styles.linkButton} onClick={() => copy(codes.join("\n"))}>
          {copied ? "Copied" : "Copy all"}
        </button>
      </div>
    </div>
  );
}

/** A value shown once (a SCIM token): monospace, copy button. */
export function OnceSecret({ label, value }: { label: string; value: string }) {
  const [copied, copy] = useCopy();
  return (
    <div className={styles.secretBox}>
      <span className={styles.secretLabel}>{label}</span>
      <code className={styles.secretValue}>{value}</code>
      <div className={styles.secretActions}>
        <button type="button" className={styles.linkButton} onClick={() => copy(value)}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

/** A read-only value to give the identity provider (redirect URI, ACS URL…). */
export function CopyValue({ label, value }: { label: string; value: string }) {
  const [copied, copy] = useCopy();
  return (
    <div className={styles.copyRow}>
      <span className={styles.copyLabel}>{label}</span>
      <code className={styles.copyValue}>{value}</code>
      <button type="button" className={styles.linkButton} onClick={() => copy(value)}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
