"use client";

import { useEffect, useMemo, useState } from "react";
import type { IntegrationsState, KnowledgeListResponse } from "@open-gpt-live/protocol";
import { Icon } from "../../../components/Icon";
import { useGateway } from "../../../lib/gateway";
import { gatewayRequest } from "../../../lib/gateway-http";
import { useAppSession } from "../../../lib/app-session";
import { fetchIntegrations } from "../../integrations/api";
import { suggestedPrompts } from "../flow";
import { StepLayout, useFlow } from "../OnboardingFlow";
import styles from "../onboarding.module.css";

/** Where the chat opens with a prompt typed in (ChatScreen reads ?q=). */
export function chatWithPrompt(text: string): string {
  return `/?q=${encodeURIComponent(text)}`;
}

/** First conversation: prompts built from what they connected, and a hint to just talk. */
export function StepStart() {
  const { finish } = useFlow();
  const { agents } = useGateway();
  const session = useAppSession();
  const [integrations, setIntegrations] = useState<IntegrationsState | null>(null);
  const [knowledge, setKnowledge] = useState<KnowledgeListResponse | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (session.can("integrations.use")) void fetchIntegrations().then(setIntegrations, () => undefined);
    if (session.can("knowledge.view")) void gatewayRequest<KnowledgeListResponse>("/api/knowledge").then(setKnowledge, () => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const prompts = useMemo(() => {
    const newest = [...agents.agents].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
    return suggestedPrompts({
      connected: [...new Set((integrations?.connections ?? []).filter((c) => c.status === "connected").map((c) => c.connectorId))],
      knowledge: (knowledge?.bases ?? []).filter((base) => base.docCount > 0).map((base) => base.name),
      ...(newest ? { agentName: newest.name } : {})
    });
  }, [integrations, knowledge, agents.agents]);

  async function open(path: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await finish(path);
    } finally {
      setBusy(false);
    }
  }

  return (
    <StepLayout
      title="Say hello"
      lead="You're all set. Pick something to try, or start with your own question."
      primary="Open Sibyl"
      onPrimary={async () => {
        await finish("/");
        return "handled" as const;
      }}
    >
      <ul className={styles.prompts}>
        {prompts.map((prompt) => (
          <li key={prompt.text}>
            <button type="button" className={styles.prompt} disabled={busy} onClick={() => void open(chatWithPrompt(prompt.text))}>
              <span>{prompt.text}</span>
              {prompt.uses ? <span className={styles.promptUses}>{prompt.uses}</span> : null}
            </button>
          </li>
        ))}
      </ul>
      <div className={styles.talkHint}>
        <span className={styles.talkIcon} aria-hidden>
          <Icon name="mic" size={18} />
        </span>
        <p>
          <strong>Try talking.</strong> Press the microphone in the chat box and just speak. Sibyl answers out loud and shows the details on screen.
        </p>
      </div>
    </StepLayout>
  );
}
