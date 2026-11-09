"use client";

/**
 * Spaces → Media: the workspace's media library. Everything made in chat
 * (by people or agents) is saved here automatically. Browse, search, filter,
 * collections and favourites, a detail view, and hand-offs back to chat —
 * chat is the one place media is made ("Create" opens it in the right mode).
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { MediaCollectionView, MediaItemView, MediaKind } from "@open-gpt-live/protocol";
import { Icon } from "../../components/Icon";
import { Button, EmptyState, Notice } from "../../components/ui";
import { errorText } from "../../lib/gateway-http";
import { useAppSession } from "../../lib/app-session";
import { paths } from "../../lib/routes";
import {
  chatPathFor,
  createCollection,
  deleteCollection,
  deleteMedia,
  KIND_LABEL,
  listCollections,
  listMedia,
  MEDIA_PATH,
  mediaItemPath,
  renameCollection,
  stashChatIntent,
  updateMedia,
  type MediaFilter
} from "./api";
import { useFileUrl } from "./hooks";
import { MediaPreview } from "./MediaResult";
import styles from "./media.module.css";

type Shelf = { kind: "all" } | { kind: "favorites" } | { kind: "collection"; id: string };

export function MediaScreen({ selectedId }: { selectedId?: string }) {
  const router = useRouter();
  const session = useAppSession();
  const me = session.user?.id;
  const [items, setItems] = useState<MediaItemView[] | null>(null);
  const [collections, setCollections] = useState<MediaCollectionView[]>([]);
  const [shelf, setShelf] = useState<Shelf>({ kind: "all" });
  const [error, setError] = useState<string>();
  const [filter, setFilter] = useState<MediaFilter>({});
  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);

  const reload = useCallback(async () => {
    try {
      const shelfFilter: MediaFilter = shelf.kind === "favorites" ? { favorites: "1" } : shelf.kind === "collection" ? { collection: shelf.id } : {};
      const [list, groups] = await Promise.all([listMedia({ ...filter, ...shelfFilter, ...(query.trim() ? { q: query.trim() } : {}) }), listCollections()]);
      setItems(list);
      setCollections(groups);
      setError(undefined);
    } catch (failure) {
      setError(errorText(failure));
    }
  }, [filter, query, shelf]);

  useEffect(() => {
    const timer = window.setTimeout(() => void reload(), query ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [reload, query]);

  // Refresh while something renders.
  useEffect(() => {
    if (!items?.some((item) => item.status === "running" || item.status === "queued")) return;
    const timer = window.setInterval(() => void reload(), 6_000);
    return () => window.clearInterval(timer);
  }, [items, reload]);

  // On a phone the details sit under the gallery: bring them into view.
  useEffect(() => {
    if (!selectedId || window.matchMedia("(min-width: 901px)").matches) return;
    const timer = window.setTimeout(() => document.getElementById("media-detail")?.scrollIntoView({ behavior: "smooth", block: "start" }), 300);
    return () => window.clearTimeout(timer);
  }, [selectedId]);

  const modelsInUse = useMemo(() => [...new Map((items ?? []).map((item) => [item.model, item.modelName ?? item.model])).entries()], [items]);
  const selected = selectedId ? items?.find((item) => item.id === selectedId) : undefined;
  const currentCollection = shelf.kind === "collection" ? collections.find((c) => c.id === shelf.id) : undefined;

  const run = async (work: () => Promise<void>) => {
    try {
      await work();
      await reload();
    } catch (failure) {
      setError(errorText(failure));
    }
  };

  const toChat = (intent: Parameters<typeof stashChatIntent>[0], path: string) => {
    stashChatIntent(intent);
    router.push(path);
  };

  async function remove(item: MediaItemView): Promise<void> {
    if (!window.confirm("Delete this and its files? This can't be undone.")) return;
    await run(async () => {
      await deleteMedia(item.id);
      if (selectedId === item.id) router.push(MEDIA_PATH);
    });
  }

  return (
    <div className={styles.page}>
      <div className={styles.libraryBar}>
        <nav className={styles.shelves} aria-label="Library">
          <button type="button" className={shelf.kind === "all" ? styles.chipOn : styles.chip} onClick={() => setShelf({ kind: "all" })}>
            All
          </button>
          <button type="button" className={shelf.kind === "favorites" ? styles.chipOn : styles.chip} onClick={() => setShelf({ kind: "favorites" })}>
            Favourites
          </button>
          {collections.map((collection) => (
            <button
              key={collection.id}
              type="button"
              className={shelf.kind === "collection" && shelf.id === collection.id ? styles.chipOn : styles.chip}
              onClick={() => setShelf({ kind: "collection", id: collection.id })}
            >
              {collection.name} <span className={styles.count}>{collection.count}</span>
            </button>
          ))}
          <button
            type="button"
            className={styles.chip}
            onClick={() => {
              const name = window.prompt("Name the new collection");
              if (name?.trim()) void run(async () => setShelf({ kind: "collection", id: (await createCollection(name)).id }));
            }}
          >
            <Icon name="plus" size={12} /> New collection
          </button>
        </nav>
        <div className={styles.modeMenu}>
          <Button variant="primary" size="sm" aria-haspopup="menu" aria-expanded={createOpen} onClick={() => setCreateOpen((v) => !v)}>
            <Icon name="plus" size={14} />
            Create
          </Button>
          {createOpen ? (
            <div className={`${styles.popover} ${styles.modeList} ${styles.popoverDown}`} role="menu">
              {(["image", "video", "audio"] as MediaKind[]).map((kind) => (
                <button key={kind} type="button" role="menuitem" className={styles.modeItem} onClick={() => toChat({ action: "create", kind }, paths.newChat)}>
                  <Icon name={kind === "video" ? "video" : kind === "audio" ? "volume" : "sparkle"} size={16} />
                  <span>
                    {KIND_LABEL[kind]}
                    <small>Opens chat in {KIND_LABEL[kind]} mode</small>
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {currentCollection ? (
        <div className={styles.actions}>
          <strong>{currentCollection.name}</strong>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              const name = window.prompt("Rename the collection", currentCollection.name);
              if (name?.trim()) void run(() => renameCollection(currentCollection.id, name));
            }}
          >
            Rename
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              if (window.confirm(`Delete the collection "${currentCollection.name}"? Its media stay in the library.`)) {
                void run(async () => {
                  await deleteCollection(currentCollection.id);
                  setShelf({ kind: "all" });
                });
              }
            }}
          >
            Delete collection
          </Button>
        </div>
      ) : null}

      {error ? <Notice tone="danger">{error}</Notice> : null}

      <div className={styles.filters}>
        <input type="search" aria-label="Search prompts" placeholder="Search prompts…" value={query} onChange={(event) => setQuery(event.target.value)} />
        <select aria-label="Type" value={filter.kind ?? ""} onChange={(event) => setFilter((f) => ({ ...f, kind: (event.target.value || undefined) as MediaKind | undefined }))}>
          <option value="">All types</option>
          <option value="image">Images</option>
          <option value="video">Videos</option>
          <option value="audio">Audio</option>
        </select>
        <select aria-label="Model" value={filter.model ?? ""} onChange={(event) => setFilter((f) => ({ ...f, model: event.target.value || undefined }))}>
          <option value="">All models</option>
          {modelsInUse.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
        <select aria-label="Made by" value={filter.creator ?? ""} onChange={(event) => setFilter((f) => ({ ...f, creator: event.target.value || undefined }))}>
          <option value="">Anyone</option>
          <option value="me">Me</option>
        </select>
      </div>

      <div className={`${styles.layout}${selectedId ? ` ${styles.layoutOpen}` : ""}`}>
        <div>
          {items === null ? (
            <p className={styles.modelNote}>Loading…</p>
          ) : items.length === 0 ? (
            <EmptyState title={query || filter.kind || filter.model || filter.creator || shelf.kind !== "all" ? "Nothing here" : "No media yet"}>
              <p>Images, videos and audio made in chat — by you, your team or agents — are saved here automatically. Use Create to start one in chat.</p>
            </EmptyState>
          ) : (
            <div className={styles.gallery}>
              {items.map((item) => (
                <Tile key={item.id} item={item} selected={item.id === selectedId} onOpen={() => router.push(mediaItemPath(item.id))} />
              ))}
            </div>
          )}
        </div>
        {selectedId ? (
          <aside id="media-detail" className={styles.detail} aria-label="Details">
            <div className={styles.detailHead}>
              <strong>{selected ? KIND_LABEL[selected.kind] : "Media"}</strong>
              <div className={styles.actions}>
                {selected ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-pressed={Boolean(selected.favorite)}
                    onClick={() => void run(async () => void (await updateMedia(selected.id, { favorite: !selected.favorite })))}
                  >
                    {selected.favorite ? "★ Favourite" : "☆ Favourite"}
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" onClick={() => router.push(MEDIA_PATH)} aria-label="Close details">
                  <Icon name="close" size={14} />
                </Button>
              </div>
            </div>
            {selected ? (
              <div className={styles.actions}>
                {collections.length ? (
                  <select
                    aria-label="Add to collection"
                    className={styles.inlineSelect}
                    value=""
                    onChange={(event) => {
                      const id = event.target.value;
                      if (!id) return;
                      const inIt = selected.collectionIds?.includes(id);
                      void run(async () => void (await updateMedia(selected.id, inIt ? { removeFromCollection: id } : { addToCollection: id })));
                    }}
                  >
                    <option value="">Collections…</option>
                    {collections.map((c) => (
                      <option key={c.id} value={c.id}>
                        {selected.collectionIds?.includes(c.id) ? `✓ ${c.name} (remove)` : `Add to ${c.name}`}
                      </option>
                    ))}
                  </select>
                ) : null}
                {selected.conversationId ? (
                  <Link className={styles.linkButton} href={paths.conversation(selected.conversationId)}>
                    Open its chat
                  </Link>
                ) : null}
              </div>
            ) : null}
            <MediaPreview
              key={selectedId}
              uploadId=""
              mediaType={selected?.kind ?? "image"}
              jobId={selectedId}
              onUseInChat={(item) => toChat({ action: "use", item }, chatPathFor(item))}
              onRemix={(item) => toChat({ action: "remix", item }, chatPathFor(item))}
              {...(selected && (selected.createdBy === me || session.can("chat.view_all") || !me) ? { onDelete: (item: MediaItemView) => void remove(item) } : {})}
            />
          </aside>
        ) : null}
      </div>
    </div>
  );
}

function Tile({ item, selected, onOpen }: { item: MediaItemView; selected: boolean; onOpen: () => void }) {
  const first = item.outputs[0];
  const url = useFileUrl(item.kind === "image" && first ? first.uploadId : undefined);
  const status = item.status === "running" || item.status === "queued" ? "Rendering…" : item.status === "error" ? "Failed" : item.status === "cancelled" ? "Cancelled" : KIND_LABEL[item.kind];
  return (
    <button type="button" className={`${styles.tile}${selected ? ` ${styles.tileOn}` : ""}`} onClick={onOpen} aria-current={selected ? "true" : undefined} aria-label={`${status}: ${item.prompt}`}>
      <span className={styles.tileMedia}>
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt="" />
        ) : (
          <Icon name={item.kind === "video" ? "video" : item.kind === "audio" ? "volume" : "sparkle"} size={26} />
        )}
        <span className={styles.tileBadge}>
          {item.favorite ? "★ " : ""}
          {status}
        </span>
      </span>
      <span className={styles.tileText}>
        <strong>{item.prompt}</strong>
        <span>
          {(item.modelName ?? item.model).replace(/^[^:]+:\s*/, "")} · {new Date(item.createdAt).toLocaleDateString()}
        </span>
      </span>
    </button>
  );
}
