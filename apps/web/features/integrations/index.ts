/**
 * Integrations feature (v0.4): connectors for Google Workspace and
 * Microsoft 365 (open source) and HubSpot and Salesforce (Enterprise).
 *
 * Mount `<IntegrationsScreen />` on the `/integrations` screen. Pass `live`
 * (gateway socket hooks for `integrations.*` messages) for pushed status and
 * `mcp` (the ConnectionsPanel hooks) for the Advanced → custom connector
 * section; both are optional.
 */
export { IntegrationsScreen, type IntegrationsScreenProps, type IntegrationsLiveSocket, type IntegrationsMcpHooks } from "./IntegrationsScreen";
export { ConnectorPanel } from "./ConnectorPanel";
export { ConnectorGlyph } from "./glyphs";
export * as integrationsApi from "./api";
