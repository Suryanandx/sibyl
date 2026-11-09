"use client";

import { Component, useEffect, useRef, type ReactNode } from "react";
import {
  BuiltinActionType,
  Renderer,
  type ActionEvent
} from "@openuidev/react-lang";
import { openuiChatLibrary } from "@openuidev/react-ui/genui-lib";

export interface GenUiAction {
  /** Shown in the transcript as the user's turn. */
  display: string;
  /** Sent to the model (includes form values when a form was submitted). */
  prompt: string;
}

interface GenUiViewProps {
  source: string;
  streaming: boolean;
  onAction?: (action: GenUiAction) => void;
}

/**
 * Renders streamed OpenUI Lang from the assistant with the OpenUI chat
 * component library. Button / form actions become new user turns.
 * Theme tokens come from the app-level OpenUI ThemeProvider (see page.tsx), so
 * portaled popups (selects, date pickers, modals) are themed too.
 */
export function GenUiView({ source, streaming, onAction }: GenUiViewProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  useImageGuard(wrapperRef);

  if (!source.trim()) {
    return null;
  }

  const handleAction = (event: ActionEvent): void => {
    if (event.type === BuiltinActionType.OpenUrl) {
      const url = typeof event.params.url === "string" ? event.params.url : "";
      if (/^https?:\/\//i.test(url)) {
        window.open(url, "_blank", "noopener,noreferrer");
      }
      return;
    }
    if (event.type !== BuiltinActionType.ContinueConversation) {
      return;
    }
    const display = event.humanFriendlyMessage || "Continue";
    const formValues =
      event.formState && Object.keys(event.formState).length > 0
        ? `\nForm${event.formName ? ` "${event.formName}"` : ""} values: ${JSON.stringify(event.formState)}`
        : "";
    onAction?.({ display, prompt: `[UI action] ${display}${formValues}` });
  };

  return (
    <RenderBoundary>
      <div className="genui" ref={wrapperRef}>
          <Renderer
            response={source}
            library={openuiChatLibrary}
            isStreaming={streaming}
            onAction={handleAction}
            onError={(errors) => {
              if (!streaming && errors.length > 0) {
                console.warn("[openui] render issues", errors);
              }
            }}
          />
      </div>
    </RenderBoundary>
  );
}

class RenderBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return <p className="genuiError">This visual could not be rendered.</p>;
    }
    return this.props.children;
  }
}

const CARD_IMAGE_VAR = "--openui-visual-card-image";
const checked = new WeakMap<Element, string>();

/**
 * Keeps images in generated visuals light and never broken:
 * - Wikimedia originals are requested at display size (Special:FilePath and
 *   upload.wikimedia.org thumbnails), instead of multi-megabyte originals;
 * - an image that fails to load is replaced by a calm placeholder instead of
 *   an empty box (the card keeps its text).
 */
function useImageGuard(ref: React.RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    const root = ref.current;
    if (!root) return;

    const markBroken = (element: Element) => element.classList.add("genuiImageBroken");

    const guard = (element: Element) => {
      if (element instanceof HTMLImageElement) {
        const url = element.getAttribute("src") ?? "";
        if (checked.get(element) === url) return;
        checked.set(element, url);
        const sized = sizedImageUrl(url);
        if (sized !== url) element.setAttribute("src", sized);
        if (!url || !/^https?:|^data:|^\//i.test(url)) return markBroken(element);
        element.addEventListener("error", () => markBroken(element), { once: true });
        if (element.complete && element.naturalWidth === 0 && url) markBroken(element);
        return;
      }
      const html = element as HTMLElement;
      const value = html.style.getPropertyValue(CARD_IMAGE_VAR);
      if (!value || checked.get(element) === value) return;
      const url = /url\((["']?)(.*?)\1\)/.exec(value)?.[2] ?? "";
      const sized = sizedImageUrl(url);
      const finalValue = sized !== url ? `url("${sized}")` : value;
      checked.set(element, finalValue);
      if (sized !== url) html.style.setProperty(CARD_IMAGE_VAR, finalValue);
      if (!/^https?:/i.test(sized)) return markBroken(element);
      const probe = new Image();
      probe.onerror = () => markBroken(element);
      probe.src = sized;
    };

    const scan = () => {
      root.querySelectorAll(`img, [style*="${CARD_IMAGE_VAR}"]`).forEach(guard);
    };
    scan();
    const observer = new MutationObserver(scan);
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["src", "style"] });
    return () => observer.disconnect();
  }, [ref]);
}

/** Ask Wikimedia for a display-sized rendition instead of the original file. */
export function sizedImageUrl(url: string, width = 960): string {
  try {
    const parsed = new URL(url);
    if (/(^|\.)wikimedia\.org$|(^|\.)wikipedia\.org$/.test(parsed.hostname) && /Special:FilePath/i.test(parsed.pathname)) {
      if (!parsed.searchParams.has("width")) parsed.searchParams.set("width", String(width));
      return parsed.toString();
    }
    return url;
  } catch {
    return url;
  }
}
