"use client";

/**
 * "Continue with <provider>" buttons for the sign-in screen. The list comes
 * from GET /api/auth/providers: empty in the open-source edition, the
 * organization's identity providers with Sibyl Enterprise SSO.
 */
import { useEffect, useState } from "react";
import type { SignInProviderView } from "@open-gpt-live/protocol";
import { signInApi } from "./api";
import styles from "./identity.module.css";

export function useSignInProviders(): SignInProviderView[] {
  const [providers, setProviders] = useState<SignInProviderView[]>([]);
  useEffect(() => {
    let cancelled = false;
    signInApi
      .providers()
      .then((result) => {
        if (!cancelled) setProviders(result.providers);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  return providers;
}

export function SignInOptions({ providers, next }: { providers: SignInProviderView[]; next: string }) {
  if (providers.length === 0) return null;
  return (
    <>
      <div className={styles.providers}>
        {providers.map((provider) => (
          <a key={provider.id} className={`ghostBtn ${styles.providerButton}`} href={signInApi.startUrl(provider.startPath, next)}>
            Continue with {provider.label}
          </a>
        ))}
      </div>
      <div className={styles.divider}>or use your email and password</div>
    </>
  );
}
