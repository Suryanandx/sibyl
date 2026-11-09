"use client";

import { AGENT_COMPUTER_LIMITS, type AgentComputerSettingsView } from "@open-gpt-live/protocol";
import { ButtonLink, Checkbox, Field, Input, Muted, Notice } from "../../components/ui";
import { paths } from "../../lib/routes";
import { useComputersInfo } from "./useComputer";
import styles from "./computers.module.css";

/**
 * The "Computer" part of the agent editor: give the agent its own sandboxed
 * browser, with its idle stop and daily time limit.
 */
export function ComputerSettings({
  value,
  agentId,
  onChange
}: {
  value: AgentComputerSettingsView | undefined;
  /** Set for a saved agent (links to its live view). */
  agentId?: string;
  onChange(value: AgentComputerSettingsView | undefined): void;
}) {
  const info = useComputersInfo();
  const enabled = value?.enabled ?? false;
  const set = (patch: Partial<AgentComputerSettingsView>) => {
    const next: AgentComputerSettingsView = { enabled, ...value, ...patch };
    for (const key of ["idleMinutes", "dailyMinutes"] as const) if (next[key] === undefined) delete next[key];
    onChange(next.enabled || next.idleMinutes || next.dailyMinutes ? next : undefined);
  };
  return (
    <>
      <Checkbox
        checked={enabled}
        onChange={(e) => set({ enabled: e.target.checked })}
        label="Give it its own computer"
      />
      {info && !info.available ? <Notice tone="warning">Not available on this gateway: {info.reason}</Notice> : null}
      {enabled ? (
        <>
          <div className={styles.pair}>
            <MinutesInput
              label="Stop when idle for (min)"
              limits={AGENT_COMPUTER_LIMITS.idleMinutes}
              placeholder={info ? String(info.defaults.idleMinutes) : ""}
              value={value?.idleMinutes}
              onChange={(idleMinutes) => set({ idleMinutes })}
            />
            <MinutesInput
              label="Computer time per day (min)"
              limits={AGENT_COMPUTER_LIMITS.dailyMinutes}
              placeholder={info ? String(info.defaults.dailyMinutes) : ""}
              value={value?.dailyMinutes}
              onChange={(dailyMinutes) => set({ dailyMinutes })}
            />
          </div>
          <Muted>
            It can browse public websites, download and read files. Submitting forms, signing in, sending, uploading and buying ask you first
            (buying always does). Private and local network addresses are blocked.
          </Muted>
          {agentId ? (
            <div>
              <ButtonLink href={paths.agentComputer(agentId)} size="sm">
                Watch its computer
              </ButtonLink>
            </div>
          ) : null}
        </>
      ) : null}
    </>
  );
}

function MinutesInput({
  label,
  limits,
  placeholder,
  value,
  onChange
}: {
  label: string;
  limits: { min: number; max: number };
  placeholder: string;
  value: number | undefined;
  onChange(value: number | undefined): void;
}) {
  return (
    <Field label={label}>
      <Input
        type="number"
        inputMode="numeric"
        min={limits.min}
        max={limits.max}
        step={1}
        placeholder={placeholder}
        value={value ?? ""}
        onChange={(e) => {
          const n = Number.parseInt(e.target.value, 10);
          onChange(e.target.value === "" || !Number.isFinite(n) ? undefined : Math.max(limits.min, Math.min(limits.max, n)));
        }}
      />
    </Field>
  );
}
