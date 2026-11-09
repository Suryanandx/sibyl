"use client";

/**
 * Sibyl owner sign-in for Slides, shown by the root layout when
 * SIBYL_OWNER_TOKEN is set and the request carries no valid token.
 *
 * If the browser already holds the token (signed in at the Sibyl chat, same
 * origin and localStorage key), it is mirrored into the Slides cookie and the
 * page reloads without asking.
 */
import { useEffect, useState, type FormEvent } from "react";
import { SilverMark } from "./Brand";
import { SibylWaiting } from "./SibylLoader";
import { readOwnerToken, syncOwnerCookie, writeOwnerToken } from "./session";
import { withBasePath } from "@/utils/basePath";

async function tokenWorks(token: string): Promise<boolean> {
  try {
    const response = await fetch(withBasePath("/api/v1/auth/status"), {
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function OwnerSignIn({ appUrl = "" }: { appUrl?: string }) {
  const [appBase, setAppBase] = useState("");
  const [checking, setChecking] = useState(true);
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    try {
      if (appUrl && new URL(appUrl).origin !== window.location.origin) {
        setAppBase(appUrl.replace(/\/+$/, ""));
      }
    } catch {
      // keep relative
    }
  }, [appUrl]);

  useEffect(() => {
    const stored = readOwnerToken();
    if (!stored) {
      setChecking(false);
      return;
    }
    void tokenWorks(stored).then((ok) => {
      if (ok) {
        syncOwnerCookie(stored);
        window.location.reload();
      } else {
        setChecking(false);
        setError("The saved token was not accepted. Enter it again.");
      }
    });
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = token.trim();
    if (!value) return;
    setBusy(true);
    setError(null);
    if (await tokenWorks(value)) {
      writeOwnerToken(value);
      window.location.reload();
      return;
    }
    setBusy(false);
    setError("That token was not accepted.");
  };

  if (checking) {
    return (
      <main className="sibylSignIn">
        <SibylWaiting message="Signing you in…" />
      </main>
    );
  }

  return (
    <main className="sibylSignIn">
      <form className="sibylSignInCard" onSubmit={submit}>
        <div style={{ display: "flex", justifyContent: "center" }}>
          <SilverMark size={72} />
        </div>
        <h1>Sign in to Sibyl Slides</h1>
        <p>This Sibyl is private. Enter the owner token (SIBYL_OWNER_TOKEN) to continue.</p>
        <input
          className="sibylInput"
          type="password"
          autoComplete="current-password"
          placeholder="Owner token"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          autoFocus
        />
        {error ? <span className="sibylError">{error}</span> : null}
        <button type="submit" className="sibylDarkBtn" disabled={!token.trim() || busy}>
          {busy ? "Checking…" : "Continue"}
        </button>
        <a href={appBase + "/"} className="sibylGhostBtn">
          Back to Sibyl
        </a>
      </form>
    </main>
  );
}
