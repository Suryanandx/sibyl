"use client";

import { useEffect, useState } from "react";
import type { AgentInput, AgentTemplateView, AgentView, ModelCatalog } from "@open-gpt-live/protocol";
import { AgentAvatar } from "./AgentAvatar";
import { AgentEditor, blankAgent, type AgentAccessOptions } from "./AgentEditor";
import { AgentProposals } from "./AgentProposals";
import type { AgentsApi } from "./useAgents";
import { paths } from "../../lib/routes";
import { Badge, Button, ButtonLink, Card, EmptyState, Muted, Notice, SectionTitle, Toolbar } from "../../components/ui";
import styles from "./agents.module.css";

type View = { kind: "grid" } | { kind: "edit"; draft: AgentInput; agentId?: string } | { kind: "learning" };

const AUTONOMY_LABEL: Record<AgentView["autonomy"], string> = {
  ask_first: "Asks first",
  act_then_tell: "Acts, then tells",
  autonomous: "Autonomous"
};

/**
 * The Agents screen: your agents with live avatars, starter templates, the
 * editor, and the review of what they learned.
 */
export function AgentsScreen({
  agents,
  catalog,
  access,
  onChat
}: {
  /** From useAgents(client); share it with the composer's AgentPicker. */
  agents: AgentsApi;
  catalog?: ModelCatalog | null;
  /** What can be picked under "Controlled" access. */
  access?: AgentAccessOptions;
  /** "Chat" on a card: select the agent and go to the chat. */
  onChat?(agentId: string): void;
}) {
  const [view, setView] = useState<View>({ kind: "grid" });
  const editing = view.kind === "edit" && view.agentId ? agents.agents.find((a) => a.id === view.agentId) : undefined;
  const editingId = view.kind === "edit" ? view.agentId : undefined;
  const { open } = agents;

  useEffect(() => {
    if (editingId) open(editingId);
  }, [editingId, open]);

  useEffect(() => {
    if (view.kind === "learning") for (const agent of agents.agents) if (agent.canEdit) open(agent.id);
    // Load once when the review opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.kind]);

  if (view.kind === "edit") {
    return (
      <AgentEditor
        key={view.agentId ?? "new"}
        initial={view.draft}
        {...(editing ? { existing: editing } : {})}
        catalog={catalog ?? null}
        {...(access ? { access } : {})}
        canShare={agents.canShare}
        {...(view.agentId ? { memory: agents.memory[view.agentId] ?? [] } : {})}
        onSave={async (input) => {
          await agents.save(view.agentId ? { ...input, id: view.agentId } : input);
          setView({ kind: "grid" });
        }}
        onCancel={() => setView({ kind: "grid" })}
        {...(view.agentId
          ? {
              onDelete: () => {
                agents.remove(view.agentId!);
                setView({ kind: "grid" });
              },
              onSaveMemory: (text: string, itemId?: string) => agents.saveMemory(view.agentId!, text, itemId),
              onDeleteMemory: (itemId: string) => agents.deleteMemory(view.agentId!, itemId),
              onReviewLearning: () => setView({ kind: "learning" })
            }
          : {})}
        onPreviewVoice={agents.previewVoice}
      />
    );
  }

  if (view.kind === "learning") {
    return (
      <AgentProposals proposals={Object.values(agents.proposals).flat()} agents={agents.agents} onDecide={agents.decide} onClose={() => setView({ kind: "grid" })} />
    );
  }

  const waiting = agents.agents.reduce((sum, a) => sum + a.pendingProposals, 0);
  const fromTemplate = (template: AgentTemplateView): AgentInput => ({
    name: template.name,
    description: template.description,
    avatar: template.avatar,
    instructions: template.instructions,
    access: { mode: "inherit" },
    autonomy: template.autonomy,
    learning: template.learning,
    visibility: "private",
    templateId: template.id
  });
  const toInput = (agent: AgentView): AgentInput => ({
    name: agent.name,
    description: agent.description,
    avatar: agent.avatar,
    ...(agent.voice ? { voice: agent.voice } : {}),
    instructions: agent.instructions,
    ...(agent.modelPreset ? { modelPreset: agent.modelPreset } : {}),
    access: agent.access,
    autonomy: agent.autonomy,
    learning: agent.learning,
    ...(agent.budget ? { budget: agent.budget } : {}),
    ...(agent.computer ? { computer: agent.computer } : {}),
    visibility: agent.visibility,
    ...(agent.templateId ? { templateId: agent.templateId } : {})
  });

  return (
    <>
      <Toolbar
        end={
          <>
            {waiting ? (
              <Button onClick={() => setView({ kind: "learning" })}>
                Review learning <Badge tone="accent">{waiting}</Badge>
              </Button>
            ) : null}
            {agents.canCreate ? (
              <Button variant="primary" onClick={() => setView({ kind: "edit", draft: blankAgent() })}>
                New agent
              </Button>
            ) : null}
          </>
        }
      />
      {agents.error ? (
        <Notice
          tone="danger"
          className={styles.notice}
          action={
            <Button variant="link" size="sm" onClick={agents.clearError}>
              Dismiss
            </Button>
          }
        >
          {agents.error}
        </Notice>
      ) : null}

      {!agents.loaded ? (
        <Muted>Loading agents…</Muted>
      ) : (
        <>
          {agents.agents.length ? (
            <ul className={styles.grid} aria-label="Your agents">
              {agents.agents.map((agent) => (
                <AgentCard
                  key={agent.id}
                  agent={agent}
                  selected={agents.selectedAgentId === agent.id}
                  onOpen={() => setView({ kind: "edit", draft: toInput(agent), agentId: agent.id })}
                  {...(onChat
                    ? {
                        onChat: () => {
                          agents.select(agent.id);
                          onChat(agent.id);
                        }
                      }
                    : {})}
                />
              ))}
            </ul>
          ) : (
            <EmptyState title="Make your first agent" compact>
              <p>
                {agents.canCreate
                  ? "An agent is a helper with its own job, voice and look. Start from a template below, or a blank one."
                  : "No agents are shared with you yet. Ask a workspace admin."}
              </p>
            </EmptyState>
          )}

          {agents.canCreate && agents.templates.length ? (
            <section aria-label="Start from a template">
              <SectionTitle className={styles.templatesTitle}>Start from a template</SectionTitle>
              <ul className={styles.grid}>
                {agents.templates.map((template) => (
                  <Card as="li" key={template.id} className={`${styles.agentCard} ${styles.template}`}>
                    <button type="button" className={styles.cardMain} onClick={() => setView({ kind: "edit", draft: fromTemplate(template) })}>
                      <HoverAvatar avatar={template.avatar} />
                      <span className={styles.cardText}>
                        <strong>{template.name}</strong>
                        <small>{template.description}</small>
                      </span>
                    </button>
                  </Card>
                ))}
                <Card as="li" className={`${styles.agentCard} ${styles.template}`}>
                  <button type="button" className={styles.cardMain} onClick={() => setView({ kind: "edit", draft: blankAgent() })}>
                    <span className={styles.blankPlus} aria-hidden>
                      +
                    </span>
                    <span className={styles.cardText}>
                      <strong>Blank agent</strong>
                      <small>Start from scratch.</small>
                    </span>
                  </button>
                </Card>
              </ul>
            </section>
          ) : null}
        </>
      )}
    </>
  );
}

function HoverAvatar({ avatar }: { avatar: AgentView["avatar"] }) {
  const [hover, setHover] = useState(false);
  return (
    <span onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} onFocus={() => setHover(true)} onBlur={() => setHover(false)}>
      <AgentAvatar avatar={avatar} size={56} mood={hover ? "happy" : "idle"} />
    </span>
  );
}

function AgentCard({ agent, selected, onOpen, onChat }: { agent: AgentView; selected: boolean; onOpen(): void; onChat?(): void }) {
  return (
    <Card as="li" className={selected ? `${styles.agentCard} ${styles.selected}` : styles.agentCard}>
      <button type="button" className={styles.cardMain} onClick={onOpen} aria-label={`${agent.canEdit ? "Edit" : "View"} ${agent.name}`}>
        <HoverAvatar avatar={agent.avatar} />
        <span className={styles.cardText}>
          <strong>{agent.name}</strong>
          <small>{agent.description || "No description yet."}</small>
          <span className={styles.tags}>
            <Badge>{AUTONOMY_LABEL[agent.autonomy]}</Badge>
            <Badge>{agent.access.mode === "inherit" ? "Everything I can use" : "Controlled access"}</Badge>
            {agent.visibility === "workspace" ? <Badge>Shared</Badge> : null}
            {agent.computer?.enabled ? <Badge>Has a computer</Badge> : null}
            {agent.pendingProposals ? <Badge tone="accent">{agent.pendingProposals} to review</Badge> : null}
          </span>
        </span>
      </button>
      {onChat || agent.computer?.enabled ? (
        <span className={styles.cardActions}>
          {onChat ? (
            <Button size="sm" onClick={onChat}>
              Chat
            </Button>
          ) : null}
          {agent.computer?.enabled ? (
            <ButtonLink size="sm" variant="ghost" href={paths.agentComputer(agent.id)}>
              Computer
            </ButtonLink>
          ) : null}
        </span>
      ) : null}
    </Card>
  );
}
