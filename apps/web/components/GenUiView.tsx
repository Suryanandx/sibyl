"use client";

import { Component, type ReactNode } from "react";
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
      <div className="genui">
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
