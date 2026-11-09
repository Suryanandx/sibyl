/**
 * Meetings (docs/meetings.md): calls with people and agents, a live
 * transcript, AI notes, Ask AI, action items to tasks, comments.
 *
 * Records, notes, comments and the meetings list work without LiveKit (a
 * scheduled meeting, the notes of a past one). The room needs the realtime
 * layer: when it is configured, the service attaches to it and owns its
 * call records.
 */
import type { Store, ToolRegistry, UsageMeter } from "@open-gpt-live/core";
import type { NotificationService } from "../notifications/service.js";
import type { RealtimeService } from "../realtime/service.js";
import { MeetingService } from "./service.js";

export { MeetingService, MeetingError, meetingMarkdown, type MeetingBrain, type MeetingCaller } from "./service.js";
export { handleMeetingsHttp, type MeetingsHttpOptions } from "./http.js";
export { isMeetingGuestRoute } from "./routes.js";
export { handleMeetingsMessage, type MeetingsWsContext } from "./ws.js";

export interface InstallMeetingsOptions {
  store: Store;
  tools: ToolRegistry;
  meter: UsageMeter;
  ownerId: string;
  env: NodeJS.ProcessEnv;
  log: (event: string, fields?: Record<string, unknown>) => void;
  notifications?: NotificationService;
  realtime?: RealtimeService;
}

export function installMeetings(options: InstallMeetingsOptions): MeetingService {
  const meetings = new MeetingService({
    store: options.store,
    ownerId: options.ownerId,
    meter: options.meter,
    env: options.env,
    log: options.log,
    ...(options.notifications ? { notifications: options.notifications } : {})
  });
  if (options.realtime) meetings.attach(options.realtime);
  return meetings;
}
