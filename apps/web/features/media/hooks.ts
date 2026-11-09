"use client";

import { useEffect, useState } from "react";
import type { MediaItemView, MediaModelsResponse } from "@open-gpt-live/protocol";
import { getMedia, loadMediaModels, mediaFileUrl } from "./api";

const POLL_MS = 4_000;

/** A media item kept fresh while it renders (status, progress, outputs). */
export function useMediaItem(initial: MediaItemView | undefined, id?: string): MediaItemView | undefined {
  const [item, setItem] = useState<MediaItemView | undefined>(initial);
  const itemId = id ?? initial?.id;
  useEffect(() => {
    if (initial) setItem((current) => (!current || current.id !== initial.id || initial.updatedAt > current.updatedAt ? initial : current));
  }, [initial]);
  const running = !item || item.status === "running" || item.status === "queued";
  useEffect(() => {
    if (!itemId || !running) return;
    const controller = new AbortController();
    let timer: number | undefined;
    const tick = async () => {
      try {
        const fresh = await getMedia(itemId, controller.signal);
        setItem(fresh);
        if (fresh.status === "running" || fresh.status === "queued") timer = window.setTimeout(tick, POLL_MS);
      } catch {
        if (!controller.signal.aborted) timer = window.setTimeout(tick, POLL_MS * 2);
      }
    };
    timer = window.setTimeout(tick, item ? POLL_MS : 0);
    return () => {
      controller.abort();
      if (timer) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId, running]);
  return item;
}

/** A generated file as an object URL (auth stays in headers), revoked on unmount. */
export function useFileUrl(uploadId: string | undefined): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!uploadId) return;
    const controller = new AbortController();
    let made: string | undefined;
    void mediaFileUrl(uploadId, controller.signal)
      .then((value) => {
        made = value;
        if (!controller.signal.aborted) setUrl(value);
        else URL.revokeObjectURL(value);
      })
      .catch(() => undefined);
    return () => {
      controller.abort();
      if (made) URL.revokeObjectURL(made);
      setUrl(undefined);
    };
  }, [uploadId]);
  return url;
}

/** The media model catalogue (from OpenRouter, through the gateway). */
export function useMediaModels(enabled = true): { models: MediaModelsResponse | null; error: string | null } {
  const [models, setModels] = useState<MediaModelsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    loadMediaModels()
      .then((value) => alive && setModels(value))
      .catch((failure: unknown) => alive && setError(failure instanceof Error ? failure.message : "Media models could not be loaded."));
    return () => {
      alive = false;
    };
  }, [enabled]);
  return { models, error };
}
