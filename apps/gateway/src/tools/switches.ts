/**
 * Per-tool on/off switches, persisted in the store's kv under `tools.disabled`
 * (a list of tool names) for the owner.
 */
import type { Store, ToolRegistry } from "@open-gpt-live/core";

export const DISABLED_TOOLS_KEY = "tools.disabled";

export async function loadDisabledTools(store: Store, ownerId: string): Promise<string[]> {
  const value = await store.kv.get<unknown>(ownerId, DISABLED_TOOLS_KEY);
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Apply persisted switches to the registry (call after every tool is registered). */
export async function applyToolSwitches(registry: ToolRegistry, store: Store, ownerId: string): Promise<string[]> {
  const disabled = await loadDisabledTools(store, ownerId);
  for (const name of disabled) registry.setEnabled(name, false);
  return disabled;
}

/** Flip one tool on/off and persist it (for the settings UI). */
export async function setToolEnabled(
  registry: ToolRegistry,
  store: Store,
  ownerId: string,
  name: string,
  enabled: boolean
): Promise<void> {
  const disabled = new Set(await loadDisabledTools(store, ownerId));
  if (enabled) disabled.delete(name);
  else disabled.add(name);
  registry.setEnabled(name, enabled);
  await store.kv.set(ownerId, DISABLED_TOOLS_KEY, [...disabled].sort());
}
