"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import type {
  FileKind,
  KnowledgeBaseResponse,
  KnowledgeBaseView,
  KnowledgeDocView,
  KnowledgeListResponse,
  KnowledgeSearchResponse
} from "@open-gpt-live/protocol";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Checkbox,
  EmptyState,
  Input,
  ListItem,
  ListItems,
  Muted,
  Notice,
  Row,
  Select,
  Split,
  SplitBack,
  Stack,
  Tabs,
  Textarea,
  type Tone
} from "../../components/ui";
import { useAppSession } from "../../lib/app-session";
import { formatUsd, relativeTime } from "../../lib/format";
import { errorText, gatewayRequest } from "../../lib/gateway-http";
import { AddFiles } from "./AddFiles";
import styles from "./knowledge.module.css";

const POLL_MS = 2000;

type AddMode = "file" | "url" | "text";
type Run = (action: () => Promise<unknown>) => Promise<boolean>;

const ADD_MODES = [
  { value: "file", label: "Files" },
  { value: "url", label: "Web page" },
  { value: "text", label: "Text" }
] as const;

const basePath = (id: string) => `/api/knowledge/${encodeURIComponent(id)}`;

/** Knowledge: bases in the current workspace, their documents, and cited search. */
export function KnowledgeScreen() {
  const session = useAppSession();
  const workspaceId = session.currentWorkspaceId;
  const canEdit = session.can("knowledge.edit");
  const canManage = session.can("knowledge.manage");
  const canSettings = session.can("workspace.settings");

  const [list, setList] = useState<KnowledgeListResponse | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<KnowledgeBaseResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState("");

  const loadList = useCallback(async () => {
    try {
      setList(await gatewayRequest<KnowledgeListResponse>("/api/knowledge"));
      setError(null);
    } catch (cause) {
      setError(errorText(cause));
    }
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    try {
      setDetail(await gatewayRequest<KnowledgeBaseResponse>(basePath(id)));
    } catch (cause) {
      setError(errorText(cause));
      setDetail(null);
    }
  }, []);

  useEffect(() => {
    setSelected(null);
    setDetail(null);
    void loadList();
  }, [workspaceId, loadList]);

  useEffect(() => {
    if (selected) void loadDetail(selected);
  }, [selected, loadDetail]);

  // Poll while documents are indexing.
  const indexing = (detail?.docs ?? []).some((doc) => doc.status === "pending" || doc.status === "indexing");
  useEffect(() => {
    if (!indexing || !selected) return;
    const timer = setInterval(() => {
      void loadDetail(selected);
      void loadList();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [indexing, selected, loadDetail, loadList]);

  const run: Run = async (action) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      return true;
    } catch (cause) {
      setError(errorText(cause));
      return false;
    } finally {
      setBusy(false);
    }
  };

  async function createBase(event: FormEvent): Promise<void> {
    event.preventDefault();
    const name = newName.trim();
    if (!name) return;
    await run(async () => {
      const { base } = await gatewayRequest<{ base: KnowledgeBaseView }>("/api/knowledge", { method: "POST", body: { name } });
      setNewName("");
      await loadList();
      setSelected(base.id);
    });
  }

  async function toggleAuto(base: KnowledgeBaseView): Promise<void> {
    if (!list) return;
    const ids = new Set(list.autoBaseIds);
    if (ids.has(base.id)) ids.delete(base.id);
    else ids.add(base.id);
    await run(async () => {
      await gatewayRequest("/api/knowledge/settings", { method: "PUT", body: { autoBaseIds: [...ids] } });
      await loadList();
      if (selected) await loadDetail(selected);
    });
  }

  const bases = list?.bases ?? [];

  return (
    <Stack gap={20}>
      <KnowledgeSearch bases={bases} />

      {error ? <Notice tone="danger">{error}</Notice> : null}

      <Split
        open={selected !== null}
        list={
          <Card aria-label="Knowledge bases">
            <CardHeader title="Bases" actions={list?.embeddings ? <Badge tone="positive">Semantic search on</Badge> : null} />
            {!list ? (
              <Muted>Loading…</Muted>
            ) : bases.length === 0 ? (
              <Muted>No knowledge bases yet.{canManage ? " Create one to add files, pages and notes." : ""}</Muted>
            ) : (
              <ListItems label="Knowledge bases">
                {bases.map((base) => (
                  <ListItem
                    key={base.id}
                    current={selected === base.id}
                    onSelect={() => setSelected(base.id)}
                    title={base.name}
                    meta={
                      <>
                        {base.docCount} document{base.docCount === 1 ? "" : "s"}
                        {base.indexing ? ` · ${base.indexing} indexing` : ""}
                        {base.auto ? " · automatic" : ""}
                      </>
                    }
                  />
                ))}
              </ListItems>
            )}
            {canManage ? (
              <form className={styles.createRow} onSubmit={(event) => void createBase(event)}>
                <Input
                  placeholder="New base, e.g. Company policies"
                  value={newName}
                  maxLength={80}
                  onChange={(event) => setNewName(event.target.value)}
                  aria-label="New knowledge base name"
                />
                <Button type="submit" variant="primary" disabled={busy || !newName.trim()}>
                  Create
                </Button>
              </form>
            ) : null}
          </Card>
        }
        detail={
          <Card aria-label="Knowledge base">
            {!selected && list && bases.length === 0 ? (
              <EmptyState compact title="Teach Sibyl what your team knows">
                <p>
                  {canManage
                    ? "Create a base, then drop in files, a whole folder or web pages. Chats search it and show where each answer came from."
                    : "Nothing here yet. Ask a workspace admin to create a knowledge base."}
                </p>
              </EmptyState>
            ) : !selected ? (
              <EmptyState compact title="Choose a base">
                <p>Its documents, and whether chats search it automatically, show here.</p>
              </EmptyState>
            ) : !detail ? (
              <Muted>Loading…</Muted>
            ) : (
              <BaseDetail
                key={detail.base.id}
                detail={detail}
                busy={busy}
                canEdit={canEdit}
                canManage={canManage}
                canSettings={canSettings}
                onBack={() => setSelected(null)}
                onToggleAuto={() => void toggleAuto(detail.base)}
                run={run}
                reload={async () => {
                  await loadDetail(detail.base.id);
                  await loadList();
                }}
                onDeleted={async () => {
                  setSelected(null);
                  setDetail(null);
                  await loadList();
                }}
              />
            )}
          </Card>
        }
      />
    </Stack>
  );
}

function BaseDetail(props: {
  detail: KnowledgeBaseResponse;
  busy: boolean;
  canEdit: boolean;
  canManage: boolean;
  canSettings: boolean;
  onBack: () => void;
  onToggleAuto: () => void;
  run: Run;
  reload: () => Promise<void>;
  onDeleted: () => Promise<void>;
}) {
  const { detail, busy, canEdit, canManage, canSettings, run, reload } = props;
  const { base, docs } = detail;
  const [renaming, setRenaming] = useState<{ name: string; description: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const path = basePath(base.id);

  async function saveRename(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!renaming) return;
    const ok = await run(async () => {
      await gatewayRequest(path, { method: "PATCH", body: { name: renaming.name, description: renaming.description } });
      await reload();
    });
    if (ok) setRenaming(null);
  }

  return (
    <Stack gap={14}>
      <SplitBack label="Bases" onClick={props.onBack} />
      {renaming ? (
        <form className={styles.box} onSubmit={(event) => void saveRename(event)}>
          <Input value={renaming.name} maxLength={80} onChange={(event) => setRenaming({ ...renaming, name: event.target.value })} aria-label="Name" />
          <Input
            value={renaming.description}
            maxLength={500}
            placeholder="What's in it (optional)"
            onChange={(event) => setRenaming({ ...renaming, description: event.target.value })}
            aria-label="Description"
          />
          <Row>
            <Button type="submit" variant="primary" disabled={busy || !renaming.name.trim()}>
              Save
            </Button>
            <Button variant="ghost" onClick={() => setRenaming(null)}>
              Cancel
            </Button>
          </Row>
        </form>
      ) : (
        <CardHeader
          level={2}
          title={base.name}
          meta={base.description}
          actions={
            canManage ? (
              <Button variant="ghost" size="sm" onClick={() => setRenaming({ name: base.name, description: base.description ?? "" })}>
                Rename
              </Button>
            ) : null
          }
        />
      )}

      <Checkbox
        label="Searched automatically in this workspace’s chats"
        checked={base.auto}
        disabled={!canSettings || busy}
        onChange={props.onToggleAuto}
        title={canSettings ? undefined : "Only workspace admins can change this"}
      />

      {canEdit ? <AddDocument basePath={path} busy={busy} run={run} reload={reload} /> : null}

      <div>
        {docs.length === 0 ? (
          <Muted>No documents yet.</Muted>
        ) : (
          docs.map((doc) => <DocRow key={doc.id} doc={doc} basePath={path} canEdit={canEdit} busy={busy} run={run} reload={reload} />)
        )}
      </div>

      {canManage ? (
        <Row>
          {confirmDelete ? (
            <>
              <Muted as="span">Delete &ldquo;{base.name}&rdquo; and all its documents?</Muted>
              <Button
                variant="danger"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await gatewayRequest(path, { method: "DELETE" });
                    await props.onDeleted();
                  })
                }
              >
                Delete
              </Button>
              <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                Keep
              </Button>
            </>
          ) : (
            <Button variant="danger" size="sm" onClick={() => setConfirmDelete(true)}>
              Delete base
            </Button>
          )}
        </Row>
      ) : null}
    </Stack>
  );
}

function AddDocument(props: { basePath: string; busy: boolean; run: Run; reload: () => Promise<void> }) {
  const [mode, setMode] = useState<AddMode>("file");
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const docsPath = `${props.basePath}/docs`;

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const body = mode === "url" ? { kind: "url", url: url.trim(), ...(title.trim() ? { title: title.trim() } : {}) } : { kind: "text", title: title.trim(), text };
    const ok = await props.run(async () => {
      await gatewayRequest(docsPath, { method: "POST", body });
      await props.reload();
    });
    if (ok) {
      setUrl("");
      setTitle("");
      setText("");
    }
  }

  return (
    <div className={styles.box}>
      <Tabs label="Add a document" options={ADD_MODES} value={mode} onChange={setMode} />
      {mode === "file" ? (
        <AddFiles docsPath={docsPath} disabled={props.busy} onAdded={props.reload} />
      ) : (
        <form className={styles.addForm} onSubmit={(event) => void submit(event)}>
          {mode === "url" ? <Input type="url" placeholder="https://…" value={url} onChange={(event) => setUrl(event.target.value)} aria-label="Web page address" required /> : null}
          <Input
            placeholder={mode === "url" ? "Title (optional)" : "Title"}
            value={title}
            maxLength={200}
            onChange={(event) => setTitle(event.target.value)}
            aria-label="Title"
            required={mode === "text"}
          />
          {mode === "text" ? <Textarea placeholder="Paste notes, an FAQ, a policy…" value={text} onChange={(event) => setText(event.target.value)} aria-label="Text" required /> : null}
          <Row>
            <Button type="submit" variant="primary" size="sm" disabled={props.busy}>
              Add
            </Button>
          </Row>
        </form>
      )}
    </div>
  );
}

const DOC_STATUS: Record<KnowledgeDocView["status"], { label: string; tone: Tone }> = {
  ready: { label: "Ready", tone: "positive" },
  failed: { label: "Failed", tone: "danger" },
  indexing: { label: "Indexing…", tone: "warning" },
  pending: { label: "Waiting…", tone: "warning" }
};

/** Short type tag shown as the document's icon. */
const KIND_TAG: Record<FileKind, string> = {
  image: "IMG", pdf: "PDF", text: "TXT", markdown: "MD", csv: "CSV", tsv: "TSV", json: "JSON", yaml: "YAML", xml: "XML",
  toml: "TOML", ini: "INI", html: "HTML", rtf: "RTF", eml: "MAIL", code: "CODE", docx: "DOC", xlsx: "XLS", pptx: "PPT",
  odt: "ODT", ods: "ODS", odp: "ODP", epub: "BOOK", zip: "ZIP", video: "VID", audio: "AUD"
};

function docTag(doc: KnowledgeDocView): string {
  if (doc.source.kind === "url") return "WEB";
  if (doc.source.kind === "text") return "NOTE";
  return doc.fileKind ? KIND_TAG[doc.fileKind] : "FILE";
}

function partsText(parts: KnowledgeDocView["parts"]): string | undefined {
  return parts ? `${parts.count} ${parts.unit}${parts.count === 1 ? "" : "s"}` : undefined;
}

/** "Read by google/gemini-2.5-flash (mistral-ocr) · $0.0020" */
function ocrText(ocr: KnowledgeDocView["ocr"]): string | undefined {
  if (!ocr) return undefined;
  return `Read by ${ocr.model}${ocr.engine ? ` (${ocr.engine})` : ""} · ${ocr.estimated ? "~" : ""}${formatUsd(ocr.costUsd)}`;
}

function DocRow(props: { doc: KnowledgeDocView; basePath: string; canEdit: boolean; busy: boolean; run: Run; reload: () => Promise<void> }) {
  const { doc } = props;
  const docPath = `${props.basePath}/docs/${encodeURIComponent(doc.id)}`;
  const status = DOC_STATUS[doc.status];
  const source = doc.source.kind === "url" ? doc.source.url : doc.source.kind === "upload" ? doc.source.fileName : "Pasted text";
  const act = (suffix: string, method: string) =>
    void props.run(async () => {
      await gatewayRequest(`${docPath}${suffix}`, { method });
      await props.reload();
    });
  const meta = [
    source,
    partsText(doc.parts),
    doc.status === "ready" ? `${doc.chunkCount} passage${doc.chunkCount === 1 ? "" : "s"}` : undefined,
    ocrText(doc.ocr),
    relativeTime(doc.updatedAt)
  ].filter(Boolean);
  return (
    <div className={styles.docRow}>
      <span className={styles.typeTag} aria-hidden>
        {docTag(doc)}
      </span>
      <div className={styles.docMain}>
        <Row>
          <span className={styles.docTitle}>{doc.title}</span>
          <Badge tone={status.tone}>{status.label}</Badge>
        </Row>
        <span className={styles.docMeta}>{meta.join(" · ")}</span>
        {doc.error ? <span className={styles.docError}>{doc.error}</span> : null}
      </div>
      {props.canEdit ? (
        <Row>
          {doc.source.kind !== "text" && (doc.status === "ready" || doc.status === "failed") ? (
            <Button variant="ghost" size="sm" disabled={props.busy} onClick={() => act("/reindex", "POST")}>
              Re-index
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" disabled={props.busy} onClick={() => act("", "DELETE")}>
            Remove
          </Button>
        </Row>
      ) : null}
    </div>
  );
}

/** Search box with cited results (all bases, or one). */
export function KnowledgeSearch({ bases }: { bases: KnowledgeBaseView[] }) {
  const [query, setQuery] = useState("");
  const [baseId, setBaseId] = useState("");
  const [result, setResult] = useState<KnowledgeSearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);

  async function search(event: FormEvent): Promise<void> {
    event.preventDefault();
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    setError(null);
    try {
      const params = new URLSearchParams({ q, limit: "8", ...(baseId ? { base: baseId } : {}) });
      setResult(await gatewayRequest<KnowledgeSearchResponse>(`/api/knowledge/search?${params.toString()}`));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSearching(false);
    }
  }

  return (
    <Stack gap={12} aria-label="Search knowledge">
      <form className={styles.searchForm} onSubmit={(event) => void search(event)} role="search">
        <Input type="search" placeholder="Search your knowledge…" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search" />
        {bases.length > 1 ? (
          <Select className={styles.baseSelect} value={baseId} onChange={(event) => setBaseId(event.target.value)} aria-label="Base">
            <option value="">All bases</option>
            {bases.map((base) => (
              <option key={base.id} value={base.id}>
                {base.name}
              </option>
            ))}
          </Select>
        ) : null}
        <Button type="submit" variant="primary" disabled={searching || !query.trim()}>
          {searching ? "Searching…" : "Search"}
        </Button>
      </form>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {result ? (
        result.hits.length === 0 ? (
          <Muted>Nothing matches &ldquo;{result.query}&rdquo;.</Muted>
        ) : (
          <ol className={styles.hits}>
            {result.hits.map((hit, index) => (
              <Card as="li" key={`${hit.docId}-${index}`} className={styles.hit}>
                <Row>
                  <span className={styles.citation}>
                    [{index + 1}] {hit.citation}
                  </span>
                  <span className={styles.docMeta}>{hit.baseName}</span>
                  {hit.url ? (
                    <a className={styles.docMeta} href={hit.url} target="_blank" rel="noopener noreferrer">
                      Open ↗
                    </a>
                  ) : null}
                </Row>
                <p className={styles.snippet}>{hit.snippet}</p>
              </Card>
            ))}
          </ol>
        )
      ) : null}
    </Stack>
  );
}
