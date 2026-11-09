"use client";

import { useId, useRef, useState, type ReactNode } from "react";
import {
  AVATAR_ACCESSORIES,
  AVATAR_EYES,
  AVATAR_KINDS,
  AVATAR_MOODS,
  AVATAR_MOUTHS,
  AVATAR_PALETTES,
  AVATAR_PALETTE_IDS,
  nextSeed,
  randomAvatar,
  type AvatarMood
} from "@open-gpt-live/core/avatar";
import type { AgentAccessView, AgentAvatarView, AgentInput, AgentMemoryView, AgentView, ModelCatalog } from "@open-gpt-live/protocol";
import { uploadFile } from "../../components/AttachmentClient";
import { AgentAvatar } from "./AgentAvatar";
import { ComputerSettings } from "../computers/ComputerSettings";
import { Button, Card, CardHeader, Checkbox, Field, Input, Muted, Notice, Row, Select, SectionTitle, Textarea, Toolbar } from "../../components/ui";
import { PresenceSection } from "../presence";
import { AgentVoiceEngineFields } from "../voice-engine/AgentVoiceEngineFields";
import styles from "./agents.module.css";

/** What the agent may be given access to (the app shell passes what the workspace has). */
export interface AgentAccessOptions {
  tools?: Array<{ name: string; title: string; provider?: string; effect?: "read" | "write" }>;
  connectors?: Array<{ id: string; name: string }>;
  knowledgeBases?: Array<{ id: string; name: string }>;
  skills?: Array<{ id: string; name: string; title?: string }>;
  secrets?: string[];
}

export interface AgentEditorProps {
  /** The agent to edit, or a draft (template / blank). */
  initial: AgentInput;
  /** Set when editing an existing agent. */
  existing?: AgentView;
  catalog?: ModelCatalog | null;
  access?: AgentAccessOptions;
  canShare: boolean;
  memory?: AgentMemoryView[];
  onSave(agent: AgentInput): Promise<unknown>;
  onCancel(): void;
  onDelete?(): void;
  onPreviewVoice?(input: { ttsModel?: string; ttsVoice?: string; name?: string }): Promise<string>;
  onSaveMemory?(text: string, itemId?: string): void;
  onDeleteMemory?(itemId: string): void;
  onReviewLearning?(): void;
}

const KIND_LABEL: Record<(typeof AVATAR_KINDS)[number], string> = {
  dot: "Dot",
  blob: "Blob",
  cat: "Cat",
  bird: "Bird",
  bot: "Bot",
  ghost: "Ghost",
  "custom-image": "Photo"
};

const AUTONOMY: Array<{ id: AgentInput["autonomy"]; title: string; text: string }> = [
  { id: "ask_first", title: "Ask me first", text: "Every action that changes something waits for your approval." },
  { id: "act_then_tell", title: "Act, then tell me", text: "Runs actions within its budget and reports each one in your inbox." },
  { id: "autonomous", title: "Fully autonomous", text: "Works on its own within budget. Sending money, deleting and sharing outside always ask." }
];

const LEARNING: Array<{ id: AgentInput["learning"]; title: string; text: string }> = [
  { id: "ask_first", title: "Ask me first", text: "Suggests new skills and memories; you approve each one." },
  { id: "automatic", title: "Learn automatically", text: "Keeps what it learns right away. Everything stays visible and can be rolled back." },
  { id: "off", title: "Don't learn", text: "Never changes its own skills or memory." }
];

export function blankAgent(seed = Math.random().toString(36).slice(2, 8)): AgentInput {
  return {
    name: "",
    description: "",
    avatar: randomAvatar(seed),
    instructions: "",
    access: { mode: "inherit" },
    autonomy: "ask_first",
    learning: "ask_first",
    visibility: "private"
  };
}

export function AgentEditor(props: AgentEditorProps) {
  const [draft, setDraft] = useState<AgentInput>(props.initial);
  const [mood, setMood] = useState<AvatarMood>("idle");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [voiceState, setVoiceState] = useState<"idle" | "loading" | "playing" | "error">("idle");
  const [uploading, setUploading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const id = useId();
  const patch = (next: Partial<AgentInput>) => setDraft((d) => ({ ...d, ...next }));
  const patchAvatar = (next: Partial<AgentAvatarView>) => setDraft((d) => ({ ...d, avatar: { ...d.avatar, ...next } }));

  const tts = props.catalog?.tts ?? [];
  const ttsModel = tts.find((m) => m.id === draft.voice?.ttsModel);
  const voices = (ttsModel ?? tts[0])?.voices ?? [];
  const presets = props.catalog?.presets ?? [];

  const shuffle = () => {
    const seed = nextSeed(draft.avatar.seed + Date.now());
    setDraft((d) => ({ ...d, avatar: randomAvatar(seed) }));
    setMood("happy");
    window.setTimeout(() => setMood("idle"), 900);
  };

  const onUpload = async (file: File | undefined) => {
    if (!file) return;
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
      setError("Use a PNG, JPEG, WebP or GIF image.");
      return;
    }
    setUploading(true);
    setError(undefined);
    try {
      const uploaded = await uploadFile(file).promise;
      patchAvatar({ kind: "custom-image", imageUploadId: uploaded.id });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  };

  const preview = async () => {
    if (!props.onPreviewVoice) return;
    audioRef.current?.pause();
    setVoiceState("loading");
    try {
      const url = await props.onPreviewVoice({
        ...(draft.voice?.ttsModel ? { ttsModel: draft.voice.ttsModel } : {}),
        ...(draft.voice?.ttsVoice ? { ttsVoice: draft.voice.ttsVoice } : {}),
        name: draft.name || "your new agent"
      });
      const audio = new Audio(url);
      audioRef.current = audio;
      setVoiceState("playing");
      setMood("speaking");
      audio.onended = () => {
        setVoiceState("idle");
        setMood("idle");
      };
      await audio.play();
    } catch {
      setVoiceState("error");
      setMood("idle");
    }
  };

  const save = async () => {
    if (!draft.name.trim()) {
      setError("Give your agent a name.");
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      await props.onSave({ ...draft, name: draft.name.trim() });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the agent.");
    } finally {
      setSaving(false);
    }
  };

  const setVoice = (next: Partial<NonNullable<AgentInput["voice"]>>) => {
    const voice = { ...draft.voice, ...next };
    for (const key of Object.keys(voice) as Array<keyof typeof voice>) if (!voice[key]) delete voice[key];
    patch({ voice: Object.keys(voice).length ? voice : undefined });
  };

  const controlled: Extract<AgentAccessView, { mode: "controlled" }> =
    draft.access.mode === "controlled" ? draft.access : { mode: "controlled", tools: [], connectors: [], knowledgeBaseIds: [], skillIds: [], secrets: [] };
  const toggle = (key: "tools" | "connectors" | "knowledgeBaseIds" | "skillIds" | "secrets", value: string) => {
    const list = controlled[key].includes(value) ? controlled[key].filter((v) => v !== value) : [...controlled[key], value];
    patch({ access: { ...controlled, [key]: list } });
  };

  return (
    <div>
      <Toolbar
        start={
          <>
            <Button variant="link" onClick={props.onCancel}>
              ← Agents
            </Button>
            <SectionTitle>{props.existing ? `Edit ${props.existing.name}` : "New agent"}</SectionTitle>
          </>
        }
        end={
          <>
            <Button onClick={props.onCancel}>Cancel</Button>
            <Button variant="primary" onClick={save} disabled={saving}>
              {saving ? "Saving…" : props.existing ? "Save" : "Create agent"}
            </Button>
          </>
        }
      />
      {error ? (
        <Notice tone="danger" className={styles.notice}>
          {error}
        </Notice>
      ) : null}

      <div className={styles.editorGrid}>
        {/* ── Identity + avatar studio ── */}
        <Section title="Look" hint="A face for your teammate. Shuffle until one feels right.">
          <div className={styles.avatarStudio}>
            <div className={styles.avatarStage}>
              <AgentAvatar avatar={draft.avatar} mood={mood} size={132} name={draft.name || "Agent avatar"} />
              <div className={styles.moodRow} role="group" aria-label="Preview a mood">
                {AVATAR_MOODS.map((m) => (
                  <button key={m} type="button" className={styles.moodChip} aria-pressed={mood === m} onClick={() => setMood(m)}>
                    {m}
                  </button>
                ))}
              </div>
              <div className={styles.stageActions}>
                <Button size="sm" onClick={shuffle}>
                  Shuffle
                </Button>
                <Button size="sm" onClick={() => fileRef.current?.click()} disabled={uploading}>
                  {uploading ? "Uploading…" : "Upload image"}
                </Button>
                <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(e) => void onUpload(e.target.files?.[0])} />
              </div>
            </div>
            <div className={styles.avatarControls}>
              <ChipGroup label="Body" value={draft.avatar.kind} options={AVATAR_KINDS.filter((k) => k !== "custom-image" || draft.avatar.imageUploadId).map((k) => ({ id: k, label: KIND_LABEL[k] }))} onChange={(kind) => patchAvatar({ kind: kind as AgentAvatarView["kind"] })} />
              <fieldset className={styles.group}>
                <legend>Colours</legend>
                <div className={styles.swatches}>
                  {AVATAR_PALETTE_IDS.map((p) => (
                    <button
                      key={p}
                      type="button"
                      className={styles.swatch}
                      style={{ background: AVATAR_PALETTES[p].body, borderColor: AVATAR_PALETTES[p].shade }}
                      aria-label={AVATAR_PALETTES[p].label}
                      aria-pressed={draft.avatar.palette === p}
                      onClick={() => patchAvatar({ palette: p })}
                    />
                  ))}
                </div>
              </fieldset>
              <ChipGroup label="Eyes" value={draft.avatar.eyes} options={AVATAR_EYES.map((e) => ({ id: e, label: e }))} onChange={(eyes) => patchAvatar({ eyes })} />
              <ChipGroup label="Mouth" value={draft.avatar.mouth} options={AVATAR_MOUTHS.map((m) => ({ id: m, label: m }))} onChange={(mouth) => patchAvatar({ mouth })} />
              <ChipGroup label="Accessory" value={draft.avatar.accessory} options={AVATAR_ACCESSORIES.map((a) => ({ id: a, label: a }))} onChange={(accessory) => patchAvatar({ accessory })} />
            </div>
          </div>
        </Section>

        <Section title="Identity">
          <Field label="Name">
            <Input value={draft.name} maxLength={60} placeholder="Research Dot" onChange={(e) => patch({ name: e.target.value })} />
          </Field>
          <Field label="What it does">
            <Input value={draft.description} maxLength={280} placeholder="Digs into questions and reports back with sources." onChange={(e) => patch({ description: e.target.value })} />
          </Field>
          <Field label="Instructions" hint="How it works, what good looks like, what to avoid. It follows these over generic style.">
            <Textarea value={draft.instructions} maxLength={8000} onChange={(e) => patch({ instructions: e.target.value })} />
          </Field>
          <Field label="Model">
            <Select value={draft.modelPreset ?? ""} onChange={(e) => patch({ modelPreset: e.target.value || undefined })}>
              <option value="">Same as chat</option>
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
              {(props.catalog?.llm ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </Select>
          </Field>
        </Section>

        <Section title="Voice" hint="Its own voice when you talk to it live.">
          <div className={styles.pair}>
            <Field label="Speech model">
              <Select value={draft.voice?.ttsModel ?? ""} onChange={(e) => setVoice({ ttsModel: e.target.value || undefined, ttsVoice: undefined })}>
                <option value="">Same as chat</option>
                {tts.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Voice">
              <Select value={draft.voice?.ttsVoice ?? ""} onChange={(e) => setVoice({ ttsVoice: e.target.value || undefined })} disabled={!voices.length}>
                <option value="">Default</option>
                {voices.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Personality">
            <Input maxLength={200} value={draft.voice?.style ?? ""} placeholder="Warm, upbeat, brief" onChange={(e) => setVoice({ style: e.target.value })} />
          </Field>
          <AgentVoiceEngineFields value={{ ...(draft.voice?.engine ? { engine: draft.voice.engine } : {}), ...(draft.voice?.realtimeVoice ? { realtimeVoice: draft.voice.realtimeVoice } : {}) }} onChange={setVoice} />
          {props.onPreviewVoice ? (
            <Row>
              <Button size="sm" onClick={() => void preview()} disabled={voiceState === "loading"} aria-live="polite">
                {voiceState === "loading" ? "Preparing…" : voiceState === "playing" ? "Playing…" : voiceState === "error" ? "Preview failed — try again" : "▶ Preview voice"}
              </Button>
            </Row>
          ) : null}
        </Section>

        <Section title="Access" hint="It can never do more than you can.">
          <RadioCards
            name={`${id}-access`}
            value={draft.access.mode}
            options={[
              { id: "inherit", title: "Everything I can use", text: "Every connector, knowledge base, skill and tool you may use here, now and as you add more." },
              { id: "controlled", title: "Controlled", text: "Pick exactly what it may use." }
            ]}
            onChange={(mode) => patch({ access: mode === "inherit" ? { mode: "inherit" } : controlled })}
          />
          {draft.access.mode === "controlled" ? (
            <div className={styles.accessPickers}>
              <CheckList title="Tools" items={(props.access?.tools ?? []).map((t) => ({ id: t.name, label: t.title, note: t.effect === "write" ? "changes things" : undefined }))} selected={controlled.tools} onToggle={(v) => toggle("tools", v)} />
              <CheckList title="Connectors" items={(props.access?.connectors ?? []).map((c) => ({ id: c.id, label: c.name, note: "all its actions" }))} selected={controlled.connectors} onToggle={(v) => toggle("connectors", v)} />
              <CheckList title="Knowledge" items={(props.access?.knowledgeBases ?? []).map((k) => ({ id: k.id, label: k.name }))} selected={controlled.knowledgeBaseIds} onToggle={(v) => toggle("knowledgeBaseIds", v)} />
              <CheckList title="Skills" items={(props.access?.skills ?? []).map((s) => ({ id: s.id, label: s.title ?? s.name }))} selected={controlled.skillIds} onToggle={(v) => toggle("skillIds", v)} />
              <CheckList title="Secrets" items={(props.access?.secrets ?? []).map((s) => ({ id: s, label: s }))} selected={controlled.secrets} onToggle={(v) => toggle("secrets", v)} />
            </div>
          ) : null}
        </Section>

        <Section title="Autonomy" hint="How it acts when something would change.">
          <RadioCards name={`${id}-autonomy`} value={draft.autonomy} options={AUTONOMY} onChange={(autonomy) => patch({ autonomy })} />
        </Section>

        <Section title="Learning" hint="Agents learn skills and facts as they work.">
          <RadioCards name={`${id}-learning`} value={draft.learning} options={LEARNING} onChange={(learning) => patch({ learning })} />
          {props.existing && props.onReviewLearning ? (
            <Row>
              <Button variant="link" onClick={props.onReviewLearning}>
                Review what it learned{props.existing.pendingProposals ? ` (${props.existing.pendingProposals} waiting)` : ""}
              </Button>
            </Row>
          ) : null}
        </Section>

        <Section title="Computer" hint="A browser in a sandbox, with a folder for files, to work on websites for you.">
          <ComputerSettings value={draft.computer} {...(props.existing ? { agentId: props.existing.id } : {})} onChange={(computer) => patch({ computer })} />
        </Section>

        <Section title="Budget" hint="It pauses cleanly at the cap. Leave empty for no extra cap.">
          <div className={styles.pair}>
            <BudgetInput id={`${id}-daily`} label="Per day (USD)" value={draft.budget?.dailyUsd} onChange={(dailyUsd) => patch({ budget: clean({ ...draft.budget, dailyUsd }) })} />
            <BudgetInput id={`${id}-monthly`} label="Per month (USD)" value={draft.budget?.monthlyUsd} onChange={(monthlyUsd) => patch({ budget: clean({ ...draft.budget, monthlyUsd }) })} />
          </div>
          {props.existing?.spend ? (
            <Muted>
              Spent today ${props.existing.spend.todayUsd.toFixed(2)} · this month ${props.existing.spend.monthUsd.toFixed(2)}
            </Muted>
          ) : null}
        </Section>

        <Section title="Who can use it">
          <RadioCards
            name={`${id}-visibility`}
            value={draft.visibility}
            options={[
              { id: "private", title: "Only me", text: "Private to you." },
              { id: "workspace", title: "Everyone in this workspace", text: props.canShare ? "Teammates can use it; it acts with your access." : "Only workspace admins can share agents.", disabled: !props.canShare }
            ]}
            onChange={(visibility) => patch({ visibility })}
          />
        </Section>

        {props.existing ? <PresenceSection agentId={props.existing.id} agentName={props.existing.name} /> : null}

        {props.existing && props.memory ? (
          <Section title="Memory" hint="What it keeps in mind about you and your team. Edit or remove anything.">
            <MemoryList items={props.memory} onSave={props.onSaveMemory} onDelete={props.onDeleteMemory} />
          </Section>
        ) : null}

        {props.existing && props.onDelete && props.existing.canEdit ? (
          <Section title="Delete">
            {confirmDelete ? (
              <Row>
                <span>Delete {props.existing.name}, its memory and the skills it learned?</span>
                <Button variant="danger" onClick={props.onDelete}>
                  Delete
                </Button>
                <Button onClick={() => setConfirmDelete(false)}>Keep</Button>
              </Row>
            ) : (
              <Row>
                <Button variant="danger" onClick={() => setConfirmDelete(true)}>
                  Delete agent…
                </Button>
              </Row>
            )}
          </Section>
        ) : null}
      </div>
    </div>
  );
}

function clean(budget: { dailyUsd?: number; monthlyUsd?: number }): AgentInput["budget"] {
  const out: NonNullable<AgentInput["budget"]> = {};
  if (budget.dailyUsd !== undefined) out.dailyUsd = budget.dailyUsd;
  if (budget.monthlyUsd !== undefined) out.monthlyUsd = budget.monthlyUsd;
  return Object.keys(out).length ? out : undefined;
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <Card aria-label={title}>
      <CardHeader title={title} {...(hint ? { meta: hint } : {})} />
      {children}
    </Card>
  );
}

function ChipGroup<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<{ id: T; label: string }>; onChange(value: T): void }) {
  return (
    <fieldset className={styles.group}>
      <legend>{label}</legend>
      <div className={styles.chips}>
        {options.map((o) => (
          <Button key={o.id} size="sm" variant={value === o.id ? "primary" : "secondary"} aria-pressed={value === o.id} onClick={() => onChange(o.id)}>
            {o.label}
          </Button>
        ))}
      </div>
    </fieldset>
  );
}

function RadioCards<T extends string>({
  name,
  value,
  options,
  onChange
}: {
  name: string;
  value: T;
  options: Array<{ id: T; title: string; text: string; disabled?: boolean }>;
  onChange(value: T): void;
}) {
  return (
    <div className={styles.radioCards} role="radiogroup">
      {options.map((o) => (
        <label key={o.id} className={[styles.radioCard, value === o.id && styles.on, o.disabled && styles.disabled].filter(Boolean).join(" ")}>
          <input type="radio" name={name} value={o.id} checked={value === o.id} disabled={o.disabled} onChange={() => onChange(o.id)} />
          <span>
            <strong>{o.title}</strong>
            <small>{o.text}</small>
          </span>
        </label>
      ))}
    </div>
  );
}

function CheckList({ title, items, selected, onToggle }: { title: string; items: Array<{ id: string; label: string; note?: string }>; selected: string[]; onToggle(id: string): void }) {
  const [query, setQuery] = useState("");
  const shown = items.filter((i) => !query || i.label.toLowerCase().includes(query.toLowerCase()));
  return (
    <fieldset className={styles.group}>
      <legend>
        {title} {selected.length ? <Muted as="span">{selected.length} selected</Muted> : null}
      </legend>
      {items.length === 0 ? (
        <Muted>Nothing here yet.</Muted>
      ) : (
        <>
          {items.length > 8 ? <Input placeholder={`Filter ${title.toLowerCase()}`} aria-label={`Filter ${title.toLowerCase()}`} value={query} onChange={(e) => setQuery(e.target.value)} /> : null}
          <div className={styles.checkItems}>
            {shown.map((item) => (
              <Checkbox
                key={item.id}
                checked={selected.includes(item.id)}
                onChange={() => onToggle(item.id)}
                label={
                  <>
                    {item.label}
                    {item.note ? <Muted as="span"> · {item.note}</Muted> : null}
                  </>
                }
              />
            ))}
          </div>
        </>
      )}
    </fieldset>
  );
}

function BudgetInput({ id, label, value, onChange }: { id: string; label: string; value: number | undefined; onChange(value: number | undefined): void }) {
  return (
    <Field label={label}>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        min={0}
        max={10000}
        step={0.5}
        placeholder="No cap"
        value={value ?? ""}
        onChange={(e) => {
          const n = Number.parseFloat(e.target.value);
          onChange(e.target.value === "" || !Number.isFinite(n) ? undefined : Math.max(0, Math.min(10000, n)));
        }}
      />
    </Field>
  );
}

function MemoryList({ items, onSave, onDelete }: { items: AgentMemoryView[]; onSave?(text: string, itemId?: string): void; onDelete?(itemId: string): void }) {
  const facts = items.filter((i) => i.kind === "fact");
  const runs = items.filter((i) => i.kind === "run").slice(0, 5);
  const [adding, setAdding] = useState("");
  const [editing, setEditing] = useState<{ id: string; text: string }>();
  return (
    <div className={styles.memoryList}>
      {facts.length === 0 ? <Muted>Nothing yet. It remembers things as it works with you.</Muted> : null}
      <ul>
        {facts.map((item) => (
          <li key={item.id} className={styles.memoryItem}>
            {editing?.id === item.id ? (
              <>
                <Input value={editing.text} maxLength={600} aria-label="Edit memory" onChange={(e) => setEditing({ id: item.id, text: e.target.value })} />
                <Button
                  size="sm"
                  onClick={() => {
                    if (editing.text.trim()) onSave?.(editing.text.trim(), item.id);
                    setEditing(undefined);
                  }}
                >
                  Save
                </Button>
              </>
            ) : (
              <>
                <span>{item.text}</span>
                <Muted as="span">{item.source === "agent" ? "learned" : "you"}</Muted>
                {onSave ? (
                  <Button variant="link" onClick={() => setEditing({ id: item.id, text: item.text })}>
                    Edit
                  </Button>
                ) : null}
                {onDelete ? (
                  <Button variant="link" onClick={() => onDelete(item.id)} aria-label={`Forget: ${item.text}`}>
                    Forget
                  </Button>
                ) : null}
              </>
            )}
          </li>
        ))}
      </ul>
      {onSave ? (
        <form
          className={`${styles.memoryItem} ${styles.memoryAdd}`}
          onSubmit={(e) => {
            e.preventDefault();
            if (adding.trim()) onSave(adding.trim());
            setAdding("");
          }}
        >
          <Input value={adding} maxLength={600} placeholder="Add something it should know" aria-label="Add a memory" onChange={(e) => setAdding(e.target.value)} />
          <Button type="submit" size="sm" disabled={!adding.trim()}>
            Add
          </Button>
        </form>
      ) : null}
      {runs.length ? (
        <details className={styles.runLog}>
          <summary>Recent work</summary>
          <ul>
            {runs.map((r) => (
              <li key={r.id}>
                <Muted as="span">{r.text}</Muted>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
