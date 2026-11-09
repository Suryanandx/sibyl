"use client";

import { ScreenFrame } from "../../components/ScreenFrame";
import { EmptyState } from "../../components/ui";
import { useAppSession } from "../../lib/app-session";
import { MediaScreen } from "./MediaScreen";

/** /media and /media/<id>: the Media place (Spaces → Media). */
export function MediaPage({ selectedId }: { selectedId?: string }) {
  const session = useAppSession();
  return (
    <ScreenFrame title="Media" subtitle="Images, videos and audio made in this workspace — in chat, by agents or here.">
      {session.can("chat.use") ? (
        <MediaScreen {...(selectedId ? { selectedId } : {})} />
      ) : (
        <EmptyState title="You don't have access to media">
          <p>Ask a workspace owner or admin if you need it.</p>
        </EmptyState>
      )}
    </ScreenFrame>
  );
}
