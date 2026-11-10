"use client";

import { useState, type CSSProperties, type FormEvent } from "react";
import { SilverMark } from "./Brand";
import { gatewayUrlFor } from "../lib/gateway-http";

/**
 * Single-owner sign-in, shown when the Gateway requires SIBYL_OWNER_TOKEN and
 * the browser has no (or a wrong) token. The token is kept in localStorage
 * and sent as `?token=` when connecting.
 */
const TOKEN_KEY = "sibyl.ownerToken";

export function readOwnerToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function writeOwnerToken(token: string | null): void {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage blocked: the token then lasts until the page reloads.
  }
}

const WORKSPACE_KEY = "sibyl.workspace";

/** The workspace the browser last opened (sent as `x-sibyl-workspace` on API calls). */
export function readWorkspaceId(): string | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage.getItem(WORKSPACE_KEY);
  } catch {
    return null;
  }
}

export function writeWorkspaceId(id: string | null): void {
  try {
    if (id) window.localStorage.setItem(WORKSPACE_KEY, id);
    else window.localStorage.removeItem(WORKSPACE_KEY);
  } catch {
    // Storage blocked: the default workspace is used after a reload.
  }
}

/** WebSocket URL with the owner token (if any) as `?token=`. */
export function withOwnerToken(url: string, token: string | null): string {
  if (!token) return url;
  const parsed = new URL(url);
  parsed.searchParams.set("token", token);
  return parsed.toString();
}

/** Ask /healthz whether the Gateway is up and requires the owner token. */
export async function gatewayRequiresLogin(): Promise<boolean> {
  try {
    // No credentials: /healthz is public (and answers with a wildcard origin).
    const response = await fetch(gatewayUrlFor("/healthz"), { cache: "no-store" });
    if (!response.ok) return false;
    const health = (await response.json()) as { ownerLogin?: unknown };
    return health.ownerLogin === true;
  } catch {
    return false;
  }
}

interface SignInProps {
  /** A token was tried and the Gateway rejected it. */
  failed: boolean;
  onSubmit: (token: string) => void;
}

export function SignIn({ failed, onSubmit }: SignInProps) {
  const [token, setToken] = useState("");

  function submit(event: FormEvent): void {
    event.preventDefault();
    const value = token.trim();
    if (value) onSubmit(value);
  }

  return (
    <main style={styles.page}>
      <form style={styles.card} onSubmit={submit} aria-labelledby="signin-title">
        <SilverMark size={64} />
        <h1 id="signin-title" style={styles.title}>
          Sign in to Sibyl
        </h1>
        <p style={styles.lead}>This Sibyl is private. Enter the owner password to continue.</p>
        <label style={styles.label}>
          <span style={styles.labelText}>Password</span>
          <input
            type="password"
            autoComplete="current-password"
            autoFocus
            value={token}
            onChange={(event) => setToken(event.target.value)}
            style={{ ...styles.input, ...(failed ? styles.inputError : {}) }}
            aria-invalid={failed}
            aria-describedby={failed ? "signin-error" : undefined}
          />
        </label>
        {failed ? (
          <p id="signin-error" role="alert" style={styles.error}>
            That password didn&apos;t work. Try again.
          </p>
        ) : null}
        <button type="submit" className="darkBtn" style={styles.button} disabled={!token.trim()}>
          Continue
        </button>
      </form>
    </main>
  );
}

const styles: Record<string, CSSProperties> = {
  page: {
    alignItems: "center",
    background: "var(--canvas)",
    color: "var(--text)",
    display: "flex",
    fontFamily: "var(--font)",
    justifyContent: "center",
    minHeight: "100vh",
    padding: 24
  },
  card: {
    alignItems: "center",
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-panel)",
    boxShadow: "var(--shadow-card)",
    display: "flex",
    flexDirection: "column",
    maxWidth: 380,
    padding: "32px 28px 28px",
    width: "100%"
  },
  title: { fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em", margin: "18px 0 6px" },
  lead: { color: "var(--text-2)", fontSize: 14, margin: "0 0 22px", textAlign: "center" },
  label: { display: "flex", flexDirection: "column", gap: 6, width: "100%" },
  labelText: { color: "var(--text-2)", fontSize: 13, fontWeight: 500 },
  input: {
    background: "var(--bg)",
    border: "1px solid var(--border-strong)",
    borderRadius: "var(--radius-ctl)",
    color: "var(--text)",
    font: "inherit",
    fontSize: 15,
    height: 42,
    outline: "none",
    padding: "0 14px",
    width: "100%"
  },
  inputError: { borderColor: "var(--danger)" },
  error: { color: "var(--danger)", fontSize: 13, margin: "8px 0 0", width: "100%" },
  button: { justifyContent: "center", marginTop: 18, width: "100%" }
};
