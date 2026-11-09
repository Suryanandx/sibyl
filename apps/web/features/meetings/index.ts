/**
 * Meetings (docs/meetings.md): the list (/meetings), a meeting's page
 * (/meetings/<id>), its room (/call/<id>) and the guest link (/join/<id>).
 */
import { meetingsApi } from "./api";

export { MeetingsScreen } from "./MeetingsScreen";
export { MeetingPage } from "./MeetingPage";
export { MeetingRoom } from "./MeetingRoom";
export { GuestJoin } from "./GuestJoin";
export { meetingsApi } from "./api";

/** The chat's Meet button: a meeting started now; replies and approvals land in this chat. */
export async function startMeetingFromChat(title?: string): Promise<string> {
  const meeting = await meetingsApi.create(title ? { title: title.slice(0, 140) } : {});
  return meeting.id;
}
