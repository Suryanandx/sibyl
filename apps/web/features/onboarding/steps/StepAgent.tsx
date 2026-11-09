"use client";

import { useEffect, useState } from "react";
import { nextSeed, randomAvatar } from "@open-gpt-live/core/avatar";
import type { AgentAvatarView, AgentTemplateView } from "@open-gpt-live/protocol";
import { Button, Field, Input, Muted } from "../../../components/ui";
import { useGateway } from "../../../lib/gateway";
import { AgentAvatar } from "../../agents";
import { StepLayout } from "../OnboardingFlow";
import styles from "../onboarding.module.css";

/** Templates offered here (the first few the gateway ships). */
const SHOWN = 4;

/** Your first agent (optional): pick a template, name it; its avatar is generated. */
export function StepAgent() {
  const { agents, connected } = useGateway();
  const templates = agents.templates.slice(0, SHOWN);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState<AgentAvatarView | null>(null);
  const { loaded, refresh } = agents;

  useEffect(() => {
    if (connected && !loaded) refresh();
  }, [connected, loaded, refresh]);

  const template = templates.find((item) => item.id === templateId);

  function pick(next: AgentTemplateView): void {
    setTemplateId(next.id);
    setName(next.name);
    setAvatar(next.avatar);
  }

  if (loaded && !agents.canCreate) {
    return (
      <StepLayout title="Your first agent" lead="Agents are helpers with their own job, voice and look.">
        <Muted>You can use the agents your workspace shares with you. Creating new ones needs an admin.</Muted>
      </StepLayout>
    );
  }

  return (
    <StepLayout
      title="Your first agent"
      lead="An agent is a helper with its own job and look. Start from a template; you can change everything later."
      primary="Create agent"
      primaryDisabled={!template || !avatar || !name.trim()}
      skipNote="You can create agents later."
      onPrimary={async () => {
        if (!template || !avatar) return false;
        await agents.save({
          name: name.trim(),
          description: template.description,
          avatar,
          instructions: template.instructions,
          access: { mode: "inherit" },
          autonomy: template.autonomy,
          learning: template.learning,
          visibility: "private",
          templateId: template.id
        });
      }}
    >
      {!loaded ? <Muted>Loading templates…</Muted> : null}
      {loaded && agents.agents.length > 0 ? (
        <Muted>
          You already have {agents.agents.length === 1 ? "an agent" : `${agents.agents.length} agents`}. Add another, or skip.
        </Muted>
      ) : null}
      {loaded ? (
        <>
          <fieldset className={styles.choices}>
            <legend className={styles.srOnly}>Template</legend>
            {templates.map((item) => (
              <label key={item.id} className={styles.choice} data-checked={templateId === item.id ? "true" : "false"}>
                <input type="radio" name="template" value={item.id} checked={templateId === item.id} onChange={() => pick(item)} />
                <AgentAvatar avatar={templateId === item.id && avatar ? avatar : item.avatar} size={40} />
                <span className={styles.choiceMain}>
                  <span className={styles.choiceTitle}>{item.name}</span>
                  <span className={styles.choiceText}>{item.description}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {template && avatar ? (
            <div className={styles.inlineForm}>
              <Field label="Name">
                <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={60} />
              </Field>
              <Button size="sm" onClick={() => setAvatar(randomAvatar(nextSeed(avatar.seed)))}>
                New look
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
    </StepLayout>
  );
}
