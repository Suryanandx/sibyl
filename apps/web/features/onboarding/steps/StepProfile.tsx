"use client";

import { useState } from "react";
import { nextSeed, randomAvatar } from "@open-gpt-live/core/avatar";
import type { AgentAvatarView } from "@open-gpt-live/protocol";
import { SibylLoader } from "../../../components/SibylLoader";
import { Button, Field, Input } from "../../../components/ui";
import { refreshAppSession } from "../../../lib/app-session";
import { AgentAvatar } from "../../agents";
import { saveProfile } from "../api";
import { StepLayout, useFlow } from "../OnboardingFlow";
import { setOnboardingView } from "../useOnboarding";
import styles from "../onboarding.module.css";

/** Welcome: the person's name and the face they show in the app. */
export function StepProfile() {
  const { view } = useFlow();
  const [name, setName] = useState(view.profile.name);
  const [avatar, setAvatar] = useState<AgentAvatarView>(view.profile.avatar);

  return (
    <StepLayout
      hero={<SibylLoader state="thinking" size={72} label="Sibyl" />}
      title="Welcome to Sibyl"
      lead="Let's get you set up. It takes a couple of minutes, and you can skip anything."
      primaryDisabled={!name.trim()}
      onPrimary={async () => {
        setOnboardingView(await saveProfile({ name: name.trim(), avatar }));
        void refreshAppSession();
      }}
    >
      <div className={styles.profile}>
        <div className={styles.avatarPick}>
          <AgentAvatar avatar={avatar} size={88} mood="happy" name="Your avatar" />
          <Button size="sm" onClick={() => setAvatar(randomAvatar(nextSeed(avatar.seed)))}>
            Shuffle
          </Button>
        </div>
        <Field label="What should we call you?" hint="Your team sees this name and avatar.">
          <Input value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" maxLength={80} placeholder="Your name" />
        </Field>
      </div>
    </StepLayout>
  );
}
