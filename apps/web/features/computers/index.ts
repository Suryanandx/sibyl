/**
 * Agent computers (wave C): an agent's own sandboxed browser.
 *
 *   <ComputerSettings value={draft.computer} onChange={…} />      // in the agent editor
 *   <AgentComputerScreen agentId={id} />                         // route /agents/<id>/computer
 *   <ComputerThumbnail agentId={id} agentName={name} />          // in a chat turn that used it
 *
 * Everything goes over the shared socket (computer.* messages); see docs/agent-computers.md.
 */
export { AgentComputerScreen } from "./AgentComputerScreen";
export { ComputerSettings } from "./ComputerSettings";
export { ComputerThumbnail } from "./ComputerThumbnail";
export { ComputerView } from "./ComputerView";
export { isComputerTool } from "./format";
export { useComputer, useComputersInfo } from "./useComputer";
