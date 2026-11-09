/**
 * Presence: agents in Slack and Microsoft Teams, and Slack/Teams as
 * notification channels. See docs/slack-and-teams.md.
 */
import { PresenceService, type PresenceServiceOptions } from "./service.js";

export * from "./http.js";
export * from "./inbound.js";
export * from "./service.js";
export * from "./slack.js";
export * from "./store.js";
export * from "./teams.js";
export * from "./turn.js";

/**
 * Create the service (after connectors, agents and notifications), register
 * its notifiers and its job on the routine scheduler. SIBYL_PRESENCE=false
 * turns it off (returns undefined).
 */
export async function installPresence(options: PresenceServiceOptions): Promise<PresenceService | undefined> {
  if (/^(false|0|no|off)$/i.test(options.env.SIBYL_PRESENCE?.trim() ?? "")) {
    options.log("presence.disabled", {});
    return undefined;
  }
  const service = await new PresenceService(options).init();
  options.log("presence.installed", { bindings: service.records.bindings().length });
  return service;
}
