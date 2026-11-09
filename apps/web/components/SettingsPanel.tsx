"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type {
  ModelCatalog,
  ModelOption,
  ModelPreset,
  SessionCapabilities,
  SessionSettings,
  UsageView
} from "@open-gpt-live/protocol";
import { Icon } from "./Icon";

export type SettingsTab = "presets" | "models" | "voice" | "usage" | "diagnostics";
type Tab = SettingsTab;

const TAB_LABELS: Record<Tab, string> = {
  presets: "Presets",
  models: "Models",
  voice: "Voice",
  usage: "Usage",
  diagnostics: "Diagnostics"
};

interface SettingsPanelProps {
  open: boolean;
  catalog: ModelCatalog | null;
  settings: SessionSettings | null;
  capabilities: SessionCapabilities | null;
  disabled?: boolean;
  activePresetId: string | null;
  diagnostics?: ReactNode;
  /** Spend and budgets from the gateway (USAGE_UPDATE). */
  usage?: UsageView | null;
  /** Tab to show when the dialog opens (e.g. "usage" from a budget notice). */
  initialTab?: SettingsTab;
  /** Ask the gateway for fresh totals (sent when the Usage tab is shown). */
  onRequestUsage?: () => void;
  onChange: (patch: Partial<SessionSettings>) => void;
  onClose: () => void;
}

/** Models & voice: presets as plan-style cards, then fine-grained choices. */
export function SettingsPanel(props: SettingsPanelProps) {
  const [tab, setTab] = useState<Tab>("presets");
  const { open, initialTab } = props;
  const requestUsage = useRef(props.onRequestUsage);
  requestUsage.current = props.onRequestUsage;
  useEffect(() => {
    if (open && initialTab) setTab(initialTab);
  }, [open, initialTab]);
  useEffect(() => {
    if (open && tab === "usage") requestUsage.current?.();
  }, [open, tab]);
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
          {(["presets", "models", "voice", "usage", "diagnostics"] as Tab[]).map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={tab === id ? "active" : ""}
              onClick={() => setTab(id)}
            >
              {TAB_LABELS[id]}
            </button>
          ))}
        </div>

        {tab === "usage" ? (
          <UsageTab usage={props.usage ?? null} />
        ) : !catalog || !settings ? (
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

const FEATURE_LABELS: Record<string, string> = {
  voice: "Voice conversation",
  brain: "Deep work",
  stt: "Transcription",
  tts: "Speech",
  warmup: "Warm-up",
  scout: "Model scout",
  slides: "Slides",
  routine: "Routines",
  tool: "Tools"
};

/** Today, this month, this session, budget bars and spend by feature. */
function UsageTab(props: { usage: UsageView | null }) {
  const { usage } = props;
  if (!usage) return <p className="muted center">Loading usage…</p>;
  const features = Object.entries(usage.byFeature)
    .filter(([, usd]) => usd > 0)
    .sort((a, b) => b[1] - a[1]);
  const featureTotal = features.reduce((sum, [, usd]) => sum + usd, 0);
  return (
    <div className="fieldStack usagePanel">
      {usage.economyMode ? (
        <p className="usageEconomy" role="status">
          Economy mode is on: spending is close to a budget, so Sibyl is using the Cheapest preset&apos;s models.
        </p>
      ) : null}
      <div className="usageStats">
        <UsageStat label="Today" value={usage.todayUsd} />
        <UsageStat label="This month" value={usage.monthUsd} />
        <UsageStat label="This session" value={usage.sessionUsd} />
      </div>
      <BudgetBar label="Daily budget" spent={usage.todayUsd} cap={usage.dailyBudgetUsd} env="SIBYL_BUDGET_DAILY_USD" />
      <BudgetBar
        label="Monthly budget"
        spent={usage.monthUsd}
        cap={usage.monthlyBudgetUsd}
        env="SIBYL_BUDGET_MONTHLY_USD"
      />
      <div className="field">
        <span className="fieldLabel">This month by feature</span>
        {features.length ? (
          <ul className="usageFeatures">
            {features.map(([feature, usd]) => (
              <li key={feature}>
                <span>{FEATURE_LABELS[feature] ?? feature}</span>
                <span className="usageFeatureBar" aria-hidden>
                  <i style={{ width: `${featureTotal > 0 ? Math.max(2, (usd / featureTotal) * 100) : 0}%` }} />
                </span>
                <span className="usageAmount">{formatSpend(usd)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <span className="fieldHint">No spend recorded yet this month.</span>
        )}
      </div>
      <p className="muted small">
        Costs come from OpenRouter where it reports them; speech and some transcription are estimated from model
        pricing.
      </p>
    </div>
  );
}

function UsageStat(props: { label: string; value: number }) {
  return (
    <div className="usageStat">
      <span className="fieldHint">{props.label}</span>
      <strong>{formatSpend(props.value)}</strong>
    </div>
  );
}

function BudgetBar(props: { label: string; spent: number; cap?: number; env: string }) {
  if (props.cap === undefined) {
    return (
      <div className="field">
        <span className="fieldLabel">{props.label}</span>
        <span className="fieldHint">
          No cap set · add <code>{props.env}</code> to the gateway&apos;s .env
        </span>
      </div>
    );
  }
  const ratio = props.cap > 0 ? Math.min(1, props.spent / props.cap) : 1;
  const level = ratio >= 1 ? " over" : ratio >= 0.85 ? " near" : "";
  return (
    <div className="field">
      <span className="fieldLabel">{props.label}</span>
      <div
        className={`usageBar${level}`}
        role="progressbar"
        aria-label={props.label}
        aria-valuemin={0}
        aria-valuemax={props.cap}
        aria-valuenow={Math.min(props.spent, props.cap)}
      >
        <i style={{ width: `${ratio * 100}%` }} />
      </div>
      <span className="fieldHint">
        {formatSpend(props.spent)} of {formatSpend(props.cap)} · {Math.round(ratio * 100)}%
      </span>
    </div>
  );
}

/** Dollar amounts: cents for normal spend, more digits for tiny amounts. */
export function formatSpend(value: number): string {
  if (value === 0) return "$0.00";
  if (value >= 0.01) return "$" + value.toFixed(2);
  return "$" + value.toFixed(4);
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
