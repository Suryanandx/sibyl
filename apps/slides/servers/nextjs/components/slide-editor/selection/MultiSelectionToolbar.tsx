"use client";

import { createPortal } from "react-dom";
import { Group } from "lucide-react";
import { editorShortcutById } from "@/components/slide-editor/shortcuts/editorShortcuts";
import {
  ShortcutKeys,
  useAppleShortcutPlatform,
} from "@/components/slide-editor/shortcuts/ShortcutKeys";

const GROUP_SHORTCUT = editorShortcutById("group");

export function TemplateV2MultiSelectionToolbar({
  count,
  onGroup,
  position,
}: {
  count: number;
  onGroup: () => void;
  position: { left: number; top: number } | null;
}) {
  const applePlatform = useAppleShortcutPlatform();
  if (!position || !GROUP_SHORTCUT || typeof document === "undefined") {
    return null;
  }

  const toolbar = (
    <div
      data-inline-edit-ignore="true"
      data-template-v2-floating-toolbar="true"
      className="fixed z-[10000] inline-flex h-11 items-center gap-1.5 rounded-[10px] border border-[var(--border)] bg-[var(--surface)] p-1.5 font-manrope text-[var(--text)] shadow-[0_10px_30px_rgba(16,24,40,0.14)]"
      style={{ left: position.left, top: position.top }}
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="inline-flex h-8 items-center gap-2 px-2">
        <span className="whitespace-nowrap text-[13px] font-semibold text-[var(--text)]">
          {count} selected
        </span>
      </div>
      <span aria-hidden="true" className="h-5 w-px bg-[var(--subtle)]" />
      <button
        type="button"
        aria-keyshortcuts="Control+G Meta+G"
        className="inline-flex h-8 items-center gap-2 rounded-[7px] bg-[var(--ink)] px-3 text-[13px] font-semibold text-[var(--ink-text)] transition-colors hover:bg-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2"
        onClick={onGroup}
      >
        <Group aria-hidden="true" className="size-4" strokeWidth={1.8} />
        <span>Group</span>
        <ShortcutKeys
          applePlatform={applePlatform}
          compact
          shortcut={GROUP_SHORTCUT}
          className="[&_kbd]:border-[color-mix(in_srgb,var(--border)_20%,transparent)] [&_kbd]:bg-[color-mix(in_srgb,var(--surface)_15%,transparent)] [&_kbd]:text-white [&_kbd]:shadow-none"
        />
      </button>
    </div>
  );

  return createPortal(toolbar, document.body);
}
