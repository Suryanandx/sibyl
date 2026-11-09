/**
 * Monitors ("keep an eye on it"); see docs/monitors.md.
 */
import { createMonitorTools } from "./tools.js";
import { MonitorService, type MonitorServiceOptions } from "./service.js";

export * from "./ask.js";
export * from "./engine.js";
export * from "./http.js";
export * from "./items.js";
export * from "./records.js";
export * from "./service.js";
export * from "./sources.js";
export * from "./task.js";
export * from "./tools.js";
export * from "./ws.js";

/**
 * Create the service, register its chat tools and run its checks on the
 * routine scheduler (when routines are installed). SIBYL_MONITORS=false
 * turns monitors off (returns undefined).
 */
export function installMonitors(options: MonitorServiceOptions): MonitorService | undefined {
  if (/^(false|0|no|off)$/i.test(options.env.SIBYL_MONITORS?.trim() ?? "")) {
    options.log("monitors.disabled", {});
    return undefined;
  }
  const service = new MonitorService(options);
  for (const tool of createMonitorTools(service)) options.tools.register(tool);
  options.routines?.addJobType(service.jobType);
  return service;
}
