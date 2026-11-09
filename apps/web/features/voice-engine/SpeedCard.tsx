"use client";

/**
 * Settings → Voice → "Speed" (Sibyl voice only): preemptive generation and
 * where speech and transcripts are made (OpenRouter, or LiveKit Inference on
 * LiveKit Cloud). Choices are the session's, like model choices.
 */
import type { SessionSettings, SpeechProviderCapability } from "@open-gpt-live/protocol";
import { Card, CardHeader, Muted, Stack } from "../../components/ui";
import { Toggle } from "../../components/SettingsPanel";
import { useAppSession } from "../../lib/app-session";
import { EngineOption } from "./VoiceEngineCard";
import { perMinute } from "./engines";
import styles from "./voice-engine.module.css";

export interface SpeedCardProps {
  settings: SessionSettings | null;
  speech: SpeechProviderCapability | undefined;
  disabled?: boolean;
  onChange(patch: Partial<SessionSettings>): void;
}

function livekitUnavailable(reason: SpeechProviderCapability["livekit"]["unavailableReason"]): string | undefined {
  switch (reason) {
    case "not_configured":
      return "Needs LiveKit Cloud: set LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET to a LiveKit Cloud project.";
    case "not_cloud":
      return "Your LiveKit server is self-hosted. LiveKit Inference runs only on LiveKit Cloud.";
    case "disabled":
      return "Turned off on this server.";
    default:
      return undefined;
  }
}

export function SpeedCard({ settings, speech, disabled, onChange }: SpeedCardProps) {
  const { can } = useAppSession();
  const mayChoose = can("models.choose");
  const livekit = speech?.livekit;
  const provider = settings?.speechProvider === "livekit" && livekit?.available ? "livekit" : "openrouter";
  return (
    <Card>
      <CardHeader title="Speed" meta="How quickly Sibyl voice starts to answer. Diagnostics shows each reply's timings." />
      <Stack gap={14}>
        <Toggle
          label="Start answering while you pause"
          description="Sibyl starts thinking when you pause, before it is sure you have finished. If you carry on, that start is thrown away. Saves a fraction of a second on most replies; a thrown-away start still costs a little."
          checked={settings?.preemptiveGeneration ?? true}
          disabled={disabled}
          onChange={(value) => onChange({ preemptiveGeneration: value })}
        />
        {livekit ? (
          <div className={styles.engines} role="radiogroup" aria-label="Speech and transcription">
            <EngineOption
              selected={provider === "openrouter"}
              disabled={disabled || !mayChoose}
              title="OpenRouter speech"
              text="The speech and transcription models the model scout picked, on your OpenRouter key. The default."
              onSelect={() => onChange({ speechProvider: "openrouter" })}
            />
            <EngineOption
              selected={provider === "livekit"}
              disabled={disabled || !mayChoose || !livekit.available}
              title="LiveKit Inference"
              price={perMinute(livekit.usdPerMinute)}
              text={
                livekitUnavailable(livekit.unavailableReason) ??
                `Fast streaming speech (${livekit.ttsModel}) and transcription (${livekit.sttModel}) hosted by LiveKit Cloud, billed to your LiveKit project. The price is for speech and transcription only; the voice brain stays on OpenRouter.`
              }
              onSelect={() => onChange({ speechProvider: "livekit" })}
            />
          </div>
        ) : null}
        {livekit && !mayChoose ? <Muted>Members choose where speech is made in this workspace.</Muted> : null}
      </Stack>
    </Card>
  );
}
