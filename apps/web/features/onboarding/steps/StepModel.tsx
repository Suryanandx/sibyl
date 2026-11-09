"use client";

import { useEffect, useState } from "react";
import type { ModelAccessView } from "@open-gpt-live/protocol";
import { Badge, Button, Field, Input, Muted, Notice } from "../../../components/ui";
import { errorText } from "../../../lib/gateway-http";
import { usd } from "../../../lib/pricing";
import { fetchModelAccess, fetchSignupOptions, removeModelKey, saveModelKey } from "../api";
import { StepLayout } from "../OnboardingFlow";
import styles from "../onboarding.module.css";

type Loaded = { status: "loading" } | { status: "ready"; access: ModelAccessView | null; hosted: boolean } | { status: "error"; message: string };

/** Model access: the organization's OpenRouter key, AI credits (hosted), or the server's key. */
export function StepModel() {
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [key, setKey] = useState("");
  const [checking, setChecking] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);

  useEffect(() => {
    let live = true;
    void Promise.all([fetchModelAccess(), fetchSignupOptions()])
      .then(([access, options]) => live && setLoaded({ status: "ready", access, hosted: Boolean(options?.hosted) }))
      .catch((error) => live && setLoaded({ status: "error", message: errorText(error) }));
    return () => {
      live = false;
    };
  }, []);

  if (loaded.status === "loading") {
    return <StepLayout title="Model access" lead="Checking how Sibyl reaches its AI models…" primaryDisabled />;
  }
  if (loaded.status === "error") {
    return (
      <StepLayout title="Model access" skipNote="You can do this later.">
        <Notice tone="danger">{loaded.message}</Notice>
      </StepLayout>
    );
  }

  const { access, hosted } = loaded;
  if (!access) {
    return (
      <StepLayout title="Model access" lead="Sibyl uses AI models through OpenRouter.">
        <Notice>This server doesn&apos;t let you change the model key here. Ask the person who runs it if Sibyl can&apos;t answer.</Notice>
      </StepLayout>
    );
  }

  if (access.mode === "server") {
    return (
      <StepLayout title="Model access" lead="Sibyl uses AI models through OpenRouter." hideSkip>
        <div className={styles.doneCard}>
          <Badge tone="positive">Ready</Badge>
          <div>
            <strong>Already set up by your server</strong>
            <Muted>The server has its own OpenRouter key. There&apos;s nothing to do here.</Muted>
          </div>
        </div>
      </StepLayout>
    );
  }

  async function check(): Promise<void> {
    const value = key.trim();
    if (!value || checking) return;
    setChecking(true);
    setKeyError(null);
    try {
      const access = await saveModelKey(value);
      setLoaded({ status: "ready", access, hosted });
      setKey("");
      setReplacing(false);
    } catch (error) {
      setKeyError(errorText(error));
    } finally {
      setChecking(false);
    }
  }

  const hasKey = Boolean(access.key) && !replacing;
  const credits = access.mode === "credits";
  const balance = access.credits?.balanceUsd ?? 0;
  // Credits only work with a balance (buying them in the app comes later).
  const ready = hasKey || (credits && balance > 0);

  return (
    <StepLayout
      title="Connect your AI models"
      lead="Sibyl runs on OpenRouter, so you can use the best models from every lab with one key. You pay OpenRouter directly."
      primaryDisabled={!ready && !key.trim()}
      skipNote={ready ? undefined : "Sibyl can't answer until this is set."}
      hideSkip={ready}
      onPrimary={async () => {
        if (ready) return;
        await check();
        return false;
      }}
    >
      {hasKey && access.key ? (
        <div className={styles.doneCard}>
          <Badge tone="positive">Key works</Badge>
          <div>
            <strong>OpenRouter key ending in {access.key.last4}</strong>
            <Muted>{keyLine(access.key)}</Muted>
          </div>
          <Button size="sm" variant="ghost" onClick={() => setReplacing(true)}>
            Replace
          </Button>
        </div>
      ) : (
        <div className={styles.optionCard}>
          <strong>Use my OpenRouter key</strong>
          <Muted>
            Create one at{" "}
            <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer">
              openrouter.ai/keys
            </a>{" "}
            and paste it here. We check it right away and keep it encrypted.
          </Muted>
          <Field label="OpenRouter key" error={keyError ?? undefined}>
            <Input
              type="password"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder="sk-or-v1-…"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={keyError ? true : undefined}
            />
          </Field>
          <div className={styles.inlineActions}>
            <Button size="sm" onClick={() => void check()} disabled={!key.trim() || checking}>
              {checking ? "Checking…" : "Check key"}
            </Button>
            {replacing ? (
              <Button size="sm" variant="ghost" onClick={() => setReplacing(false)}>
                Keep the current key
              </Button>
            ) : null}
          </div>
        </div>
      )}

      {hosted || access.hosted || credits ? (
        <div className={styles.optionCard} aria-disabled={!credits}>
          <span className={styles.optionHead}>
            <strong>Buy AI credits</strong>
            {credits && balance > 0 ? <Badge tone="positive">Active</Badge> : <Badge tone="outline">Coming soon</Badge>}
          </span>
          <Muted>
            {credits && balance > 0
              ? `Your organization has ${usd(balance)} in credits. Sibyl uses them when there's no key.`
              : "No key needed: pay Sibyl for what you use. Buying credits here is coming soon; until then, add your key."}
          </Muted>
        </div>
      ) : null}

      {hasKey && access.key ? (
        <p className={styles.small}>
          <button
            type="button"
            className={styles.textButton}
            onClick={() =>
              void removeModelKey()
                .then((next) => setLoaded({ status: "ready", access: next, hosted }))
                .catch((error) => setKeyError(errorText(error)))
            }
          >
            Remove this key
          </button>
        </p>
      ) : null}
    </StepLayout>
  );
}

function keyLine(key: NonNullable<ModelAccessView["key"]>): string {
  const parts: string[] = [];
  if (key.label) parts.push(key.label);
  parts.push(key.limitUsd === undefined || key.limitUsd === null ? "No spending limit" : `Limit ${usd(key.limitUsd)}`);
  if (key.usageUsd !== undefined) parts.push(`${usd(key.usageUsd)} used`);
  if (typeof key.remainingUsd === "number") parts.push(`${usd(key.remainingUsd)} left`);
  else if (typeof key.limitUsd === "number" && key.usageUsd !== undefined) parts.push(`${usd(Math.max(0, key.limitUsd - key.usageUsd))} left`);
  if (key.freeTier) parts.push("free tier");
  return parts.join(" · ");
}
