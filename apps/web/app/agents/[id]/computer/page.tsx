import { AgentComputerScreen } from "../../../../features/computers";

export const metadata = { title: "Computer · Agents · Sibyl" };

export default function AgentComputerPage({ params }: { params: { id: string } }) {
  return <AgentComputerScreen agentId={params.id} />;
}
