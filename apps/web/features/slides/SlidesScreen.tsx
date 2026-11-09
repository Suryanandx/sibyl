"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Icon } from "../../components/Icon";
import { SibylLoader } from "../../components/SibylLoader";
import { SlidesCard } from "../../components/SlidesCard";
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  Input,
  Notice,
  Row,
  Select,
  Spacer,
  Stack,
  Tabs,
  Textarea,
  Toolbar
} from "../../components/ui";
import { errorText, GatewayError } from "../../lib/gateway-http";
import {
  READY_EVENT,
  editorHref,
  setJobPending,
  slidesApi,
  streamingJobs,
  type DeckGroup,
  type SlidesProgressEvent,
  type SlidesSource,
  type SlidesSourceGroup,
  type SlidesSpace,
  type SlidesTemplate
} from "./api";
import styles from "./slides.module.css";

const ALL = "all";

const DEFAULT_SOURCE_GROUPS: SlidesSourceGroup[] = [
  { id: "web", label: "Web" },
  { id: "connections", label: "Your connections" }
];

/**
 * The Slides library: decks Sibyl built, grouped into spaces, and a composer
 * for new ones. The open space is in the address (?space=<id>), so refresh,
 * shared links and Back/Forward land on the same space.
 */
export function SlidesScreen({ canManage }: { canManage: boolean }) {
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const params = useSearchParams();
  const selected = params?.get("space") ?? ALL;
  const select = useCallback(
    (space: string) => router.push(space === ALL ? pathname : `${pathname}?space=${encodeURIComponent(space)}`),
    [router, pathname]
  );

  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState<string>();
  const [spaces, setSpaces] = useState<SlidesSpace[]>([]);
  const [decks, setDecks] = useState<DeckGroup[] | null>(null);
  const [sources, setSources] = useState<SlidesSource[]>([]);
  const [sourceGroups, setSourceGroups] = useState<SlidesSourceGroup[]>(DEFAULT_SOURCE_GROUPS);
  const [templates, setTemplates] = useState<SlidesTemplate[]>([{ id: "general", name: "General" }]);
  const [composerOpen, setComposerOpen] = useState(false);
  const [newSpaceName, setNewSpaceName] = useState<string | null>(null);
  const [editingSpace, setEditingSpace] = useState<SlidesSpace | null>(null);

  const fail = useCallback((cause: unknown) => setError(errorText(cause)), []);

  const loadSpaces = useCallback(async () => {
    try {
      setSpaces(await slidesApi.spaces());
    } catch (cause) {
      fail(cause);
    }
  }, [fail]);

  const loadDecks = useCallback(async () => {
    try {
      setDecks(await slidesApi.decks(selected === ALL ? undefined : selected));
    } catch (cause) {
      // 503: the slides engine is down; the notice above says so.
      if (cause instanceof GatewayError && cause.status === 503) setDecks([]);
      else fail(cause);
    }
  }, [selected, fail]);

  useEffect(() => {
    void (async () => {
      try {
        const status = await slidesApi.status();
        setEnabled(status.enabled);
        const [sourceData] = await Promise.all([slidesApi.sources(), loadSpaces()]);
        setSources(sourceData.sources);
        if (sourceData.groups?.length) setSourceGroups(sourceData.groups);
        if (status.enabled) {
          const list = await slidesApi.templates().catch(() => undefined);
          if (list?.length) setTemplates(list);
        }
      } catch (cause) {
        fail(cause);
      }
    })();
  }, [loadSpaces, fail]);

  useEffect(() => {
    if (enabled) void loadDecks();
  }, [enabled, loadDecks]);

  // A build finished while its composer was gone (the "Deck ready" notification): show it.
  useEffect(() => {
    const reload = () => {
      void loadDecks();
      void loadSpaces();
    };
    window.addEventListener(READY_EVENT, reload);
    return () => window.removeEventListener(READY_EVENT, reload);
  }, [loadDecks, loadSpaces]);

  const current = spaces.find((space) => space.id === selected);

  async function act(action: () => Promise<void>): Promise<void> {
    setError(undefined);
    try {
      await action();
    } catch (cause) {
      fail(cause);
    }
  }

  const createSpace = (name: string) =>
    act(async () => {
      if (!name.trim()) return;
      const space = await slidesApi.createSpace(name.trim());
      setNewSpaceName(null);
      await loadSpaces();
      select(space.id);
    });

  const saveSpace = (space: SlidesSpace) =>
    act(async () => {
      await slidesApi.updateSpace(space);
      setEditingSpace(null);
      await loadSpaces();
    });

  const deleteSpace = (space: SlidesSpace) =>
    act(async () => {
      if (!window.confirm(`Delete the space "${space.name}"? Its decks stay in All decks.`)) return;
      await slidesApi.deleteSpace(space.id);
      setEditingSpace(null);
      select(ALL);
      await loadSpaces();
    });

  const spaceTabs = [{ value: ALL, label: "All decks" }, ...spaces.map((space) => ({ value: space.id, label: <SpaceLabel space={space} /> }))];

  return (
    <>
      <Toolbar
        start={
          <>
            <Tabs label="Spaces" options={spaceTabs} value={current ? selected : ALL} onChange={select} />
            {canManage && newSpaceName === null ? (
              <Button variant="ghost" size="sm" onClick={() => setNewSpaceName("")}>
                <Icon name="plus" size={14} />
                New space
              </Button>
            ) : null}
            {newSpaceName !== null ? (
              <form
                className={styles.spaceForm}
                onSubmit={(event) => {
                  event.preventDefault();
                  void createSpace(newSpaceName);
                }}
              >
                <Input
                  autoFocus
                  value={newSpaceName}
                  onChange={(event) => setNewSpaceName(event.target.value)}
                  onKeyDown={(event) => event.key === "Escape" && setNewSpaceName(null)}
                  placeholder="Space name"
                  aria-label="Space name"
                  maxLength={80}
                />
                <Button type="submit" size="sm" disabled={!newSpaceName.trim()}>
                  Add
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setNewSpaceName(null)}>
                  Cancel
                </Button>
              </form>
            ) : null}
          </>
        }
        end={
          canManage ? (
            <>
              {current ? (
                <Button variant="ghost" onClick={() => setEditingSpace({ ...current })}>
                  Space settings
                </Button>
              ) : null}
              <Button variant="primary" disabled={!enabled} onClick={() => setComposerOpen((open) => !open)}>
                <Icon name="plus" size={15} />
                New deck
              </Button>
            </>
          ) : null
        }
      />

      <Stack>
        {current?.instructions ? <p className={styles.hint}>{current.instructions}</p> : null}
        {error ? <Notice tone="danger">{error}</Notice> : null}
        {enabled === false ? (
          <Notice tone="warning">
            Sibyl Slides is not running. Start the slides service (or set <code>SIBYL_SLIDES_URL</code> on the gateway) and reload.
          </Notice>
        ) : null}

        {editingSpace ? (
          <SpaceSettings
            space={editingSpace}
            templates={templates}
            onChange={setEditingSpace}
            onSave={() => void saveSpace(editingSpace)}
            onDelete={() => void deleteSpace(editingSpace)}
            onCancel={() => setEditingSpace(null)}
          />
        ) : null}

        {composerOpen && enabled && canManage ? (
          <DeckComposer
            sources={sources}
            groups={sourceGroups}
            templates={templates}
            space={current}
            onClose={() => setComposerOpen(false)}
            onFinished={() => {
              void loadDecks();
              void loadSpaces();
            }}
          />
        ) : null}

        {enabled && decks?.length === 0 && !composerOpen ? (
          <EmptyState
            icon={<SibylLoader state="idle" size={40} />}
            title={current ? `No decks in ${current.name} yet` : "No decks yet"}
            action={
              canManage ? (
                <Button variant="primary" onClick={() => setComposerOpen(true)}>
                  New deck
                </Button>
              ) : null
            }
          >
            <p>Ask Sibyl in chat (&ldquo;make a deck about…&rdquo;){canManage ? " or start one here" : ""}.</p>
          </EmptyState>
        ) : null}

        {decks?.length ? (
          <div className={styles.grid}>
            {decks.map((deck) => (
              <DeckTile key={deck.id} deck={deck} />
            ))}
          </div>
        ) : null}
      </Stack>
    </>
  );
}

function SpaceLabel({ space }: { space: SlidesSpace }) {
  return (
    <>
      {space.name}
      <span className={styles.count}>{space.deckCount}</span>
    </>
  );
}

function DeckTile({ deck }: { deck: DeckGroup }) {
  const [version, setVersion] = useState(deck.latest.id);
  const shown = deck.versions.find((candidate) => candidate.id === version) ?? deck.latest;
  return (
    <div className={styles.tile}>
      <SlidesCard artifact={shown} compact />
      {deck.versions.length > 1 ? (
        <Tabs
          label="Versions"
          className={styles.versions}
          value={shown.id}
          onChange={setVersion}
          options={deck.versions.map((candidate) => ({ value: candidate.id, label: `v${candidate.version}` }))}
        />
      ) : null}
    </div>
  );
}

function SpaceSettings(props: {
  space: SlidesSpace;
  templates: SlidesTemplate[];
  onChange(space: SlidesSpace): void;
  onSave(): void;
  onDelete(): void;
  onCancel(): void;
}) {
  const { space, templates, onChange } = props;
  return (
    <Card
      as="form"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSave();
      }}
    >
      <CardHeader title="Space settings" />
      <Field label="Name">
        <Input value={space.name} maxLength={80} onChange={(event) => onChange({ ...space, name: event.target.value })} />
      </Field>
      <Field label="Instructions for every deck" hint="Audience, tone, length.">
        <Textarea rows={3} value={space.instructions ?? ""} onChange={(event) => onChange({ ...space, instructions: event.target.value })} />
      </Field>
      <Field label="Default template">
        <Select value={space.template ?? ""} onChange={(event) => onChange({ ...space, template: event.target.value })}>
          <option value="">Engine default</option>
          {templates.map((template) => (
            <option key={template.id} value={template.id}>
              {template.name}
            </option>
          ))}
        </Select>
      </Field>
      <Row>
        <Button variant="danger" onClick={props.onDelete}>
          Delete space
        </Button>
        <Spacer />
        <Button variant="ghost" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={!space.name.trim()}>
          Save
        </Button>
      </Row>
    </Card>
  );
}

type Progress = {
  step: "starting" | "researching" | "outlining" | "generating" | "done" | "error";
  tools: Array<{ callId: string; title: string; status: string }>;
  message?: string;
};

const STEP_LABEL: Record<Progress["step"], string> = {
  starting: "Starting…",
  researching: "Gathering data from your sources…",
  outlining: "Outlining the deck…",
  generating: "Building the slides…",
  done: "Deck ready",
  error: "Something went wrong"
};

function DeckComposer({
  sources,
  groups,
  templates,
  space,
  onClose,
  onFinished
}: {
  sources: SlidesSource[];
  groups: SlidesSourceGroup[];
  templates: SlidesTemplate[];
  space?: SlidesSpace;
  onClose(): void;
  onFinished(): void;
}) {
  const [prompt, setPrompt] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [template, setTemplate] = useState("");
  const [nSlides, setNSlides] = useState(8);
  const [progress, setProgress] = useState<Progress | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const jobRef = useRef<string | null>(null);
  const running = progress !== null && progress.step !== "done" && progress.step !== "error";

  // Closing the composer only drops the progress stream: the build keeps
  // going on the gateway and a "Deck ready" notification offers it when it is done.
  useEffect(
    () => () => {
      const leaving = jobRef.current;
      controllerRef.current?.abort();
      if (leaving) {
        streamingJobs.delete(leaving);
        setJobPending(leaving, true);
      }
    },
    []
  );

  const grouped = useMemo(
    () =>
      groups
        .map((group) => ({ ...group, sources: sources.filter((source) => (source.group ?? (source.kind === "mcp" ? "connections" : "web")) === group.id) }))
        .filter((group) => group.sources.length > 0),
    [groups, sources]
  );

  function forget(job: string | null): void {
    if (!job) return;
    streamingJobs.delete(job);
    setJobPending(job, false);
  }

  async function stop(): Promise<void> {
    const job = jobRef.current;
    jobRef.current = null;
    forget(job);
    if (job) await slidesApi.cancelJob(job);
    controllerRef.current?.abort();
  }

  function toggle(id: string): void {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function run(): Promise<void> {
    if (!prompt.trim() || running) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setProgress({ step: "starting", tools: [] });
    const apply = (event: SlidesProgressEvent): void => {
      if (event.type === "job") {
        jobRef.current = event.id;
        streamingJobs.add(event.id);
        setJobPending(event.id, true);
        return;
      }
      if (event.type === "done" || event.type === "error") {
        forget(jobRef.current);
        jobRef.current = null;
      }
      setProgress((current) => {
        const base = current ?? { step: "starting" as const, tools: [] };
        if (event.type === "step") return { ...base, step: event.step };
        if (event.type === "tool") {
          const others = base.tools.filter((tool) => tool.callId !== event.callId);
          return { ...base, tools: [...others, { callId: event.callId, title: event.title, status: event.status }] };
        }
        if (event.type === "done") return { ...base, step: "done" };
        return { ...base, step: "error", message: event.message };
      });
      if (event.type === "done") {
        onFinished();
        // Straight into the editor (the library shows the deck when you come back).
        const href = editorHref(event.artifact, space?.id);
        if (href) window.location.assign(href);
      }
    };
    try {
      await slidesApi.generate(
        { prompt: prompt.trim(), sources: [...picked], nSlides, ...(space ? { spaceId: space.id } : {}), ...(template ? { template } : {}) },
        apply,
        controller.signal
      );
      setProgress((current) =>
        current && current.step !== "done" && current.step !== "error" ? { ...current, step: "error", message: "The connection closed early." } : current
      );
    } catch (cause) {
      if (controller.signal.aborted) {
        setProgress(null);
        return;
      }
      setProgress((current) => ({ tools: current?.tools ?? [], step: "error", message: errorText(cause) }));
    }
  }

  return (
    <Card
      as="form"
      onSubmit={(event) => {
        event.preventDefault();
        void run();
      }}
    >
      <CardHeader title={`New deck${space ? ` in ${space.name}` : ""}`} />
      <Field label="What should the deck show?">
        <Textarea
          rows={4}
          value={prompt}
          placeholder="e.g. Our Q3 pipeline vs. Q2 for the board, with the top 5 deals and risks"
          onChange={(event) => setPrompt(event.target.value)}
          disabled={running}
        />
      </Field>

      {grouped.length ? (
        <fieldset className={styles.sources} disabled={running}>
          <legend className={styles.legend}>Get data from</legend>
          {grouped.map((group) => (
            <div key={group.id} className={styles.sourceRow} role="group" aria-label={group.label}>
              <span className={styles.sourceGroup}>{group.label}</span>
              {group.sources.map((source) => (
                <label key={source.id} className={styles.sourceChip} title={source.description}>
                  <input type="checkbox" checked={picked.has(source.id)} onChange={() => toggle(source.id)} />
                  <span>{source.label}</span>
                </label>
              ))}
            </div>
          ))}
        </fieldset>
      ) : null}

      <div className={styles.options}>
        <Field label="Template">
          <Select value={template} onChange={(event) => setTemplate(event.target.value)} disabled={running}>
            <option value="">{space?.template ? `Space default (${space.template})` : "Default"}</option>
            {templates.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Slides">
          <Input
            type="number"
            min={1}
            max={40}
            value={nSlides}
            onChange={(event) => setNSlides(Math.max(1, Math.min(40, Number(event.target.value) || 8)))}
            disabled={running}
          />
        </Field>
      </div>

      {progress ? (
        <div className={styles.progress} role="status" aria-live="polite">
          <div className={styles.progressHead}>
            <SibylLoader state={running ? "working" : "idle"} size={22} />
            <span>{STEP_LABEL[progress.step]}</span>
          </div>
          {progress.tools.length ? (
            <ul className={styles.progressTools}>
              {progress.tools.map((tool) => (
                <li key={tool.callId} data-status={tool.status}>
                  {tool.status === "running" ? <SibylLoader state="working" size={14} /> : <Icon name={tool.status === "ok" ? "check" : "close"} size={14} />}
                  {tool.title}
                </li>
              ))}
            </ul>
          ) : null}
          {progress.message ? <Notice tone="danger">{progress.message}</Notice> : null}
        </div>
      ) : null}

      <Row>
        <Spacer />
        {running ? (
          <Button variant="ghost" onClick={() => void stop()}>
            Stop
          </Button>
        ) : (
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        )}
        <Button type="submit" variant="primary" disabled={!prompt.trim() || running}>
          {picked.size ? "Research & build" : "Build deck"}
        </Button>
      </Row>
    </Card>
  );
}
