"use client";

/**
 * The voice engine rows of the composer's model menu: Sibyl voice and GPT
 * Realtime with their price per minute, so "premium" is clear where models
 * are picked. Reads the session from the gateway context.
 */
import { Icon } from "../../components/Icon";
import { useAppSession } from "../../lib/app-session";
import { useGateway } from "../../lib/gateway";
import { activeEngine, perMinute, realtimeModelOf, unavailableText } from "./engines";
import styles from "./voice-engine.module.css";

export function VoiceEngineMenuItems({ onPicked }: { onPicked(): void }) {
  const { settings, capabilities, updateSettings } = useGateway();
  const { can } = useAppSession();
  const capability = capabilities?.voiceEngines;
  if (!capability || !can("models.choose")) return null;
  const engine = activeEngine(settings, capability);
  const model = realtimeModelOf(settings, capability);
  const blocked = unavailableText(capability);
  const rows = [
    { id: "sibyl" as const, label: "Sibyl voice", price: perMinute(capability.sibylUsdPerMinute), disabled: false },
    { id: "gpt-realtime" as const, label: "GPT Realtime · Premium", price: model ? perMinute(model.usdPerMinute) : undefined, disabled: !capability.realtime.available }
  ];
  return (
    <>
      <p className="popoverSection">Voice engine</p>
      {rows.map((row) => {
        const selected = engine === row.id;
        return (
          <button
            key={row.id}
            type="button"
            role="menuitemradio"
            aria-checked={selected}
            disabled={row.disabled}
            title={row.disabled ? blocked : undefined}
            className={`popoverItem${selected ? " selected" : ""}`}
            onClick={() => {
              updateSettings({ voiceEngine: row.id });
              onPicked();
            }}
          >
            <span className="monogram preset">{row.id === "sibyl" ? "S" : "R"}</span>
            <span className="popoverLabel">{row.label}</span>
            {row.price ? <span className={styles.menuPrice}>{row.price}</span> : null}
            {selected ? <Icon name="check" size={16} className="popoverCheck" /> : null}
          </button>
        );
      })}
      {blocked ? <p className={styles.menuNote}>{blocked}.</p> : null}
    </>
  );
}
