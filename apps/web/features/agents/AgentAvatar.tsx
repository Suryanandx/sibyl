"use client";

import { useEffect, useMemo, useState } from "react";
import { normalizeAvatar, renderAvatarSvg, type AvatarMood } from "@open-gpt-live/core/avatar";
import type { AgentAvatarView } from "@open-gpt-live/protocol";
import { uploadBlobUrl } from "../../components/AttachmentClient";
import styles from "./agents.module.css";

export type { AvatarMood };

/**
 * An agent's face: Sibyl's generated SVG character, animated by mood
 * (idle, listening, thinking, speaking, happy, sleeping). Used in agent
 * cards, the composer picker and next to chat replies.
 */
export function AgentAvatar({
  avatar,
  mood = "idle",
  size = 40,
  name,
  className
}: {
  avatar: AgentAvatarView;
  mood?: AvatarMood;
  size?: number;
  /** Accessible name; omit when the agent's name is written next to it. */
  name?: string;
  className?: string;
}) {
  const imageUrl = useUploadUrl(avatar.kind === "custom-image" ? avatar.imageUploadId : undefined);
  const svg = useMemo(
    () => renderAvatarSvg(normalizeAvatar(avatar), { mood, size, ...(name ? { title: name } : {}), ...(imageUrl ? { imageUrl } : {}) }),
    [avatar, mood, size, name, imageUrl]
  );
  return (
    <span
      className={className ? `${styles.avatar} ${className}` : styles.avatar}
      data-mood={mood}
      style={{ width: size, height: size }}
      // The SVG is built from normalized values only (escaped title, checked image URL).
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/** Object URL of an uploaded image (fetched with the session's credentials). */
function useUploadUrl(uploadId: string | undefined): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    let live = true;
    setUrl(undefined);
    if (uploadId) {
      uploadBlobUrl(uploadId).then(
        (value) => live && setUrl(value),
        () => undefined
      );
    }
    return () => {
      live = false;
    };
  }, [uploadId]);
  return url;
}
