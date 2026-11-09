"use client";

import { ScreenFrame } from "../../components/ScreenFrame";
import { ButtonLink, EmptyState } from "../../components/ui";
import { useAppSession } from "../../lib/app-session";
import { useGateway } from "../../lib/gateway";
import { paths } from "../../lib/routes";
import { ComputerView } from "./ComputerView";

/** /agents/<id>/computer: one agent's computer, live and afterwards. */
export function AgentComputerScreen({ agentId }: { agentId: string }) {
  const { agents, connected } = useGateway();
  const session = useAppSession();
  const agent = agents.agents.find((a) => a.id === agentId);
  const name = agent?.name ?? "Agent";
  return (
    <ScreenFrame
      title={`${name}'s computer`}
      subtitle="Its own browser in a sandbox. Watch it work, see each step afterwards, or stop it."
      back={{ href: paths.agents, label: "Agents" }}
      actions={<ButtonLink href={paths.agents}>All agents</ButtonLink>}
    >
      {!session.can("agents.use") ? (
        <EmptyState title="You don't have access to agents">
          <p>Ask a workspace owner or admin if you need it.</p>
        </EmptyState>
      ) : agent ? (
        <ComputerView agentId={agent.id} agentName={agent.name} />
      ) : (
        <EmptyState title={connected ? "Agent not found" : "Connecting…"} compact>
          <p>{connected ? "It may have been deleted, or it isn't shared with you." : "Loading your agents."}</p>
        </EmptyState>
      )}
    </ScreenFrame>
  );
}
