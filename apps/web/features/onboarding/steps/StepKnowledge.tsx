"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { KnowledgeBaseView, KnowledgeListResponse } from "@open-gpt-live/protocol";
import { Muted, Notice } from "../../../components/ui";
import { useAppSession } from "../../../lib/app-session";
import { errorText, gatewayRequest } from "../../../lib/gateway-http";
import { AddFiles } from "../../knowledge";
import { StepLayout } from "../OnboardingFlow";
import styles from "../onboarding.module.css";

const BASE_NAME = "Team knowledge";

/**
 * Add knowledge (optional): drop files or a folder. They go into the
 * workspace's first knowledge base; "Team knowledge" is made on the first
 * file when there is none, and searched automatically in every chat.
 */
export function StepKnowledge() {
  const session = useAppSession();
  const [list, setList] = useState<KnowledgeListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState(0);
  const creating = useRef<Promise<KnowledgeBaseView> | null>(null);
  const canEdit = session.can("knowledge.edit");

  const load = useCallback(async () => {
    try {
      setList(await gatewayRequest<KnowledgeListResponse>("/api/knowledge"));
    } catch (caught) {
      setError(errorText(caught));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const target = list?.bases.find((base) => list.autoBaseIds.includes(base.id)) ?? list?.bases[0];

  const docsPath = useCallback(async (): Promise<string> => {
    let base = target;
    if (!base) {
      creating.current ??= gatewayRequest<{ base: KnowledgeBaseView }>("/api/knowledge", { method: "POST", body: { name: BASE_NAME } }).then(async ({ base }) => {
        // Search it in every chat of this workspace (needs workspace settings; fine to skip otherwise).
        if (session.can("workspace.settings")) {
          await gatewayRequest("/api/knowledge/settings", { method: "PUT", body: { autoBaseIds: [...(list?.autoBaseIds ?? []), base.id] } }).catch(() => undefined);
        }
        return base;
      });
      base = await creating.current;
    }
    return `/api/knowledge/${encodeURIComponent(base.id)}/docs`;
  }, [target, list, session]);

  return (
    <StepLayout
      title="Add knowledge"
      lead="Give Sibyl your documents, notes or a whole folder. It answers from them and shows where each answer came from."
      hideSkip={added > 0}
      skipNote="You can add files later in Knowledge."
    >
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {!canEdit ? (
        <Muted>Adding knowledge needs edit rights in this workspace. Ask an admin.</Muted>
      ) : list ? (
        <>
          <Muted className={styles.small}>{target ? `Files go into “${target.name}”.` : `Files go into a new base, “${BASE_NAME}”.`}</Muted>
          <AddFiles
            docsPath={docsPath}
            disabled={false}
            foldFormats
            onAdded={async () => {
              setAdded((count) => count + 1);
              await load();
            }}
          />
        </>
      ) : !error ? (
        <Muted>Loading…</Muted>
      ) : null}
    </StepLayout>
  );
}
