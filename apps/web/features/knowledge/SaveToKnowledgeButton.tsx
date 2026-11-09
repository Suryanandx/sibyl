"use client";

import { useState } from "react";
import { Button, Muted } from "../../components/ui";
import { useAppSession } from "../../lib/app-session";
import { errorText, gatewayRequest } from "../../lib/gateway-http";

/**
 * "Save to knowledge" for a chat attachment: one call that adds the upload to
 * the given base (or the workspace's "Saved files"). Hidden without
 * knowledge.edit. Mount it next to an attachment chip: <SaveToKnowledgeButton uploadId={id} />.
 */
export function SaveToKnowledgeButton({ uploadId, knowledgeBaseId, onSaved }: { uploadId: string; knowledgeBaseId?: string; onSaved?: (baseName: string) => void }) {
  const session = useAppSession();
  const [state, setState] = useState<{ status: "idle" | "saving" | "saved" | "error"; message?: string }>({ status: "idle" });
  if (!session.can("knowledge.edit")) return null;

  async function save(): Promise<void> {
    setState({ status: "saving" });
    try {
      const result = await gatewayRequest<{ base: { name: string } }>("/api/knowledge/save-upload", {
        method: "POST",
        body: { uploadId, ...(knowledgeBaseId ? { knowledgeBaseId } : {}) }
      });
      setState({ status: "saved", message: `Saved to ${result.base.name}` });
      onSaved?.(result.base.name);
    } catch (cause) {
      setState({ status: "error", message: errorText(cause) });
    }
  }

  if (state.status === "saved") return <Muted as="span">{state.message}</Muted>;
  return (
    <Button size="sm" onClick={() => void save()} disabled={state.status === "saving"} title={state.status === "error" ? state.message : "Add this file to a knowledge base"}>
      {state.status === "saving" ? "Saving…" : state.status === "error" ? "Retry save" : "Save to knowledge"}
    </Button>
  );
}
