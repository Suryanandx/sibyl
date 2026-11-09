"use client";

import { useState } from "react";
import { PRESET_BLURBS } from "../../../components/SettingsPanel";
import { Muted, Notice } from "../../../components/ui";
import { useGateway } from "../../../lib/gateway";
import { usd } from "../../../lib/pricing";
import { updateOnboarding } from "../useOnboarding";
import { StepLayout, useFlow } from "../OnboardingFlow";
import styles from "../onboarding.module.css";

const DEFAULT_PRESET = "balanced";

/** Pick a style: the four model presets with typed and spoken prices; Balanced is preselected. */
export function StepStyle() {
  const { view } = useFlow();
  const { catalog, connected, activePresetId, updateSettings } = useGateway();
  const presets = catalog?.presets ?? [];
  const [picked, setPicked] = useState<string | null>(null);
  const chosen = picked ?? view.presetId ?? activePresetId ?? (presets.some((p) => p.id === DEFAULT_PRESET) ? DEFAULT_PRESET : presets[0]?.id ?? null);

  return (
    <StepLayout
      title="Pick a style"
      lead="Sibyl picks the models for you. Choose what matters most; you can change it any time in Settings."
      primaryDisabled={presets.length > 0 && !chosen}
      onPrimary={async () => {
        const preset = presets.find((item) => item.id === chosen);
        if (!preset) return;
        updateSettings(preset.settings);
        await updateOnboarding({ presetId: preset.id });
      }}
    >
      {presets.length === 0 ? (
        catalog || !connected ? (
          <Notice>Styles appear once Sibyl has ranked the models (MODEL_SELECTION=auto). You can continue; Sibyl uses its default models.</Notice>
        ) : (
          <Muted>Loading styles…</Muted>
        )
      ) : (
        <fieldset className={styles.choices}>
          <legend className={styles.srOnly}>Style</legend>
          {presets.map((preset) => (
            <label key={preset.id} className={styles.choice} data-checked={chosen === preset.id ? "true" : "false"}>
              <input type="radio" name="style" value={preset.id} checked={chosen === preset.id} onChange={() => setPicked(preset.id)} />
              <span className={styles.choiceMain}>
                <span className={styles.choiceTitle}>
                  {preset.label}
                  {preset.id === DEFAULT_PRESET ? <span className={styles.choiceTag}>Recommended</span> : null}
                </span>
                <span className={styles.choiceText}>{PRESET_BLURBS[preset.id] ?? ""}</span>
              </span>
              <span className={styles.prices}>
                {preset.costPer100Messages !== undefined ? (
                  <span>
                    <strong>{usd(preset.costPer100Messages)}</strong> typed
                  </span>
                ) : null}
                {preset.costPer100Turns !== undefined ? (
                  <span>
                    <strong>{usd(preset.costPer100Turns)}</strong> voice
                  </span>
                ) : null}
              </span>
            </label>
          ))}
          <Muted className={styles.small}>Prices are per 100 messages or spoken turns. Web searches add about $0.01 each.</Muted>
        </fieldset>
      )}
    </StepLayout>
  );
}
