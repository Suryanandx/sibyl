"use client";

/**
 * Media in the chat composer:
 *  - the Create mode (Chat | Image | Video | Audio) with the model + settings
 *    popover built from the selected model's parameters;
 *  - the @ picker: agents, this chat's images/videos/audio, files, knowledge;
 *  - picked media as reference chips ("@image1"), each a reference, first
 *    frame or last frame;
 *  - what a message carries when it is sent (useChatMedia().prepare).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AgentView, AttachmentRef, KnowledgeDocView, MediaCreateSpec, MediaItemView, MediaKind, MediaModelsResponse, MediaOutputView, MediaReferenceInput } from "@open-gpt-live/protocol";
import { Icon, type IconName } from "../../components/Icon";
import { gatewayRequest } from "../../lib/gateway-http";
import { KIND_LABEL, listMedia, mediaTypeOf, preferredModel, settingsFor, takeChatIntent, CHAT_INTENT_EVENT } from "./api";
import { useFileUrl, useMediaModels } from "./hooks";
import { MediaSettings, useEstimate, type MediaChoice } from "./MediaSettings";
import styles from "./media.module.css";

export type ComposerMode = "chat" | MediaKind;

const MODES: Array<{ id: ComposerMode; label: string; hint: string; icon: IconName }> = [
  { id: "chat", label: "Chat", hint: "Ask Sibyl anything", icon: "chat" },
  { id: "image", label: "Image", hint: "Make pictures from a prompt", icon: "sparkle" },
  { id: "video", label: "Video", hint: "Make a short clip", icon: "video" },
  { id: "audio", label: "Audio", hint: "Voice-over or music", icon: "volume" }
];

/* ───────────── mention items ───────────── */

export interface MentionItem {
  key: string;
  section: "Agents" | "Media in this chat" | "Recent media" | "Files" | "Knowledge";
  label: string;
  hint?: string;
  agent?: AgentView;
  uploadId?: string;
  mime?: string;
}

/** A picked file: media become references, other files attachments. */
export interface PickedRef {
  uploadId: string;
  name: string;
  mime: string;
  /** "@image1" — how the prompt names it. */
  token: string;
  role: "reference" | "first_frame" | "last_frame";
}

function isMedia(mime: string): boolean {
  return /^(image|video|audio)\//.test(mime);
}

function nextToken(refs: PickedRef[], mime: string, name: string): string {
  if (!isMedia(mime)) return `@${name.replace(/\.[^.]+$/, "").replace(/[^\w-]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "file"}`;
  const type = mediaTypeOf(mime);
  const used = new Set(refs.map((ref) => ref.token));
  let n = refs.filter((ref) => isMedia(ref.mime) && mediaTypeOf(ref.mime) === type).length + 1;
  while (used.has(`@${type}${n}`)) n += 1;
  return `@${type}${n}`;
}

/* ───────────── the hook ChatScreen uses ───────────── */

export interface ChatMedia {
  mode: ComposerMode;
  setMode(mode: ComposerMode): void;
  models: MediaModelsResponse | null;
  choice: MediaChoice | undefined;
  refs: PickedRef[];
  /** Pick from the @ picker (returns the text to insert, or the agent prefix). */
  pick(item: MentionItem): { insert: string; agentPrefix?: string };
  addReference(output: MediaOutputView, item: MediaItemView): string;
  removeRef(uploadId: string): void;
  mentionItems(query: string): MentionItem[];
  loadMentions(): void;
  /** Composer pieces. */
  controls: ReactNode;
  tray: ReactNode;
  placeholder: string | undefined;
  /** What the next message carries; clears the references. */
  prepare(uploaded?: AttachmentRef[]): { attachments: AttachmentRef[]; media?: MediaCreateSpec };
  /** Media of the open conversation by reply request id (cards after a reload). */
  byRequest: Map<string, MediaItemView[]>;
  /** Same prompt, model and settings again (Create mode message). */
  regenerateSpec(item: MediaItemView): MediaCreateSpec;
  /** Prefill the composer: the item's prompt, model, settings and references (to change before sending). */
  remix(item: MediaItemView): void;
}

export function useChatMedia(input: {
  conversationId: string | null;
  agents: AgentView[];
  chatFiles: AttachmentRef[];
  enabled: boolean;
  refreshKey?: unknown;
  /** Put text in the composer (remix, "use in chat"). */
  setInput: (update: (current: string) => string) => void;
}): ChatMedia {
  const [mode, setModeState] = useState<ComposerMode>("chat");
  const { models } = useMediaModels(input.enabled);
  const [choices, setChoices] = useState<Partial<Record<MediaKind, MediaChoice>>>({});
  const [refs, setRefs] = useState<PickedRef[]>([]);
  const [conversationMedia, setConversationMedia] = useState<MediaItemView[]>([]);
  const [recent, setRecent] = useState<MediaItemView[]>([]);
  const [knowledge, setKnowledge] = useState<Array<{ uploadId: string; title: string; mime: string; base: string }>>([]);
  const loaded = useRef(false);

  const choice = mode === "chat" ? undefined : choices[mode] ?? defaultChoice(mode, models);

  const remix = useCallback(
    (item: MediaItemView) => {
      setModeState(item.kind);
      const model = models?.models.find((m) => m.id === item.model);
      if (model) setChoices((current) => ({ ...current, [item.kind]: { model, settings: { ...settingsFor(model), ...item.settings } } }));
      setRefs(
        item.references.map((ref, index) => ({
          uploadId: ref.uploadId,
          name: ref.name ?? ref.uploadId,
          mime: ref.mime ?? "image/png",
          token: ref.token ?? `@${(ref.mime ?? "image/").split("/")[0]}${index + 1}`,
          role: ref.role ?? "reference"
        }))
      );
      input.setInput(() => item.prompt);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [models]
  );

  // A hand-off from Spaces → Media (Create / Use in chat / Remix in chat), once the models are known.
  // The chat screen may already be open (it stays mounted): the hand-off also arrives as an event.
  const setInput = input.setInput;
  const takeIntent = useCallback(() => {
    if (!models) return;
    const intent = takeChatIntent();
    if (!intent) return;
    if (intent.action === "create") setModeState(intent.kind);
    else if (intent.action === "remix") remix(intent.item);
    else {
      const output = intent.item.outputs[0];
      if (!output) return;
      const token = nextToken([], output.mime, intent.item.prompt);
      setRefs([{ uploadId: output.uploadId, name: intent.item.prompt.slice(0, 60), mime: output.mime, token, role: "reference" }]);
      setInput((current) => `${current}${current ? " " : ""}${token} `);
    }
  }, [models, remix, setInput]);
  useEffect(() => {
    takeIntent();
    window.addEventListener(CHAT_INTENT_EVENT, takeIntent);
    return () => window.removeEventListener(CHAT_INTENT_EVENT, takeIntent);
  }, [takeIntent]);

  // Media of this conversation (cards for replies after a reload, the picker).
  useEffect(() => {
    if (!input.enabled || !input.conversationId) {
      setConversationMedia([]);
      return;
    }
    const controller = new AbortController();
    void listMedia({ conversationId: input.conversationId }, controller.signal)
      .then(setConversationMedia)
      .catch(() => undefined);
    return () => controller.abort();
  }, [input.conversationId, input.enabled, input.refreshKey]);

  const loadMentions = useCallback(() => {
    if (loaded.current || !input.enabled) return;
    loaded.current = true;
    void listMedia({})
      .then((items) => setRecent(items.slice(0, 12)))
      .catch(() => undefined);
    void loadKnowledgeFiles().then(setKnowledge).catch(() => undefined);
  }, [input.enabled]);

  const byRequest = useMemo(() => {
    const map = new Map<string, MediaItemView[]>();
    for (const item of conversationMedia) if (item.requestId) map.set(item.requestId, [...(map.get(item.requestId) ?? []), item]);
    return map;
  }, [conversationMedia]);

  const mentionItems = useCallback(
    (query: string): MentionItem[] => {
      const needle = query.toLowerCase();
      const match = (text: string) => !needle || text.toLowerCase().includes(needle);
      const items: MentionItem[] = [];
      for (const agent of input.agents) if (match(agent.name)) items.push({ key: `agent:${agent.id}`, section: "Agents", label: agent.name, hint: "answers this message", agent });
      const seen = new Set<string>();
      const fromMedia = (section: MentionItem["section"], list: MediaItemView[]) => {
        for (const item of list) {
          for (const output of item.outputs) {
            if (seen.has(output.uploadId) || !match(item.prompt)) continue;
            seen.add(output.uploadId);
            items.push({ key: `media:${output.uploadId}`, section, label: item.prompt, hint: KIND_LABEL[item.kind], uploadId: output.uploadId, mime: output.mime });
          }
        }
      };
      fromMedia("Media in this chat", conversationMedia);
      for (const file of input.chatFiles) {
        if (seen.has(file.id) || !match(file.name)) continue;
        seen.add(file.id);
        items.push({ key: `file:${file.id}`, section: "Files", label: file.name, hint: isMedia(file.mime) ? KIND_LABEL[mediaTypeOf(file.mime)] : "File", uploadId: file.id, mime: file.mime });
      }
      fromMedia("Recent media", recent);
      for (const doc of knowledge) {
        if (seen.has(doc.uploadId) || !match(doc.title)) continue;
        seen.add(doc.uploadId);
        items.push({ key: `kn:${doc.uploadId}`, section: "Knowledge", label: doc.title, hint: doc.base, uploadId: doc.uploadId, mime: doc.mime });
      }
      return items.slice(0, 40);
    },
    [input.agents, input.chatFiles, conversationMedia, recent, knowledge]
  );

  const addRef = useCallback((uploadId: string, name: string, mime: string): string => {
    const existing = refs.find((ref) => ref.uploadId === uploadId);
    if (existing) return existing.token;
    const token = nextToken(refs, mime, name);
    setRefs((current) => (current.some((ref) => ref.uploadId === uploadId) ? current : [...current, { uploadId, name, mime, token, role: "reference" }]));
    return token;
  }, [refs]);

  const pick = useCallback(
    (item: MentionItem) => {
      if (item.agent) return { insert: "", agentPrefix: `@${item.agent.name} ` };
      if (!item.uploadId || !item.mime) return { insert: "" };
      return { insert: `${addRef(item.uploadId, item.label, item.mime)} ` };
    },
    [addRef]
  );

  const setMode = useCallback((next: ComposerMode) => setModeState(next), []);

  const promptForEstimate = "";
  const estimate = useEstimate((mode === "chat" ? "image" : mode) as MediaKind, choice, promptForEstimate, refs.filter((ref) => isMedia(ref.mime)).map(toReference));

  const controls = (
    <>
      <ModeMenu mode={mode} onChange={setMode} />
      {mode !== "chat" && models && choice ? (
        <CreatePopover
          kind={mode}
          models={models}
          choice={choice}
          estimateUsd={estimate?.usd}
          references={refs.filter((ref) => isMedia(ref.mime)).map(toReference)}
          onChange={(next) => setChoices((current) => ({ ...current, [mode]: next }))}
        />
      ) : mode !== "chat" ? (
        <span className={styles.modelNote}>Loading models…</span>
      ) : null}
    </>
  );

  const tray = refs.length ? (
    <div className={styles.refs} aria-label="References">
      {refs.map((ref) => (
        <RefChip
          key={ref.uploadId}
          picked={ref}
          frames={mode === "video" ? (choice?.model.references.frames ?? []) : []}
          onRole={(role) => setRefs((current) => current.map((item) => (item.uploadId === ref.uploadId ? { ...item, role } : item)))}
          onRemove={() => setRefs((current) => current.filter((item) => item.uploadId !== ref.uploadId))}
        />
      ))}
    </div>
  ) : null;

  return {
    mode,
    setMode,
    models,
    choice,
    refs,
    pick,
    addReference: (output, item) => addRef(output.uploadId, item.prompt.slice(0, 60), output.mime),
    removeRef: (uploadId) => setRefs((current) => current.filter((ref) => ref.uploadId !== uploadId)),
    mentionItems,
    loadMentions,
    controls,
    tray,
    placeholder: mode === "image" ? "Describe the image… (@ to add a reference)" : mode === "video" ? "Describe the shot… (@ to add a reference)" : mode === "audio" ? (choice?.model.audioKind === "music" ? "Describe the music…" : "Type what the voice should say…") : undefined,
    prepare: (uploaded = []) => {
      const picked = [...refs];
      // Files attached with the paperclip in Create mode are references too (after the picked ones).
      for (const file of uploaded) {
        if (mode !== "chat" && isMedia(file.mime) && !picked.some((ref) => ref.uploadId === file.id)) {
          picked.push({ uploadId: file.id, name: file.name, mime: file.mime, token: nextToken(picked, file.mime, file.name), role: "reference" });
        }
      }
      setRefs([]);
      if (mode !== "chat" && choice) {
        return {
          attachments: picked.map(toAttachment),
          media: { kind: mode, model: choice.model.id, settings: choice.settings, references: picked.filter((ref) => isMedia(ref.mime)).map(toReference) }
        };
      }
      return { attachments: picked.map(toAttachment) };
    },
    byRequest,
    remix,
    regenerateSpec: (item) => ({ kind: item.kind, model: item.model, settings: item.settings, references: item.references.map(({ uploadId, role, token }) => ({ uploadId, ...(role ? { role } : {}), ...(token ? { token } : {}) })) })
  };
}

function toReference(ref: PickedRef): MediaReferenceInput {
  return { uploadId: ref.uploadId, role: ref.role, token: ref.token };
}

function toAttachment(ref: PickedRef): AttachmentRef {
  return { id: ref.uploadId, name: ref.name, mime: ref.mime };
}

function defaultChoice(kind: MediaKind, models: MediaModelsResponse | null): MediaChoice | undefined {
  if (!models) return undefined;
  const model = preferredModel(kind, models);
  return model ? { model, settings: settingsFor(model) } : undefined;
}

async function loadKnowledgeFiles(): Promise<Array<{ uploadId: string; title: string; mime: string; base: string }>> {
  const { bases } = await gatewayRequest<{ bases: Array<{ id: string; name: string }> }>("/api/knowledge");
  const files: Array<{ uploadId: string; title: string; mime: string; base: string }> = [];
  for (const base of bases.slice(0, 5)) {
    const { docs } = await gatewayRequest<{ docs: KnowledgeDocView[] }>(`/api/knowledge/${encodeURIComponent(base.id)}`);
    for (const doc of docs) {
      if (doc.source.kind === "upload") files.push({ uploadId: doc.source.uploadId, title: doc.title, mime: doc.mime ?? "application/octet-stream", base: base.name });
    }
  }
  return files.slice(0, 60);
}

/* ───────────── pieces ───────────── */

function usePopover(): { open: boolean; setOpen: (open: boolean | ((v: boolean) => boolean)) => void; ref: React.MutableRefObject<HTMLDivElement | null> } {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", escape);
    };
  }, [open]);
  return { open, setOpen, ref };
}

/** Chat | Image | Video | Audio. */
export function ModeMenu({ mode, onChange }: { mode: ComposerMode; onChange: (mode: ComposerMode) => void }) {
  const { open, setOpen, ref } = usePopover();
  const current = MODES.find((m) => m.id === mode)!;
  return (
    <div className={styles.modeMenu} ref={ref}>
      <button
        type="button"
        className={`${styles.modePill}${mode !== "chat" ? ` ${styles.modePillOn}` : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Mode: ${current.label}`}
        title="Chat, or create an image, video or audio"
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name={current.icon} size={14} />
        <span>{current.label}</span>
        <Icon name="chevronDown" size={12} />
      </button>
      {open ? (
        <div className={`${styles.popover} ${styles.modeList}`} role="menu">
          {MODES.map((option) => (
            <button
              key={option.id}
              type="button"
              role="menuitemradio"
              aria-checked={option.id === mode}
              className={styles.modeItem}
              onClick={() => {
                onChange(option.id);
                setOpen(false);
              }}
            >
              <Icon name={option.icon} size={16} />
              <span>
                {option.label}
                <small>{option.hint}</small>
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** The model + settings popover of Create mode, its pill showing the model and the price. */
function CreatePopover(props: { kind: MediaKind; models: MediaModelsResponse; choice: MediaChoice; estimateUsd?: number; references: MediaReferenceInput[]; onChange: (choice: MediaChoice) => void }) {
  const { open, setOpen, ref } = usePopover();
  const short = props.choice.model.name.replace(/^[^:]+:\s*/, "");
  return (
    <div className={styles.createMenu} ref={ref}>
      <button
        type="button"
        className={styles.modePill}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`${props.choice.model.name} — ${props.choice.model.priceLabel}`}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="sliders" size={14} />
        <span>
          {short}
          {props.estimateUsd !== undefined ? ` · ≈$${props.estimateUsd < 0.01 ? props.estimateUsd.toFixed(3) : props.estimateUsd.toFixed(2)}` : ""}
        </span>
      </button>
      {open ? (
        <div className={styles.popover} role="dialog" aria-label={`${KIND_LABEL[props.kind]} settings`}>
          <MediaSettings kind={props.kind} models={props.models} choice={props.choice} onChange={props.onChange} references={props.references} />
        </div>
      ) : null}
    </div>
  );
}

function RefChip(props: { picked: PickedRef; frames: Array<"first_frame" | "last_frame">; onRole: (role: PickedRef["role"]) => void; onRemove: () => void }) {
  const { picked } = props;
  const url = useFileUrl(picked.mime.startsWith("image/") ? picked.uploadId : undefined);
  return (
    <span className={styles.ref} title={picked.name}>
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="" width={18} height={18} style={{ borderRadius: 4, objectFit: "cover" }} />
      ) : null}
      <strong>{picked.token}</strong>
      <span className={styles.refName}>{picked.name}</span>
      {props.frames.length && picked.mime.startsWith("image/") ? (
        <select aria-label={`Use ${picked.token} as`} value={picked.role} onChange={(event) => props.onRole(event.target.value as PickedRef["role"])}>
          <option value="reference">reference</option>
          {props.frames.includes("first_frame") ? <option value="first_frame">first frame</option> : null}
          {props.frames.includes("last_frame") ? <option value="last_frame">last frame</option> : null}
        </select>
      ) : null}
      <button type="button" className={styles.refRemove} aria-label={`Remove ${picked.token}`} onClick={props.onRemove}>
        <Icon name="close" size={12} />
      </button>
    </span>
  );
}

/** The @ picker above the composer, in sections. */
export function MentionPicker(props: { items: MentionItem[]; active: number; onPick: (item: MentionItem) => void; onHover: (index: number) => void }) {
  let section = "";
  return (
    <div className={styles.picker} role="listbox" aria-label="Mention an agent or reference a file">
      {props.items.length === 0 ? <p className={styles.pickerEmpty}>Nothing matches. Agents, media and files of this chat appear here.</p> : null}
      {props.items.map((item, index) => {
        const head = item.section !== section ? item.section : null;
        section = item.section;
        return (
          <div key={item.key}>
            {head ? <p className={styles.pickerSection}>{head}</p> : null}
            <button
              type="button"
              role="option"
              aria-selected={index === props.active}
              className={styles.pickerItem}
              onMouseEnter={() => props.onHover(index)}
              onMouseDown={(event) => {
                event.preventDefault();
                props.onPick(item);
              }}
            >
              <PickerThumb item={item} />
              <span className={styles.pickerLabel}>{item.label}</span>
              {item.hint ? <span className={styles.pickerHint}>{item.hint}</span> : null}
            </button>
          </div>
        );
      })}
    </div>
  );
}

function PickerThumb({ item }: { item: MentionItem }) {
  const url = useFileUrl(item.mime?.startsWith("image/") ? item.uploadId : undefined);
  return (
    <span className={styles.pickerThumb} aria-hidden>
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="" />
      ) : (
        <Icon name={item.agent ? "sparkle" : item.mime?.startsWith("video/") ? "video" : item.mime?.startsWith("audio/") ? "volume" : "notes"} size={14} />
      )}
    </span>
  );
}
