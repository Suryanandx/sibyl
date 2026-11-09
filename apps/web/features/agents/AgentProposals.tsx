"use client";

import { useState } from "react";
import type { AgentView, SkillDraftView, SkillProposalView } from "@open-gpt-live/protocol";
import { AgentAvatar } from "./AgentAvatar";
import { Button, Card, EmptyState, Field, Input, Muted, Row, SectionTitle, Stack, Tabs, Textarea, Toolbar } from "../../components/ui";
import styles from "./agents.module.css";

const STATUS: Record<SkillProposalView["status"], string> = {
  pending: "Waiting for you",
  applied: "In use",
  rejected: "Rejected",
  rolled_back: "Rolled back"
};

/**
 * What agents learned: new skills, edits to skills and memories. Pending ones
 * can be approved (as is or edited) or rejected; applied ones rolled back.
 */
export function AgentProposals({
  proposals,
  agents,
  onDecide,
  onClose
}: {
  proposals: SkillProposalView[];
  agents: AgentView[];
  onDecide(proposalId: string, decision: "approve" | "reject" | "rollback", edits?: { skill?: SkillDraftView; memory?: string }): void;
  onClose?(): void;
}) {
  const [filter, setFilter] = useState<"pending" | "all">("pending");
  const byId = new Map(agents.map((a) => [a.id, a]));
  const shown = proposals.filter((p) => filter === "all" || p.status === "pending").sort((a, b) => b.createdAt - a.createdAt);

  return (
    <section className={styles.proposals} aria-label="What your agents learned">
      <Toolbar
        start={
          <>
            {onClose ? (
              <Button variant="link" onClick={onClose}>
                ← Back
              </Button>
            ) : null}
            <SectionTitle>What your agents learned</SectionTitle>
          </>
        }
        end={
          <Tabs
            label="Show"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "pending", label: "Waiting" },
              { value: "all", label: "History" }
            ]}
          />
        }
      />
      {shown.length === 0 ? (
        <EmptyState title={filter === "pending" ? "Nothing waiting" : "Nothing learned yet"} compact>
          {filter === "pending" ? <p>Agents suggest skills and memories after multi-step tasks.</p> : null}
        </EmptyState>
      ) : (
        <ul className={styles.proposalList}>
          {shown.map((proposal) => (
            <ProposalCard key={proposal.id} proposal={proposal} agent={byId.get(proposal.agentId)} onDecide={onDecide} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ProposalCard({
  proposal,
  agent,
  onDecide
}: {
  proposal: SkillProposalView;
  agent: AgentView | undefined;
  onDecide(proposalId: string, decision: "approve" | "reject" | "rollback", edits?: { skill?: SkillDraftView; memory?: string }): void;
}) {
  const [editing, setEditing] = useState(false);
  const [skill, setSkill] = useState<SkillDraftView | undefined>(proposal.skill);
  const [memory, setMemory] = useState(proposal.memory ?? "");
  const canEdit = agent?.canEdit ?? false;
  const title =
    proposal.kind === "memory" ? "Remember" : proposal.kind === "edit" ? `Improve skill “${proposal.skill?.title ?? proposal.skill?.name}”` : `New skill “${proposal.skill?.title ?? proposal.skill?.name}”`;

  return (
    <Card as="li" className={proposal.status === "pending" ? styles.pending : undefined}>
      <div className={styles.proposalHead}>
        {agent ? <AgentAvatar avatar={agent.avatar} size={32} mood={proposal.status === "pending" ? "thinking" : "idle"} /> : null}
        <div>
          <strong>{title}</strong>
          <Muted as="span">
            {agent?.name ?? "Agent"} · {STATUS[proposal.status]} · {new Date(proposal.createdAt).toLocaleDateString()}
          </Muted>
        </div>
      </div>
      <Muted>{proposal.rationale}</Muted>

      {proposal.kind === "memory" ? (
        editing ? (
          <Input value={memory} maxLength={600} aria-label="Memory" onChange={(e) => setMemory(e.target.value)} />
        ) : (
          <blockquote className={styles.proposalMemory}>{proposal.memory}</blockquote>
        )
      ) : skill ? (
        editing ? (
          <Stack gap={10}>
            <Field label="Title">
              <Input value={skill.title} maxLength={120} onChange={(e) => setSkill({ ...skill, title: e.target.value })} />
            </Field>
            <Field label="When to use it">
              <Input value={skill.description} maxLength={500} onChange={(e) => setSkill({ ...skill, description: e.target.value })} />
            </Field>
            <Field label="Steps (Markdown)">
              <Textarea mono value={skill.instructions} maxLength={12000} onChange={(e) => setSkill({ ...skill, instructions: e.target.value })} />
            </Field>
          </Stack>
        ) : (
          <div className={proposal.currentSkill ? `${styles.proposalBody} ${styles.diff}` : styles.proposalBody}>
            {proposal.currentSkill ? (
              <div>
                <Muted as="span">Now</Muted>
                <pre>{proposal.currentSkill.instructions}</pre>
              </div>
            ) : null}
            <div>
              <Muted as="span">{proposal.currentSkill ? "Suggested" : skill.description}</Muted>
              <pre>{skill.instructions}</pre>
            </div>
          </div>
        )
      ) : null}

      {canEdit ? (
        <Row>
          {proposal.status === "pending" ? (
            <>
              <Button
                variant="primary"
                onClick={() => onDecide(proposal.id, "approve", editing ? (proposal.kind === "memory" ? { memory } : skill ? { skill } : undefined) : undefined)}
              >
                {editing ? "Save & approve" : "Approve"}
              </Button>
              <Button onClick={() => setEditing((v) => !v)}>{editing ? "Cancel edit" : "Edit"}</Button>
              <Button onClick={() => onDecide(proposal.id, "reject")}>Reject</Button>
            </>
          ) : proposal.status === "applied" ? (
            <Button onClick={() => onDecide(proposal.id, "rollback")}>Roll back</Button>
          ) : null}
        </Row>
      ) : null}
    </Card>
  );
}
