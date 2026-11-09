"use client";

import Link from "next/link";
import { useEffect } from "react";
import { MemoryTab } from "../../components/MemoryTab";
import { ModelAccessCard } from "../../components/ModelAccessCard";
import { SecretsPanel } from "../../components/SecretsPanel";
import { ModelsSettings, Toggle, UsageSettings, VoiceSettings } from "../../components/SettingsPanel";
import { useVisualInspectorSetting, visualInspectorInDevelopment } from "../../components/VisualInspector";
import { useGateway } from "../../lib/gateway";
import { paths } from "../../lib/routes";
import type { LatencySnapshot } from "../../lib/latency-metrics";
import type { VadSnapshot } from "../../lib/vad-engine";
import { useVoiceDiagnostics } from "../chat/diagnostics";
import { VoiceEngineCard } from "../../features/voice-engine";

/** Settings sections backed by the live gateway connection. */

export function ModelsSection() {
  const gateway = useGateway();
  return (
    <>
      <ModelAccessCard />
      <ModelsSettings
        catalog={gateway.catalog}
        settings={gateway.settings}
        capabilities={gateway.capabilities}
        disabled={!gateway.connected}
        activePresetId={gateway.activePresetId}
        onChange={(patch) => gateway.updateSettings(patch)}
      />
      <p className="settingsFootnote">
        Tools and data sources Sibyl can use live in <Link href={paths.integrations}>Integrations</Link>.
      </p>
    </>
  );
}

export function VoiceSection() {
  const gateway = useGateway();
  return (
    <>
      <VoiceEngineCard
        settings={gateway.settings}
        capability={gateway.capabilities?.voiceEngines}
        disabled={!gateway.connected}
        onChange={(patch) => gateway.updateSettings(patch)}
      />
      <VoiceSettings
        catalog={gateway.catalog}
        settings={gateway.settings}
        capabilities={gateway.capabilities}
        disabled={!gateway.connected}
        onChange={(patch) => gateway.updateSettings(patch)}
      />
    </>
  );
}

export function MemorySection() {
  return <MemoryTab />;
}

export function UsageSection() {
  const { connected, requestUsage, usage } = useGateway();
  // Fresh totals each time the section is shown (and after reconnecting; a workspace switch asks again itself).
  useEffect(() => {
    if (connected) requestUsage();
  }, [connected, requestUsage]);
  return <UsageSettings usage={usage} />;
}

export function SecretsSection() {
  const { connected, requestSecrets, secrets, secretsError, saveSecret, deleteSecret } = useGateway();
  useEffect(() => {
    if (connected) requestSecrets();
  }, [connected, requestSecrets]);
  if (!connected && secrets === null) return <p className="muted">Waiting for Sibyl to connect…</p>;
  return (
    <SecretsPanel secrets={secrets} error={secretsError} disabled={!connected} onSave={saveSecret} onDelete={deleteSecret} />
  );
}

export function DiagnosticsSection() {
  const { gatewayUrl, sessionId, capabilities, status } = useGateway();
  const { latency, vad, liveMode, adaptiveEnabled } = useVoiceDiagnostics();
  const inspector = useVisualInspectorSetting();
  return (
    <div className="fieldStack">
      <Toggle
        label="Visual inspector"
        description={
          visualInspectorInDevelopment
            ? "Always on in development. Shows each generated visual: errors, warnings, timing and its source."
            : "A small Visuals button in the corner shows each generated visual: errors, warnings, timing and its source. Stays in this browser."
        }
        checked={visualInspectorInDevelopment || inspector.enabled}
        disabled={visualInspectorInDevelopment}
        onChange={inspector.setEnabled}
      />
      <LatencyPanel snapshot={latency} />
      <VadPanel snapshot={vad} liveMode={liveMode} adaptiveEnabled={adaptiveEnabled} />
      <p className="muted small">
        Gateway {gatewayUrl} · {status} · Session {sessionId ?? "pending"}
        {capabilities ? ` · ${capabilities.provider}` : ""}
      </p>
    </div>
  );
}

function LatencyPanel({ snapshot }: { snapshot: LatencySnapshot | null }) {
  const metrics = [
    ["STT first partial", snapshot?.sttFirstPartialMs],
    ["Final transcript", snapshot?.sttFinalMs],
    ["LLM first token", snapshot?.llmFirstDeltaMs],
    ["TTS first audio", snapshot?.ttsFirstAudioMs],
    ["Speech end → audio", snapshot?.speechEndToFirstAudioMs]
  ] as const;

  return (
    <section className="latencyPanel" aria-label="Voice latency metrics">
      <div className="latencyHeading">
        <strong>Latency</strong>
        <span>{snapshot ? `${snapshot.kind.toUpperCase()} · ${snapshot.status}` : "waiting for a request"}</span>
      </div>
      <dl>
        {metrics.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value === undefined ? "—" : `${value} ms`}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function VadPanel({
  snapshot,
  liveMode,
  adaptiveEnabled
}: {
  snapshot: VadSnapshot | null;
  liveMode: boolean;
  adaptiveEnabled: boolean;
}) {
  const state = !liveMode
    ? "off"
    : snapshot?.state === "calibrating"
      ? `calibrating ${Math.round(snapshot.calibrationProgress * 100)}%`
      : (snapshot?.state ?? "starting");

  return (
    <section className="vadPanel" aria-label="Voice activity detector status">
      <div className="vadHeading">
        <strong>Voice activity</strong>
        <span>{snapshot?.adaptive ?? adaptiveEnabled ? (liveMode ? "adaptive" : "adaptive ready") : "fixed fallback"}</span>
      </div>
      <dl>
        <div>
          <dt>State</dt>
          <dd>{state}</dd>
        </div>
        <div>
          <dt>RMS</dt>
          <dd>{formatVadLevel(snapshot?.rms)}</dd>
        </div>
        <div>
          <dt>Noise floor</dt>
          <dd>{formatVadLevel(snapshot?.noiseFloor)}</dd>
        </div>
        <div>
          <dt>Speech / silence</dt>
          <dd>
            {formatVadLevel(snapshot?.speechThreshold)} / {formatVadLevel(snapshot?.silenceThreshold)}
          </dd>
        </div>
      </dl>
    </section>
  );
}

function formatVadLevel(value: number | undefined): string {
  return value === undefined ? "—" : value.toFixed(4);
}
