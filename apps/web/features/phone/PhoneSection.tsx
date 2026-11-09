"use client";

/**
 * Settings → Admin → Phone: the organization's phone line (docs/realtime.md#phone-calls).
 *
 * - How the line connects: a LiveKit phone number (LiveKit Cloud; rent or
 *   pick one here) or a SIP trunk at a provider (Twilio, Telnyx, Plivo,
 *   Vonage, …; needed for self-hosted LiveKit and to call out). The trunk
 *   password goes to the vault and is never shown again.
 * - Who answers, the greeting, business hours and the message after hours
 *   (it lands in the Inbox), who may ask for outbound calls, recording.
 * - Check the line (LiveKit, SIP, the provider, trunks, routing) and the call log.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type { LiveKitNumberView, PhoneHoursView, PhoneLineInput, PhoneOutboundView, PhoneProviderView, PhoneTestView } from "@open-gpt-live/protocol";
import settings from "../../components/settings/settings.module.css";
import { Badge, Button, Card, CardHeader, Checkbox, EmptyState, Field, Input, Muted, Notice, Row, Select, Stack, Textarea, cx } from "../../components/ui";
import { useAppSession } from "../../lib/app-session";
import { ENTERPRISE } from "../../lib/edition";
import { useGateway } from "../../lib/gateway";
import { GatewayError, errorText } from "../../lib/gateway-http";
import { CallLog } from "./CallLog";
import { phoneApi, type PhoneState } from "./api";
import styles from "./phone.module.css";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DEFAULT_HOURS: PhoneHoursView = { timeZone: "UTC", days: [1, 2, 3, 4, 5], open: "09:00", close: "17:00" };

interface Draft {
  provider: PhoneProviderView;
  numbers: string;
  address: string;
  username: string;
  password: string;
  agentId: string;
  greeting: string;
  hoursOn: boolean;
  hours: PhoneHoursView;
  afterHours: "voicemail" | "answer";
  voicemailGreeting: string;
  outbound: PhoneOutboundView;
  record: boolean;
}

function draftOf(state: PhoneState): Draft {
  const phone = state.phone;
  const browserZone = typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC";
  return {
    provider: phone?.provider ?? (state.cloud ? "livekit" : "twilio"),
    numbers: phone?.numbers.join("\n") ?? "",
    address: phone?.address ?? "",
    username: phone?.username ?? "",
    password: "",
    agentId: phone?.agentId ?? "",
    greeting: phone?.greeting ?? "",
    hoursOn: Boolean(phone?.hours),
    hours: phone?.hours ?? { ...DEFAULT_HOURS, timeZone: browserZone || "UTC" },
    afterHours: phone?.afterHours ?? "voicemail",
    voicemailGreeting: phone?.voicemailGreeting ?? "",
    outbound: phone?.outbound ?? "admin",
    record: phone?.record ?? false
  };
}

export function PhoneSection() {
  const gateway = useGateway();
  const [state, setState] = useState<PhoneState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await phoneApi.get());
      setError(null);
    } catch (caught) {
      if (caught instanceof GatewayError && caught.status === 404) setUnavailable(true);
      else setError(errorText(caught));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (unavailable || (gateway.capabilities && !gateway.capabilities.realtime)) {
    return (
      <EmptyState title="Phone calls need the realtime layer">
        <p>Turn on LiveKit first (LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET). Then set up the line here. See docs/realtime.md.</p>
      </EmptyState>
    );
  }
  if (!state) return error ? <Notice tone="danger">{error}</Notice> : <Muted>Loading the phone line…</Muted>;

  return (
    <Stack>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <LineForm state={state} onSaved={(phone) => setState({ ...state, phone })} onRemoved={() => setState({ ...state, phone: null })} />
      <TestCard configured={Boolean(state.phone)} />
      {state.phone ? <CallLog /> : null}
    </Stack>
  );
}

function LineForm({ state, onSaved, onRemoved }: { state: PhoneState; onSaved(phone: PhoneState["phone"]): void; onRemoved(): void }) {
  const session = useAppSession();
  const gateway = useGateway();
  const [draft, setDraft] = useState<Draft>(() => draftOf(state));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const phone = state.phone;
  const livekit = draft.provider === "livekit";
  const preset = state.providers.find((item) => item.id === draft.provider);
  const canRecord = session.hasFeature("recordings");
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setSaved(false);
    setDraft((current) => ({ ...current, [key]: value }));
  };

  useEffect(() => setDraft(draftOf(state)), [state]);

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const input: PhoneLineInput = {
        provider: draft.provider,
        numbers: draft.numbers.split(/[\s,;]+/).filter(Boolean),
        ...(livekit ? {} : { address: draft.address.trim(), username: draft.username.trim() }),
        ...(draft.password ? { password: draft.password } : {}),
        agentId: draft.agentId || null,
        greeting: draft.greeting,
        hours: draft.hoursOn ? draft.hours : null,
        afterHours: draft.afterHours,
        voicemailGreeting: draft.voicemailGreeting,
        outbound: livekit ? "off" : draft.outbound,
        record: canRecord && draft.record
      };
      onSaved(await phoneApi.save(input));
      setSaved(true);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    if (!window.confirm("Remove the phone line? Calls to its numbers stop reaching Sibyl. The call log stays.")) return;
    setBusy(true);
    try {
      await phoneApi.remove();
      onRemoved();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card as="form" onSubmit={(event) => void save(event)}>
      <CardHeader
        title="Phone line"
        meta={phone ? `${phone.numbers.join(", ")} · ${phone.openNow ? "open now" : "closed now"}` : "Give Sibyl a phone number: people can call her, and she can call out for you."}
        actions={phone ? <Badge tone={phone.openNow ? "positive" : "neutral"}>{phone.provider === "livekit" ? "LiveKit number" : preset?.label ?? "SIP"}</Badge> : null}
      />

      <fieldset className={styles.choice}>
        <legend className={styles.legend}>How the line connects</legend>
        <label className={cx(styles.option, livekit && styles.optionOn, !state.cloud && styles.optionOff)}>
          <input type="radio" name="provider" checked={livekit} disabled={!state.cloud} onChange={() => set("provider", "livekit")} />
          <span>
            <strong>A LiveKit phone number</strong>
            <span className={styles.optionText}>
              Rent a US number straight from LiveKit Cloud. No other account needed. Incoming calls only for now; calling out needs a SIP provider.
              {!state.cloud ? " Needs LiveKit Cloud (your LiveKit is self-hosted)." : ""}
            </span>
          </span>
        </label>
        <label className={cx(styles.option, !livekit && styles.optionOn)}>
          <input type="radio" name="provider" checked={!livekit} onChange={() => set("provider", phone && phone.provider !== "livekit" ? phone.provider : "twilio")} />
          <span>
            <strong>Your SIP provider</strong>
            <span className={styles.optionText}>Twilio, Telnyx, Plivo, Vonage or any SIP trunk. Works with self-hosted LiveKit, any country the provider covers, and calling out.</span>
          </span>
        </label>
      </fieldset>

      {livekit ? (
        <LiveKitNumbers selected={draft.numbers} onSelect={(numbers) => set("numbers", numbers)} />
      ) : (
        <>
          <div className={styles.pair}>
            <Field label="Provider">
              <Select value={draft.provider} onChange={(event) => set("provider", event.target.value as PhoneProviderView)}>
                {state.providers
                  .filter((item) => item.id !== "livekit")
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label="SIP address" hint="Where LiveKit sends outbound calls (the trunk's termination URI).">
              <Input value={draft.address} placeholder={preset?.addressHint} onChange={(event) => set("address", event.target.value)} spellCheck={false} />
            </Field>
          </div>
          <div className={styles.pair}>
            <Field label="User name" hint="The trunk's credential list.">
              <Input value={draft.username} autoComplete="off" onChange={(event) => set("username", event.target.value)} spellCheck={false} />
            </Field>
            <Field label="Password" hint={phone?.hasPassword ? "Stored in the vault. Leave empty to keep it." : "Stored in the vault, sent only to LiveKit. Never shown again."}>
              <Input type="password" value={draft.password} autoComplete="new-password" placeholder={phone?.hasPassword ? "••••••••  (stored)" : ""} onChange={(event) => set("password", event.target.value)} />
            </Field>
          </div>
          <Field label="Phone numbers" hint="E.164, one per line, like +15551234567. The first one is the caller ID when Sibyl calls out.">
            <Textarea className={styles.short} rows={2} value={draft.numbers} onChange={(event) => set("numbers", event.target.value)} spellCheck={false} />
          </Field>
        </>
      )}

      <h4 className={styles.subhead}>Answering</h4>
      <div className={styles.pair}>
        <Field label="Who answers">
          <Select value={draft.agentId} onChange={(event) => set("agentId", event.target.value)}>
            <option value="">Sibyl</option>
            {gateway.agents.agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Greeting">
          <Input value={draft.greeting} maxLength={300} placeholder="Hello, this is Sibyl. How can I help?" onChange={(event) => set("greeting", event.target.value)} />
        </Field>
      </div>
      <Checkbox label="Business hours (outside them, callers can leave a message)" checked={draft.hoursOn} onChange={(event) => set("hoursOn", event.target.checked)} />
      {draft.hoursOn ? (
        <div className={styles.hours}>
          <div className={styles.days} role="group" aria-label="Open days">
            {DAYS.map((label, day) => (
              <Checkbox
                key={label}
                label={label}
                checked={draft.hours.days.includes(day)}
                onChange={(event) =>
                  set("hours", { ...draft.hours, days: event.target.checked ? [...draft.hours.days, day].sort() : draft.hours.days.filter((item) => item !== day) })
                }
              />
            ))}
          </div>
          <div className={styles.pair}>
            <Field label="Opens">
              <Input type="time" value={draft.hours.open} onChange={(event) => set("hours", { ...draft.hours, open: event.target.value })} />
            </Field>
            <Field label="Closes">
              <Input type="time" value={draft.hours.close} onChange={(event) => set("hours", { ...draft.hours, close: event.target.value })} />
            </Field>
            <Field label="Time zone">
              <Input value={draft.hours.timeZone} onChange={(event) => set("hours", { ...draft.hours, timeZone: event.target.value })} spellCheck={false} />
            </Field>
          </div>
          <Field label="After hours">
            <Select value={draft.afterHours} onChange={(event) => set("afterHours", event.target.value as Draft["afterHours"])}>
              <option value="voicemail">Take a message (it goes to the Inbox, with the transcript)</option>
              <option value="answer">Answer anyway</option>
            </Select>
          </Field>
          {draft.afterHours === "voicemail" ? (
            <Field label="Message greeting">
              <Textarea className={styles.short} rows={2} maxLength={400} value={draft.voicemailGreeting} placeholder="Hello, you've reached us outside our opening hours. Please leave your name, number and message after this, and we'll get back to you." onChange={(event) => set("voicemailGreeting", event.target.value)} />
            </Field>
          ) : null}
        </div>
      ) : null}

      <h4 className={styles.subhead}>Calling out</h4>
      <Field label="Who may ask Sibyl to call someone" hint={livekit ? "LiveKit numbers take incoming calls only. Add a SIP provider to call out." : "Every call still shows an approval card first."}>
        <Select value={livekit ? "off" : draft.outbound} disabled={livekit} onChange={(event) => set("outbound", event.target.value as PhoneOutboundView)}>
          <option value="admin">Owners and admins</option>
          <option value="member">Members too</option>
          <option value="off">Nobody (incoming calls only)</option>
        </Select>
      </Field>

      <h4 className={styles.subhead}>Recording</h4>
      <Checkbox
        label="Record every call (callers hear “This call is being recorded”)"
        checked={canRecord && draft.record}
        disabled={!canRecord}
        onChange={(event) => set("record", event.target.checked)}
      />
      {!canRecord ? <Muted>Call recordings come with {ENTERPRISE.name}.</Muted> : null}

      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Row>
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? "Saving…" : phone ? "Save changes" : "Set up the line"}
        </Button>
        {saved ? (
          <Muted as="span">
            <span role="status">Saved</span>
          </Muted>
        ) : null}
        {phone ? (
          <Button variant="ghost" onClick={() => void remove()} disabled={busy}>
            Remove the line
          </Button>
        ) : null}
      </Row>
    </Card>
  );
}

/** LiveKit Cloud numbers: the project's own, and ones to rent by area code. */
function LiveKitNumbers({ selected, onSelect }: { selected: string; onSelect(numbers: string): void }) {
  const [owned, setOwned] = useState<LiveKitNumberView[] | null>(null);
  const [available, setAvailable] = useState<LiveKitNumberView[]>([]);
  const [areaCode, setAreaCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = useMemo(() => new Set(selected.split(/[\s,;]+/).filter(Boolean)), [selected]);

  const load = useCallback(async (code?: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await phoneApi.numbers(code);
      setOwned(result.owned);
      setAvailable(result.available);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function toggle(number: string, on: boolean): void {
    const next = new Set(chosen);
    if (on) next.add(number);
    else next.delete(number);
    onSelect([...next].join("\n"));
  }

  async function rent(number: string): Promise<void> {
    if (!window.confirm(`Rent ${number} from LiveKit? LiveKit bills phone numbers monthly (one local number is included with every Cloud plan).`)) return;
    setBusy(true);
    try {
      const bought = await phoneApi.buy(number);
      toggle(bought.number, true);
      await load();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.numbers}>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <p className={styles.legend}>This project's numbers</p>
      {owned === null ? (
        <Muted>Loading…</Muted>
      ) : owned.length === 0 ? (
        <Muted>No numbers yet. Rent one below.</Muted>
      ) : (
        <ul className={settings.rows}>
          {owned.map((item) => (
            <li key={item.number} className={settings.row}>
              <Checkbox label={item.number} checked={chosen.has(item.number)} onChange={(event) => toggle(item.number, event.target.checked)} />
              <span className={settings.rowMeta}>{[item.locality, item.region].filter(Boolean).join(", ")}</span>
              <Badge tone={item.status === "active" ? "positive" : "neutral"}>{item.routed ? "Routed to Sibyl" : item.status}</Badge>
            </li>
          ))}
        </ul>
      )}
      {/* Inside the line's form: no nested form; Enter searches instead of saving. */}
      <div className={styles.search}>
        <Field label="Find a US number by area code">
          <Input
            value={areaCode}
            inputMode="numeric"
            maxLength={3}
            placeholder="415"
            onChange={(event) => setAreaCode(event.target.value.replace(/\D/g, ""))}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              void load(areaCode);
            }}
          />
        </Field>
        <Button onClick={() => void load(areaCode)} disabled={busy}>
          Search
        </Button>
      </div>
      {available.length > 0 ? (
        <ul className={settings.rows}>
          {available.map((item) => (
            <li key={item.number} className={settings.row}>
              <span className={settings.rowMain}>
                <span className={settings.rowTitle}>{item.number}</span>
                <span className={settings.rowMeta}>{[item.locality, item.region].filter(Boolean).join(", ")}</span>
              </span>
              <Button size="sm" onClick={() => void rent(item.number)} disabled={busy}>
                Rent
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function TestCard({ configured }: { configured: boolean }) {
  const [result, setResult] = useState<PhoneTestView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setResult(await phoneApi.test());
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Check the line"
        meta={configured ? "Checks LiveKit, its SIP service, the provider's address, the trunks and the routing. It doesn't place a call." : "Checks LiveKit and its SIP service."}
        actions={
          <Button onClick={() => void run()} disabled={busy}>
            {busy ? "Checking…" : "Test"}
          </Button>
        }
      />
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {result ? (
        <ul className={settings.rows} aria-label="Test results">
          {result.steps.map((step) => (
            <li key={step.id} className={settings.row}>
              <Badge tone={step.status === "ok" ? "positive" : step.status === "failed" ? "danger" : step.status === "warning" ? "warning" : "neutral"}>
                {step.status === "ok" ? "OK" : step.status === "failed" ? "Failed" : step.status === "warning" ? "Check" : "Skipped"}
              </Badge>
              <span className={settings.rowMain}>
                <span className={settings.rowTitle}>{step.label}</span>
                <span className={settings.rowMeta}>{step.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}
