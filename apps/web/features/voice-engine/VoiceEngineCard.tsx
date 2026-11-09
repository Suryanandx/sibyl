"use client";

/**
 * Settings → Voice → "Voice engine": Sibyl voice (default) or GPT Realtime
 * (premium, OpenAI speech-to-speech), its model, voice and turn-taking, the
 * organization's OpenAI key (owners and admins) and the workspace switch
 * (workspace admins). Choices are the session's, stored in the browser like
 * model choices; the key and the switch are the gateway's.
 */
import { useCallback, useEffect, useState } from "react";
import type { SessionSettings, VoiceEngineCapability, VoiceEngineView } from "@open-gpt-live/protocol";
import { Badge, Button, Card, CardHeader, Checkbox, Field, Input, Muted, Notice, Row, Select, Stack } from "../../components/ui";
import { cx } from "../../components/ui";
import { useAppSession } from "../../lib/app-session";
import { errorText, gatewayRequest } from "../../lib/gateway-http";
import { TURN_OPTIONS, activeEngine, perMinute, realtimeModelOf, unavailableText, voiceLabel } from "./engines";
import styles from "./voice-engine.module.css";

export interface VoiceEngineCardProps {
  settings: SessionSettings | null;
  capability: VoiceEngineCapability | undefined;
  disabled?: boolean;
  onChange(patch: Partial<SessionSettings>): void;
}

export function VoiceEngineCard({ settings, capability, disabled, onChange }: VoiceEngineCardProps) {
  const { can } = useAppSession();
  const mayChoose = can("models.choose");
  const [view, setView] = useState<VoiceEngineView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setView(await gatewayRequest<VoiceEngineView>("/api/voice-engine"));
      setError(null);
    } catch (failure) {
      setError(errorText(failure));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, capability?.realtime.available, capability?.realtime.unavailableReason]);

  if (!capability) return null;
  const engine = activeEngine(settings, capability);
  const realtime = capability.realtime;
  const model = realtimeModelOf(settings, capability);
  const blockedText = unavailableText(capability);

  return (
    <Card>
      <CardHeader
        title="Voice engine"
        meta="How Sibyl talks with you live. Tools, visuals and approvals work the same on both."
        actions={engine === "gpt-realtime" ? <Badge tone="accent">Premium</Badge> : null}
      />
      <Stack gap={14}>
        <div className={styles.engines} role="radiogroup" aria-label="Voice engine">
          <EngineOption
            selected={engine === "sibyl"}
            disabled={disabled || !mayChoose}
            title="Sibyl voice"
            price={perMinute(capability.sibylUsdPerMinute)}
            text="Fast voice brain, deep brain and speech, chosen by the model scout. The default."
            onSelect={() => onChange({ voiceEngine: "sibyl" })}
          />
          <EngineOption
            selected={engine === "gpt-realtime"}
            disabled={disabled || !mayChoose || !realtime.available}
            title="GPT Realtime"
            badge="Premium"
            price={model ? perMinute(model.usdPerMinute) : undefined}
            text={blockedText ?? "OpenAI's speech-to-speech model: the most natural voice and turn-taking, for a higher price."}
            onSelect={() => onChange({ voiceEngine: "gpt-realtime" })}
          />
        </div>
        {!mayChoose ? <Muted>Members choose the voice engine in this workspace.</Muted> : null}

        {engine === "gpt-realtime" ? (
          <div className={styles.grid}>
            <Field label="Model" hint="Prices are OpenAI's, per minute of conversation (an estimate).">
              <Select value={model?.id ?? ""} disabled={disabled || !mayChoose} onChange={(event) => onChange({ realtimeModel: event.target.value })}>
                {realtime.models.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label} · {perMinute(option.usdPerMinute)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Voice">
              <Select value={settings?.realtimeVoice ?? realtime.defaultVoice} disabled={disabled} onChange={(event) => onChange({ realtimeVoice: event.target.value })}>
                {realtime.voices.map((voice) => (
                  <option key={voice} value={voice}>
                    {voiceLabel(voice)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Turn detection" hint={TURN_OPTIONS.find((option) => option.id === (settings?.realtimeTurn ?? "quick"))?.hint}>
              <Select value={settings?.realtimeTurn ?? "quick"} disabled={disabled} onChange={(event) => onChange({ realtimeTurn: event.target.value as SessionSettings["realtimeTurn"] })}>
                {TURN_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        ) : null}

        {error ? <Notice tone="danger">{error}</Notice> : null}
        {view ? <KeySection view={view} onView={setView} /> : null}
        {view ? <WorkspaceSwitch view={view} onView={setView} /> : null}
      </Stack>
    </Card>
  );
}

export function EngineOption(props: { selected: boolean; disabled?: boolean; title: string; badge?: string; price?: string; text: string; onSelect(): void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={props.selected}
      aria-label={`${props.title}${props.price ? `, ${props.price}` : ""}`}
      disabled={props.disabled}
      className={cx(styles.engine, props.selected && styles.selected)}
      onClick={props.onSelect}
    >
      <span className={styles.engineTop}>
        <strong>{props.title}</strong>
        {props.badge ? <Badge tone="outline">{props.badge}</Badge> : null}
        {props.price ? <span className={styles.price}>{props.price}</span> : null}
      </span>
      <span className={styles.engineText}>{props.text}</span>
    </button>
  );
}

/** The organization's OpenAI key (owners and admins change it). */
function KeySection({ view, onView }: { view: VoiceEngineView; onView(view: VoiceEngineView): void }) {
  const { can } = useAppSession();
  const mayChange = can("org.settings");
  const [key, setKey] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "positive" | "danger"; text: string } | null>(null);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setMessage(null);
    try {
      await work();
    } catch (failure) {
      setMessage({ tone: "danger", text: errorText(failure) });
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    run(async () => {
      onView(await gatewayRequest<VoiceEngineView>("/api/voice-engine/key", { method: "PUT", body: { key } }));
      setKey("");
      setEditing(false);
      setMessage({ tone: "positive", text: "Key saved. GPT Realtime is ready." });
    });
  const test = () =>
    run(async () => {
      const result = await gatewayRequest<{ ok: boolean; message: string }>("/api/voice-engine/key/test", { method: "POST" });
      setMessage({ tone: result.ok ? "positive" : "danger", text: result.message });
    });
  const remove = () =>
    run(async () => {
      onView(await gatewayRequest<VoiceEngineView>("/api/voice-engine/key", { method: "DELETE" }));
      setMessage({ tone: "positive", text: "Key removed." });
    });

  const source =
    view.keySource === "org" && view.key
      ? `Your organization's OpenAI key ••••${view.key.last4}`
      : view.keySource === "server"
        ? "The OpenAI key set on this server (OPENAI_API_KEY)."
        : view.hosted
          ? "No OpenAI key yet. GPT Realtime uses your organization's own key."
          : "No OpenAI key yet.";
  const showForm = mayChange && (editing || view.keySource !== "org");
  if (!mayChange && view.keySource !== "none") return null;
  return (
    <div className={styles.section}>
      <Row>
        <strong className={styles.sectionTitle}>OpenAI key</strong>
        <Muted as="span">{source}</Muted>
      </Row>
      {view.key && view.key.realtimeAccess === false ? <Notice tone="warning">OpenAI accepted the key, but it can&apos;t use {view.realtime.defaultModel} yet.</Notice> : null}
      {!mayChange ? <Muted>An organization owner or admin can add one in Settings → Voice.</Muted> : null}
      {showForm ? (
        <Field label={view.keySource === "org" ? "New OpenAI key" : "Your OpenAI key"} hint="Checked with OpenAI before it is saved. Kept encrypted in the vault, used only by the gateway, never shown again.">
          <Input type="password" mono autoComplete="off" spellCheck={false} placeholder="sk-…" value={key} onChange={(event) => setKey(event.target.value)} />
        </Field>
      ) : null}
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {mayChange ? (
        <Row>
          {showForm ? (
            <Button variant="primary" size="sm" onClick={() => void save()} disabled={busy || key.trim().length < 20}>
              {busy ? "Checking…" : "Save key"}
            </Button>
          ) : null}
          {view.keySource !== "none" ? (
            <Button size="sm" onClick={() => void test()} disabled={busy}>
              Test key
            </Button>
          ) : null}
          {view.keySource === "org" && !editing ? (
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
              Replace
            </Button>
          ) : null}
          {view.keySource === "org" ? (
            <Button size="sm" variant="ghost" onClick={() => void remove()} disabled={busy}>
              Remove
            </Button>
          ) : null}
        </Row>
      ) : null}
    </div>
  );
}

/** Workspace admins allow or block the premium engine here. */
function WorkspaceSwitch({ view, onView }: { view: VoiceEngineView; onView(view: VoiceEngineView): void }) {
  const { can } = useAppSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!can("workspace.settings")) return null;
  const toggle = async (allowRealtime: boolean) => {
    setBusy(true);
    setError(null);
    try {
      onView(await gatewayRequest<VoiceEngineView>("/api/voice-engine/policy", { method: "PUT", body: { allowRealtime } }));
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={styles.section}>
      <Checkbox
        label="Allow GPT Realtime in this workspace"
        checked={view.allowRealtime}
        disabled={busy}
        onChange={(event) => void toggle(event.target.checked)}
      />
      <Muted>Members can pick the premium engine for their own conversations. Spending counts toward this workspace&apos;s budget.</Muted>
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </div>
  );
}
