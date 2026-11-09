"use client";

/**
 * Agent editor → Voice: the agent's own voice engine (or the session's) and
 * its GPT Realtime voice (or the closest to its Sibyl voice).
 */
import type { AgentVoiceEngine, VoiceEngineId } from "@open-gpt-live/protocol";
import { Field, Muted, Select } from "../../components/ui";
import { useGateway } from "../../lib/gateway";
import { perMinute, realtimeModelOf, unavailableText, voiceLabel } from "./engines";
import styles from "./voice-engine.module.css";

export function AgentVoiceEngineFields({ value, onChange }: { value: AgentVoiceEngine; onChange(patch: AgentVoiceEngine): void }) {
  const { capabilities, settings } = useGateway();
  const capability = capabilities?.voiceEngines;
  if (!capability) return null;
  const model = realtimeModelOf(settings, capability);
  const blocked = unavailableText(capability);
  return (
    <>
      <div className={styles.grid}>
        <Field label="Voice engine" hint={value.engine === "gpt-realtime" && blocked ? `${blocked}; Sibyl voice answers until then.` : undefined}>
          <Select value={value.engine ?? ""} onChange={(event) => onChange({ engine: (event.target.value || undefined) as VoiceEngineId | undefined })}>
            <option value="">Same as the conversation</option>
            <option value="sibyl">Sibyl voice{capability.sibylUsdPerMinute !== undefined ? ` · ${perMinute(capability.sibylUsdPerMinute)}` : ""}</option>
            <option value="gpt-realtime">GPT Realtime (premium){model ? ` · ${perMinute(model.usdPerMinute)}` : ""}</option>
          </Select>
        </Field>
        <Field label="GPT Realtime voice">
          <Select value={value.realtimeVoice ?? ""} onChange={(event) => onChange({ realtimeVoice: event.target.value || undefined })}>
            <option value="">Closest to its voice</option>
            {capability.realtime.voices.map((voice) => (
              <option key={voice} value={voice}>
                {voiceLabel(voice)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Muted>On GPT Realtime the agent keeps its instructions, personality, tools and budget; only the voice changes.</Muted>
    </>
  );
}
