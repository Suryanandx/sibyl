/**
 * Enterprise connector modules — Sibyl Enterprise.
 *
 * Copyright (c) Sibyl contributors. Licensed under the Sibyl Enterprise
 * License (ee/LICENSE), NOT the MIT licence of the rest of the repository.
 *
 * Each connector installs only when the licence enables its feature; it then
 * adds itself to the open-source connector catalogue, which turns its
 * actions into brain tools and shows it on the Integrations screen. Without
 * the licence nothing here runs and the app shows the card as "Enterprise".
 */
import type { EnterpriseModule } from "../../../packages/core/src/features";
import { registerConnector } from "../../../apps/gateway/src/connectors/catalog";
import type { ConnectorDefinition } from "../../../apps/gateway/src/connectors/types";
import { hubspotConnector } from "./hubspot";
import { salesforceConnector } from "./salesforce";

function connectorModule(id: string, definition: ConnectorDefinition): EnterpriseModule {
  if (!definition.feature) throw new Error(`${definition.id} has no licence feature`);
  return {
    id,
    feature: definition.feature,
    install(ctx) {
      const unregister = registerConnector(definition);
      ctx.log("enterprise.connector_installed", { connector: definition.id, actions: definition.actions.length });
      return { close: unregister };
    }
  };
}

export const connectorModules: EnterpriseModule[] = [
  connectorModule("connector-hubspot", hubspotConnector),
  connectorModule("connector-salesforce", salesforceConnector)
];

export { hubspotConnector, salesforceConnector };
