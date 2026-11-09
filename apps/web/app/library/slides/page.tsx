"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ToolArtifactView } from "@open-gpt-live/protocol";
import { AppRail } from "../../../components/AppRail";
import { Icon } from "../../../components/Icon";
import { SibylLoader } from "../../../components/SibylLoader";
import { SlidesApiError, slidesApi, streamGenerate, type SlidesProgressEvent } from "../../../components/SlidesApi";
import { SlidesCard } from "../../../components/SlidesCard";

interface Space {
  id: string;
  name: string;
  instructions?: string;
  template?: string;
  deckCount: number;
}

interface DeckGroup {
  id: string;
  title: string;
  spaceId?: string;
  latest: ToolArtifactView;
  versions: ToolArtifactView[];
  updatedAt: number;
}

interface Source {
  id: string;
  label: string;
  kind: "tool" | "mcp";
  description?: string;
  tools: string[];
}

interface Template {
  id: string;
  name: string;
  description?: string;
}

type Progress = {
  step: "starting" | "researching" | "outlining" | "generating" | "done" | "error";
  tools: Array<{ callId: string; title: string; status: string }>;
  message?: string;
  artifact?: ToolArtifactView;
};

const ALL = "all";

export default function SlidesLibraryPage() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [authError, setAuthError] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [selected, setSelected] = useState<string>(ALL);

  // The address names the open space (/library/slides?space=<id>), so
  // refresh, shared links and Back/Forward land on the same space.
  useEffect(() => {
    const fromUrl = () => new URLSearchParams(window.location.search).get("space") ?? ALL;
    setSelected(fromUrl());
    const onPop = () => setSelected(fromUrl());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  useEffect(() => {
    const current = new URLSearchParams(window.location.search).get("space") ?? ALL;
    if (current === selected) return;
    window.history.pushState(null, "", selected === ALL ? "/library/slides" : `/library/slides?space=${encodeURIComponent(selected)}`);
  }, [selected]);
  const [decks, setDecks] = useState<DeckGroup[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [templates, setTemplates] = useState<Template[]>([{ id: "general", name: "General" }]);
  const [composerOpen, setComposerOpen] = useState(false);
  const [newSpaceName, setNewSpaceName] = useState<string | null>(null);
  const [editingSpace, setEditingSpace] = useState<Space | null>(null);

  const handleError = useCallback((error: unknown) => {
    if (error instanceof SlidesApiError && error.status === 401) setAuthError(true);
    else setLoadError(error instanceof Error ? error.message : String(error));
  }, []);

  const loadSpaces = useCallback(async () => {
    try {
      const data = await slidesApi<{ spaces: Space[] }>("/spaces");
      setSpaces(data.spaces);
    } catch (error) {
      handleError(error);
    }
  }, [handleError]);

  const loadDecks = useCallback(async () => {
    try {
      const query = selected === ALL ? "" : `?spaceId=${encodeURIComponent(selected)}`;
      const data = await slidesApi<{ decks: DeckGroup[] }>(`/decks${query}`);
      setDecks(data.decks);
    } catch (error) {
      if (error instanceof SlidesApiError && error.status === 503) setDecks([]);
      else handleError(error);
    }
  }, [selected, handleError]);

  useEffect(() => {
    void (async () => {
      try {
        const status = await slidesApi<{ enabled: boolean }>("/status");
        setEnabled(status.enabled);
        const [sourceData] = await Promise.all([slidesApi<{ sources: Source[] }>("/sources"), loadSpaces()]);
        setSources(sourceData.sources);
        if (status.enabled) {
          const templateData = await slidesApi<{ templates: Template[] }>("/templates").catch(() => undefined);
          if (templateData?.templates.length) setTemplates(templateData.templates);
        }
      } catch (error) {
        handleError(error);
      }
    })();
  }, [loadSpaces, handleError]);

  useEffect(() => {
    if (enabled) void loadDecks();
  }, [enabled, loadDecks]);

  const current = spaces.find((space) => space.id === selected);

  async function createSpace(name: string): Promise<void> {
    if (!name.trim()) return;
    try {
      const { space } = await slidesApi<{ space: Space }>("/spaces", { method: "POST", body: { name } });
      setNewSpaceName(null);
      await loadSpaces();
      setSelected(space.id);
    } catch (error) {
      handleError(error);
    }
  }

  async function saveSpace(space: Space): Promise<void> {
    try {
      await slidesApi(`/spaces/${encodeURIComponent(space.id)}`, {
        method: "PATCH",
        body: { name: space.name, instructions: space.instructions ?? "", template: space.template ?? "" }
      });
      setEditingSpace(null);
      await loadSpaces();
    } catch (error) {
      handleError(error);
    }
  }

  async function deleteSpace(space: Space): Promise<void> {
    if (!window.confirm(`Delete the space "${space.name}"? Its decks stay in All decks.`)) return;
    try {
      await slidesApi(`/spaces/${encodeURIComponent(space.id)}`, { method: "DELETE" });
      setEditingSpace(null);
      setSelected(ALL);
      await loadSpaces();
    } catch (error) {
      handleError(error);
    }
  }

  return (
    <div className="slidesApp">
      <AppRail active="slides" />

      <aside className="slidesSpaces" aria-label="Spaces">
        <div className="slidesSpacesHead">
          <a className="slidesBack" href="/" aria-label="Back to chat">
            <Icon name="chat" size={16} />
          </a>
          <h1>Slides</h1>
          <button type="button" className="slidesIconBtn" aria-label="New space" title="New space" onClick={() => setNewSpaceName("")}>
            <Icon name="plus" size={16} />
          </button>
        </div>
        <ul className="slidesSpaceList">
          <li>
            <button type="button" className={`slidesSpace${selected === ALL ? " active" : ""}`} onClick={() => setSelected(ALL)}>
              <span>All decks</span>
            </button>
          </li>
          {spaces.map((space) => (
            <li key={space.id}>
              <button type="button" className={`slidesSpace${selected === space.id ? " active" : ""}`} onClick={() => setSelected(space.id)}>
                <span>{space.name}</span>
                <span className="slidesCount">{space.deckCount}</span>
              </button>
            </li>
          ))}
          {newSpaceName !== null ? (
            <li>
              <form
                className="slidesSpaceForm"
                onSubmit={(event) => {
                  event.preventDefault();
                  void createSpace(newSpaceName);
                }}
              >
                <input
                  autoFocus
                  value={newSpaceName}
                  onChange={(event) => setNewSpaceName(event.target.value)}
                  placeholder="Space name"
                  aria-label="Space name"
                  maxLength={80}
                  onKeyDown={(event) => event.key === "Escape" && setNewSpaceName(null)}
                />
              </form>
            </li>
          ) : null}
        </ul>
      </aside>

      <main className="slidesMain">
        <header className="slidesHeader">
          <div>
            <h2>{current?.name ?? "All decks"}</h2>
            {current?.instructions ? <p className="slidesHint">{current.instructions}</p> : null}
          </div>
          <div className="slidesHeaderActions">
            {current ? (
              <button type="button" className="slidesBtn ghost" onClick={() => setEditingSpace({ ...current })}>
                Space settings
              </button>
            ) : null}
            <button type="button" className="slidesBtn primary" disabled={!enabled} onClick={() => setComposerOpen((open) => !open)}>
              <Icon name="plus" size={15} />
              New deck
            </button>
          </div>
        </header>

        {authError ? (
          <p className="slidesNotice">
            Sign in on the <a href="/">chat page</a> first, then come back.
          </p>
        ) : null}
        {loadError ? <p className="slidesNotice error">{loadError}</p> : null}
        {enabled === false ? (
          <p className="slidesNotice">
            Sibyl Slides is not running. Start the slides service (or set <code>SIBYL_SLIDES_URL</code> on the gateway) and reload.
          </p>
        ) : null}

        {editingSpace ? (
          <SlidesSpaceSettings
            space={editingSpace}
            templates={templates}
            onChange={setEditingSpace}
            onSave={() => void saveSpace(editingSpace)}
            onDelete={() => void deleteSpace(editingSpace)}
            onCancel={() => setEditingSpace(null)}
          />
        ) : null}

        {composerOpen && enabled ? (
          <SlidesComposer
            sources={sources}
            templates={templates}
            space={current}
            onFinished={() => {
              void loadDecks();
              void loadSpaces();
            }}
          />
        ) : null}

        {enabled && decks.length === 0 && !composerOpen ? (
          <div className="slidesEmpty">
            <SibylLoader state="idle" size={40} />
            <p>No decks here yet. Ask Sibyl in chat (“make a deck about…”) or start one here.</p>
            <button type="button" className="slidesBtn primary" onClick={() => setComposerOpen(true)}>
              New deck
            </button>
          </div>
        ) : null}

        <div className="slidesGrid">
          {decks.map((deck) => (
            <SlidesDeckTile key={deck.id} deck={deck} />
          ))}
        </div>
      </main>
    </div>
  );
}

function SlidesDeckTile({ deck }: { deck: DeckGroup }) {
  const [version, setVersion] = useState(deck.latest.id);
  const shown = deck.versions.find((v) => v.id === version) ?? deck.latest;
  return (
    <div className="slidesTile">
      <SlidesCard artifact={shown} compact />
      {deck.versions.length > 1 ? (
        <div className="slidesVersions" role="group" aria-label="Versions">
          {deck.versions.map((v) => (
            <button
              type="button"
              key={v.id}
              className={`slidesVersion${v.id === shown.id ? " active" : ""}`}
              onClick={() => setVersion(v.id)}
              title={v.createdAt ? new Date(v.createdAt).toLocaleString() : undefined}
            >
              v{v.version}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SlidesSpaceSettings(props: {
  space: Space;
  templates: Template[];
  onChange(space: Space): void;
  onSave(): void;
  onDelete(): void;
  onCancel(): void;
}) {
  const { space, templates, onChange } = props;
  return (
    <form
      className="slidesPanel"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSave();
      }}
    >
      <h3>Space settings</h3>
      <label className="slidesField">
        <span>Name</span>
        <input value={space.name} maxLength={80} onChange={(event) => onChange({ ...space, name: event.target.value })} />
      </label>
      <label className="slidesField">
        <span>Instructions for every deck (audience, tone, length)</span>
        <textarea
          rows={3}
          value={space.instructions ?? ""}
          onChange={(event) => onChange({ ...space, instructions: event.target.value })}
        />
      </label>
      <label className="slidesField">
        <span>Default template</span>
        <select value={space.template ?? ""} onChange={(event) => onChange({ ...space, template: event.target.value })}>
          <option value="">Engine default</option>
          {templates.map((template) => (
            <option key={template.id} value={template.id}>
              {template.name}
            </option>
          ))}
        </select>
      </label>
      <div className="slidesPanelActions">
        <button type="button" className="slidesBtn danger" onClick={props.onDelete}>
          Delete space
        </button>
        <span className="slidesSpacer" />
        <button type="button" className="slidesBtn ghost" onClick={props.onCancel}>
          Cancel
        </button>
        <button type="submit" className="slidesBtn primary" disabled={!space.name.trim()}>
          Save
        </button>
      </div>
    </form>
  );
}

const STEP_LABEL: Record<Progress["step"], string> = {
  starting: "Starting…",
  researching: "Gathering data from your sources…",
  outlining: "Outlining the deck…",
  generating: "Building the slides…",
  done: "Deck ready",
  error: "Something went wrong"
};

function SlidesComposer({
  sources,
  templates,
  space,
  onFinished
}: {
  sources: Source[];
  templates: Template[];
  space?: Space;
  onFinished(): void;
}) {
  const [prompt, setPrompt] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [template, setTemplate] = useState("");
  const [nSlides, setNSlides] = useState(8);
  const [progress, setProgress] = useState<Progress | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const running = progress !== null && progress.step !== "done" && progress.step !== "error";

  useEffect(() => () => controllerRef.current?.abort(), []);
  const grouped = useMemo(
    () => ({ tools: sources.filter((s) => s.kind === "tool"), mcp: sources.filter((s) => s.kind === "mcp") }),
    [sources]
  );

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
      setProgress((current) => {
        const base = current ?? { step: "starting" as const, tools: [] };
        if (event.type === "step") return { ...base, step: event.step };
        if (event.type === "tool") {
          const others = base.tools.filter((tool) => tool.callId !== event.callId);
          return { ...base, tools: [...others, { callId: event.callId, title: event.title, status: event.status }] };
        }
        if (event.type === "done") return { ...base, step: "done", artifact: event.artifact };
        return { ...base, step: "error", message: event.message };
      });
      if (event.type === "done") {
        onFinished();
        if (event.artifact.editUrl) window.location.assign(event.artifact.editUrl);
      }
    };
    try {
      await streamGenerate(
        {
          prompt: prompt.trim(),
          sources: [...picked],
          nSlides,
          ...(space ? { spaceId: space.id } : {}),
          ...(template ? { template } : {})
        },
        apply,
        controller.signal
      );
      setProgress((current) =>
        current && current.step !== "done" && current.step !== "error" ? { ...current, step: "error", message: "The connection closed early." } : current
      );
    } catch (error) {
      if (controller.signal.aborted) {
        setProgress(null);
        return;
      }
      setProgress((current) => ({ tools: current?.tools ?? [], step: "error", message: error instanceof Error ? error.message : String(error) }));
    }
  }

  return (
    <form
      className="slidesPanel"
      onSubmit={(event) => {
        event.preventDefault();
        void run();
      }}
    >
      <h3>New deck{space ? ` in ${space.name}` : ""}</h3>
      <label className="slidesField">
        <span>What should the deck show?</span>
        <textarea
          rows={4}
          value={prompt}
          placeholder="e.g. Our Q3 pipeline vs. Q2 for the board, with the top 5 deals and risks"
          onChange={(event) => setPrompt(event.target.value)}
          disabled={running}
        />
      </label>

      {sources.length ? (
        <fieldset className="slidesSources" disabled={running}>
          <legend>Get data from</legend>
          {grouped.mcp.length ? <span className="slidesSourceGroup">Connected (MCP)</span> : null}
          {grouped.mcp.map((source) => (
            <label key={source.id} className="slidesCheck" title={source.description}>
              <input type="checkbox" checked={picked.has(source.id)} onChange={() => toggle(source.id)} />
              <span>{source.label}</span>
            </label>
          ))}
          {grouped.tools.length ? <span className="slidesSourceGroup">Built-in</span> : null}
          {grouped.tools.map((source) => (
            <label key={source.id} className="slidesCheck" title={source.description}>
              <input type="checkbox" checked={picked.has(source.id)} onChange={() => toggle(source.id)} />
              <span>{source.label}</span>
            </label>
          ))}
        </fieldset>
      ) : null}

      <div className="slidesRow">
        <label className="slidesField">
          <span>Template</span>
          <select value={template} onChange={(event) => setTemplate(event.target.value)} disabled={running}>
            <option value="">{space?.template ? `Space default (${space.template})` : "Default"}</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label className="slidesField narrow">
          <span>Slides</span>
          <input
            type="number"
            min={1}
            max={40}
            value={nSlides}
            onChange={(event) => setNSlides(Math.max(1, Math.min(40, Number(event.target.value) || 8)))}
            disabled={running}
          />
        </label>
      </div>

      {progress ? (
        <div className={`slidesProgress ${progress.step}`} role="status" aria-live="polite">
          <div className="slidesProgressHead">
            <SibylLoader state={running ? "working" : "idle"} size={22} />
            <span>{STEP_LABEL[progress.step]}</span>
          </div>
          {progress.tools.length ? (
            <ul className="slidesProgressTools">
              {progress.tools.map((tool) => (
                <li key={tool.callId} className={tool.status}>
                  {tool.status === "running" ? (
                    <SibylLoader state="working" size={14} />
                  ) : (
                    <Icon name={tool.status === "ok" ? "check" : "close"} size={14} />
                  )}
                  {tool.title}
                </li>
              ))}
            </ul>
          ) : null}
          {progress.message ? <p className="slidesError">{progress.message}</p> : null}
          {progress.artifact ? <SlidesCard artifact={progress.artifact} compact /> : null}
        </div>
      ) : null}

      <div className="slidesPanelActions">
        <span className="slidesSpacer" />
        {running ? (
          <button type="button" className="slidesBtn ghost" onClick={() => controllerRef.current?.abort()}>
            Stop
          </button>
        ) : null}
        <button type="submit" className="slidesBtn primary" disabled={!prompt.trim() || running}>
          {picked.size ? "Research & build" : "Build deck"}
        </button>
      </div>
    </form>
  );
}
