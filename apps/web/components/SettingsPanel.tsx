"use client";

import { useState, type ReactNode } from "react";
import type {
  ModelCatalog,
  ModelOption,
  ModelPreset,
  SessionCapabilities,
  SessionSettings
} from "@open-gpt-live/protocol";
import { Icon } from "./Icon";

type Tab = "presets" | "models" | "voice" | "diagnostics";

interface SettingsPanelProps {
  open: boolean;
  catalog: ModelCatalog | null;
  settings: SessionSettings | null;
  capabilities: SessionCapabilities | null;
  disabled?: boolean;
  activePresetId: string | null;
  diagnostics?: ReactNode;
  onChange: (patch: Partial<SessionSettings>) => void;
  onClose: () => void;
}

/** Models & voice: presets as plan-style cards, then fine-grained choices. */
export function SettingsPanel(props: SettingsPanelProps) {
  const [tab, setTab] = useState<Tab>("presets");
  if (!props.open) return null;
  const { catalog, settings, capabilities } = props;

  return (
    <div className="dialogBackdrop" onClick={props.onClose}>
      <section
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Models and voice"
        onClick={(event) => event.stopPropagation()}
      >
        <button type="button" className="iconBtn dialogClose" onClick={props.onClose} aria-label="Close">
          <Icon name="close" />
        </button>
        <header className="dialogHeader">
          <h2>Models &amp; voice</h2>
          <p>
            Sibyl picks models from OpenRouter by cost, measured speed and benchmarks.
            Choose a preset, or tune each part yourself.
          </p>
        </header>

        <div className="segmented" role="tablist" aria-label="Settings sections">
          {(["presets", "models", "voice", "diagnostics"] as Tab[]).map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={tab === id ? "active" : ""}
              onClick={() => setTab(id)}
            >
              {id === "presets" ? "Presets" : id === "models" ? "Models" : id === "voice" ? "Voice" : "Diagnostics"}
            </button>
          ))}
        </div>

        {!catalog || !settings ? (
          <p className="muted center">Waiting for Sibyl to connect…</p>
        ) : tab === "presets" ? (
          catalog.presets?.length ? (
            <div className="planGrid">
              {catalog.presets.map((preset) => (
                <PlanCard
                  key={preset.id}
                  preset={preset}
                  catalog={catalog}
                  active={preset.id === props.activePresetId}
                  disabled={props.disabled}
                  onUse={() => props.onChange(preset.settings)}
                />
              ))}
            </div>
          ) : (
            <p className="muted center">
              Presets appear once the model scout has ranked OpenRouter&apos;s catalog (set MODEL_SELECTION=auto).
            </p>
          )
        ) : tab === "models" ? (
          <div className="fieldStack">
            {catalog.voice?.length && settings.voiceModel ? (
              <ModelSelect
                label="Voice brain"
                hint="Hears your voice directly — tone, pauses, emotion — and talks back."
                value={settings.voiceModel}
                options={catalog.voice}
                disabled={props.disabled}
                onChange={(voiceModel) => props.onChange({ voiceModel })}
              />
            ) : null}
            <ModelSelect
              label={settings.voiceModel ? "Deep work" : "Chat model"}
              hint={
                settings.voiceModel
                  ? "Takes over careful reasoning and builds the visuals."
                  : "Writes the answer and the visuals."
              }
              value={settings.llmModel}
              options={catalog.llm}
              disabled={props.disabled}
              onChange={(llmModel) => props.onChange({ llmModel })}
            />
            <ModelSelect
              label="Transcription"
              hint="Keeps an accurate written record of what you said."
              value={settings.sttModel}
              options={catalog.stt}
              disabled={props.disabled}
              onChange={(sttModel) => props.onChange({ sttModel })}
            />
            {capabilities ? (
              <p className="muted small">
                Provider: {capabilities.provider}
                {capabilities.realtimeStt ? " · realtime transcription" : ""}
              </p>
            ) : null}
          </div>
        ) : tab === "voice" ? (
          <div className="fieldStack">
            <Toggle
              label="Speak replies aloud"
              description={capabilities?.tts ? undefined : "Speech is turned off on the server (TTS_ENABLED=false)."}
              checked={settings.speak}
              disabled={!capabilities?.tts || props.disabled}
              onChange={(speak) => props.onChange({ speak })}
            />
            {catalog.tts.length && settings.ttsModel ? (
              <ModelSelect
                label="Voice model"
                value={settings.ttsModel}
                options={catalog.tts}
                disabled={props.disabled || !settings.speak}
                onChange={(ttsModel) => props.onChange({ ttsModel })}
              />
            ) : null}
            <VoiceSelect catalog={catalog} settings={settings} disabled={props.disabled} onChange={props.onChange} />
            <Toggle
              label="Visual answers"
              description="Charts, tables, cards and forms appear next to the spoken reply. The visual is never read aloud."
              checked={settings.genUi}
              disabled={!capabilities?.genUi || props.disabled}
              onChange={(genUi) => props.onChange({ genUi })}
            />
          </div>
        ) : (
          <div className="fieldStack">{props.diagnostics}</div>
        )}
      </section>
    </div>
  );
}

function PlanCard(props: {
  preset: ModelPreset;
  catalog: ModelCatalog;
  active: boolean;
  disabled?: boolean;
  onUse: () => void;
}) {
  const { preset, catalog } = props;
  const find = (list: ModelOption[] | undefined, id?: string) => list?.find((model) => model.id === id);
  const rows: Array<{ role: string; model?: ModelOption }> = [
    { role: "Voice brain", model: find(catalog.voice, preset.settings.voiceModel) },
    { role: "Deep work", model: find(catalog.llm, preset.settings.llmModel) },
    { role: "Voice", model: find(catalog.tts, preset.settings.ttsModel) },
    { role: "Transcription", model: find(catalog.stt, preset.settings.sttModel) }
  ];
  const blurb: Record<string, string> = {
    cheapest: "Lowest cost per turn, within live speed limits.",
    balanced: "The best mix of cost, speed and quality.",
    fastest: "Quickest replies, for the most natural back-and-forth.",
    best: "Highest benchmark quality where it matters."
  };
  return (
    <article className={`plan${props.active ? " active" : ""}`}>
      <div className="planTop">
        <span className="planTag">{preset.label}</span>
        {props.active ? <span className="planCurrent">Current</span> : null}
      </div>
      <p className="planPrice">
        {preset.costPer100Turns !== undefined ? `$${preset.costPer100Turns.toFixed(2)}` : "—"}
        <span> / 100 turns</span>
      </p>
      <p className="planBlurb">{blurb[preset.id] ?? ""}</p>
      <ul className="planList">
        {rows
          .filter((row) => row.model)
          .map((row) => (
            <li key={row.role}>
              <span className="planCheck">
                <Icon name="check" size={12} strokeWidth={2.2} />
              </span>
              <span>
                <strong>{row.model!.label}</strong>
                <em>
                  {row.role}
                  {row.model!.latencyMs !== undefined ? ` · ${(row.model!.latencyMs / 1000).toFixed(1)}s` : ""}
                </em>
              </span>
            </li>
          ))}
      </ul>
      <button type="button" className="planBtn" disabled={props.disabled || props.active} onClick={props.onUse}>
        {props.active ? "In use" : `Use ${preset.label.toLowerCase()}`}
      </button>
    </article>
  );
}

function ModelSelect(props: {
  label: string;
  hint?: string;
  value: string;
  options: ModelOption[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const current = props.options.find((option) => option.id === props.value);
  return (
    <label className="field">
      <span className="fieldLabel">{props.label}</span>
      <span className="selectWrap">
        <select value={props.value} disabled={props.disabled} onChange={(event) => props.onChange(event.target.value)}>
          {props.options.map((option) => (
            <option key={option.id} value={option.id}>
              {optionText(option)}
            </option>
          ))}
        </select>
        <Icon name="chevronDown" size={15} className="selectChevron" />
      </span>
      <span className="fieldHint">
        <code>{props.value}</code>
        {current?.description ? ` · ${current.description}` : props.hint ? ` · ${props.hint}` : ""}
      </span>
    </label>
  );
}

function VoiceSelect(props: {
  catalog: ModelCatalog;
  settings: SessionSettings;
  disabled?: boolean;
  onChange: (patch: Partial<SessionSettings>) => void;
}) {
  const model = props.catalog.tts.find((option) => option.id === props.settings.ttsModel);
  const voices = model?.voices ?? [];
  if (!voices.length) return null;
  return (
    <label className="field">
      <span className="fieldLabel">Voice</span>
      <span className="selectWrap">
        <select
          value={props.settings.ttsVoice ?? ""}
          disabled={props.disabled || !props.settings.speak}
          onChange={(event) => props.onChange({ ttsVoice: event.target.value })}
        >
          {voices.map((voice) => (
            <option key={voice} value={voice}>
              {voice}
            </option>
          ))}
        </select>
        <Icon name="chevronDown" size={15} className="selectChevron" />
      </span>
    </label>
  );
}

function Toggle(props: {
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="toggleRow">
      <span>
        <span className="fieldLabel">{props.label}</span>
        {props.description ? <span className="fieldHint">{props.description}</span> : null}
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.checked)}
      />
      <span className="switch" aria-hidden />
    </label>
  );
}

function formatUsd(value: number): string {
  if (value >= 1) return "$" + value.toFixed(2);
  if (value >= 0.01) return "$" + value.toFixed(3);
  return "$" + value.toPrecision(2);
}

function optionText(option: ModelOption): string {
  const parts = [option.label];
  if (option.costPer100Turns !== undefined) parts.push(formatUsd(option.costPer100Turns) + "/100");
  if (option.latencyMs !== undefined) parts.push((option.latencyMs / 1000).toFixed(1) + "s");
  return parts.join(" · ");
}
