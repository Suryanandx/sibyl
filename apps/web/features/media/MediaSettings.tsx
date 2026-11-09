"use client";

/**
 * The model picker and settings for one kind of media, built from the
 * selected model's parameters as OpenRouter lists them. Used in the
 * composer's Create popover and in the Media page's Create panel.
 */
import { useEffect, useMemo, useState } from "react";
import type { MediaKind, MediaModelView, MediaModelsResponse, MediaParamSpec, MediaReferenceInput } from "@open-gpt-live/protocol";
import { estimateMedia, formatUsd, rememberChoice, settingsFor, type MediaEstimate } from "./api";
import styles from "./media.module.css";

export type MediaSettingsValue = Record<string, string | number | boolean>;

export interface MediaChoice {
  model: MediaModelView;
  settings: MediaSettingsValue;
}

export function MediaSettings(props: {
  kind: MediaKind;
  models: MediaModelsResponse;
  choice: MediaChoice;
  onChange: (choice: MediaChoice) => void;
  /** For the price: the prompt and references the request will carry. */
  prompt?: string;
  references?: MediaReferenceInput[];
}) {
  const { kind, models, choice } = props;
  const ofKind = models.models.filter((model) => model.kind === kind);
  const groups = kind === "audio"
    ? [
        { label: "Voice-over", items: ofKind.filter((m) => m.audioKind !== "music") },
        { label: "Music", items: ofKind.filter((m) => m.audioKind === "music") }
      ]
    : [{ label: "", items: ofKind }];
  const set = (key: string, value: string | number | boolean | undefined) => {
    const settings = { ...choice.settings };
    if (value === undefined || value === "") delete settings[key];
    else settings[key] = value;
    rememberChoice(kind, choice.model.id, settings);
    props.onChange({ model: choice.model, settings });
  };
  return (
    <div className={styles.settings}>
      <label className={styles.settingRow}>
        <span>Model</span>
        <select
          value={choice.model.id}
          onChange={(event) => {
            const model = ofKind.find((m) => m.id === event.target.value);
            if (!model) return;
            const settings = settingsFor(model);
            rememberChoice(kind, model.id, settings);
            props.onChange({ model, settings });
          }}
        >
          {groups.map((group) =>
            group.label ? (
              <optgroup key={group.label} label={group.label}>
                {group.items.map((model) => (
                  <ModelOption key={model.id} model={model} />
                ))}
              </optgroup>
            ) : (
              group.items.map((model) => <ModelOption key={model.id} model={model} />)
            )
          )}
        </select>
      </label>
      <p className={styles.modelNote}>
        {choice.model.priceLabel}
        {referenceNote(choice.model) ? ` · ${referenceNote(choice.model)}` : ""}
      </p>
      {choice.model.params.map((param) => (
        <ParamField key={param.key} param={param} value={choice.settings[param.key]} onChange={(value) => set(param.key, value)} />
      ))}
      <EstimateLine kind={kind} choice={choice} prompt={props.prompt ?? ""} references={props.references ?? []} />
    </div>
  );
}

function ModelOption({ model }: { model: MediaModelView }) {
  return (
    <option value={model.id}>
      {model.name.replace(/^[^:]+:\s*/, "")} — {model.priceLabel}
      {model.isDefault ? " (default)" : ""}
    </option>
  );
}

/** "Takes 9 reference images, first/last frame" */
export function referenceNote(model: MediaModelView): string {
  const parts: string[] = [];
  const { images, videos, audio, frames } = model.references;
  if (images) parts.push(`${images} reference image${images === 1 ? "" : "s"}`);
  if (videos) parts.push(`${videos} video${videos === 1 ? "" : "s"}`);
  if (audio) parts.push(`${audio} audio`);
  if (frames.length) parts.push(frames.map((f) => (f === "first_frame" ? "first" : "last")).join("/") + " frame");
  return parts.length ? `takes ${parts.join(", ")}` : "";
}

function ParamField(props: { param: MediaParamSpec; value: string | number | boolean | undefined; onChange: (value: string | number | boolean | undefined) => void }) {
  const { param, value } = props;
  if (param.type === "boolean") {
    return (
      <label className={styles.settingCheck} title={param.help}>
        <input type="checkbox" checked={value === true} onChange={(event) => props.onChange(event.target.checked)} />
        <span>{param.label}</span>
      </label>
    );
  }
  if (param.type === "enum") {
    const values = param.values ?? [];
    if (param.key === "aspect_ratio" && values.length <= 7) {
      return (
        <div className={styles.settingRow}>
          <span>{param.label}</span>
          <div className={styles.chips} role="radiogroup" aria-label={param.label}>
            {values.map((option) => (
              <button
                key={String(option)}
                type="button"
                role="radio"
                aria-checked={String(option) === String(value)}
                className={String(option) === String(value) ? styles.chipOn : styles.chip}
                onClick={() => props.onChange(option)}
              >
                {String(option)}
              </button>
            ))}
          </div>
        </div>
      );
    }
    return (
      <label className={styles.settingRow}>
        <span>{param.label}</span>
        <select
          value={value === undefined ? "" : String(value)}
          onChange={(event) => {
            const picked = values.find((option) => String(option) === event.target.value);
            props.onChange(picked);
          }}
        >
          {values.map((option) => (
            <option key={String(option)} value={String(option)}>
              {param.key === "duration" ? `${option} s` : String(option)}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (param.type === "range") {
    const isSeed = param.key === "seed";
    return (
      <label className={styles.settingRow} title={param.help}>
        <span>{param.label}</span>
        <input
          type="number"
          inputMode="numeric"
          min={param.min}
          max={param.max}
          step={param.step ?? 1}
          placeholder={isSeed ? "Random" : undefined}
          value={value === undefined ? "" : String(value)}
          onChange={(event) => props.onChange(event.target.value === "" ? undefined : Number(event.target.value))}
        />
      </label>
    );
  }
  return (
    <label className={styles.settingRow}>
      <span>{param.label}</span>
      <input type="text" maxLength={500} value={typeof value === "string" ? value : ""} onChange={(event) => props.onChange(event.target.value)} />
    </label>
  );
}

/** "≈ $0.17 · 40,630 video tokens …", re-priced as the settings change. */
export function EstimateLine(props: { kind: MediaKind; choice: MediaChoice; prompt: string; references: MediaReferenceInput[] }) {
  const estimate = useEstimate(props.kind, props.choice, props.prompt, props.references);
  if (!estimate) return null;
  return (
    <p className={styles.estimate} title={estimate.detail}>
      About <strong>{formatUsd(estimate.usd)}</strong>
      <span> · {estimate.detail}</span>
    </p>
  );
}

export function useEstimate(kind: MediaKind, choice: MediaChoice | undefined, prompt: string, references: MediaReferenceInput[]): MediaEstimate | undefined {
  const [estimate, setEstimate] = useState<MediaEstimate>();
  // Speech is priced by length; other kinds don't depend on the prompt.
  const promptKey = kind === "audio" ? prompt.length : 0;
  const key = useMemo(
    () => JSON.stringify({ m: choice?.model.id, s: choice?.settings, r: references.map((r) => [r.uploadId, r.role]), p: promptKey }),
    [choice, references, promptKey]
  );
  useEffect(() => {
    if (!choice) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      estimateMedia({ kind, model: choice.model.id, settings: choice.settings, references, prompt }, controller.signal)
        .then((value) => setEstimate(value))
        .catch(() => undefined);
    }, 250);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, kind]);
  return estimate;
}
