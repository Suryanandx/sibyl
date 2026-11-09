/**
 * The connector catalogue: which connectors this gateway offers.
 *
 * Google, Microsoft and Slack register at start-up (open source). Enterprise
 * connectors (HubSpot, Salesforce) live in `ee/gateway/connectors` and call
 * `registerConnector()` from their enterprise module's `install()` — which
 * only runs when the licence enables their feature. Open-source code never
 * imports them; it only knows their names (ENTERPRISE_CONNECTORS) so the
 * app can show them as "Enterprise".
 *
 * This file has no runtime imports so enterprise code can depend on it
 * without pulling gateway internals.
 */
import type { ConnectorDefinition } from "./types.js";

/** Enterprise connectors the open-source app can name (cards shown as "Enterprise"). */
export const ENTERPRISE_CONNECTORS = [
  {
    id: "hubspot",
    name: "HubSpot",
    vendor: "HubSpot",
    feature: "connector_hubspot",
    description: "Search, read, create and update HubSpot contacts, companies and deals; add notes and associations."
  },
  {
    id: "salesforce",
    name: "Salesforce",
    vendor: "Salesforce",
    feature: "connector_salesforce",
    description: "Run SOQL queries, read, create and update records, and log calls and tasks in Salesforce."
  }
] as const;

type Listener = () => void;

const definitions = new Map<string, ConnectorDefinition>();
const listeners = new Set<Listener>();

/** Add a connector. Returns a function that removes it again. */
export function registerConnector(definition: ConnectorDefinition): () => void {
  if (!/^[a-z][a-z0-9]{1,23}$/.test(definition.id)) throw new Error(`invalid connector id "${definition.id}"`);
  if (definitions.has(definition.id)) throw new Error(`connector "${definition.id}" is already registered`);
  const groups = new Set(definition.groups.map((group) => group.id));
  const names = new Set<string>();
  for (const action of definition.actions) {
    if (!groups.has(action.group)) throw new Error(`${definition.id}_${action.name}: unknown group "${action.group}"`);
    if (names.has(action.name)) throw new Error(`${definition.id}_${action.name} is defined twice`);
    names.add(action.name);
  }
  definitions.set(definition.id, definition);
  emit();
  return () => {
    if (definitions.get(definition.id) === definition) {
      definitions.delete(definition.id);
      emit();
    }
  };
}

export function getConnector(id: string): ConnectorDefinition | undefined {
  return definitions.get(id);
}

export function listConnectors(): ConnectorDefinition[] {
  return [...definitions.values()];
}

/** Called after any registration change. Returns an unsubscribe. */
export function onConnectorsChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

function emit(): void {
  for (const listener of listeners) listener();
}
