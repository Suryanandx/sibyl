/**
 * Agents feature (v0.4). Mount it from the app shell:
 *
 *   const agents = useAgents({ send, subscribe, connected });   // once, in the page
 *   <AgentsScreen agents={agents} catalog={catalog} access={...} onChat={...} />   // route /agents
 *   <AgentPicker agents={agents.agents} selectedAgentId={agents.selectedAgentId}
 *                onSelect={agents.select} onManage={() => go("/agents")} />          // in the composer
 *   <AgentAvatar avatar={agents.turns[requestId].avatar} mood="speaking" />       // next to replies
 *
 * Send `agentId` with `user.text` (or rely on agent.select, which also covers voice turns).
 */
export { AgentAvatar, type AvatarMood } from "./AgentAvatar";
export { AgentEditor, blankAgent, type AgentAccessOptions, type AgentEditorProps } from "./AgentEditor";
export { AgentPicker } from "./AgentPicker";
export { AgentProposals } from "./AgentProposals";
export { AgentsScreen } from "./AgentsScreen";
export { useAgents, type AgentsApi, type AgentsClient, type AgentsState } from "./useAgents";
