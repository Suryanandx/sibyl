import type { ComputerStatusView } from "@open-gpt-live/protocol";

/** Tool names of the computer tools (they all start with this). */
export const COMPUTER_TOOL_PREFIX = "computer_";

export function isComputerTool(toolName: string | undefined): boolean {
  return Boolean(toolName?.startsWith(COMPUTER_TOOL_PREFIX));
}

/** One short status line: "Running · example.com", "Paused", … */
export function stateLabel(status: Pick<ComputerStatusView, "state"> | null | undefined): string {
  switch (status?.state) {
    case "running":
      return "Running";
    case "starting":
      return "Starting…";
    case "paused":
      return "Paused";
    case "unavailable":
      return "Unavailable";
    case "disabled":
      return "Turned off";
    case "off":
      return "Off";
    default:
      return "Connecting…";
  }
}

/** "12 of 60 min used today". */
export function usageLabel(status: Pick<ComputerStatusView, "usedSecondsToday" | "dailyMinutes">): string {
  const used = Math.floor(status.usedSecondsToday / 60);
  return `${used} of ${status.dailyMinutes} min used today`;
}

/** The host of a URL for compact display (the URL itself when it doesn't parse). */
export function shortUrl(url: string | undefined): string {
  if (!url || url === "about:blank") return "";
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return url;
  }
}

export function timeOf(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
