import { MeetingRoom } from "../../../features/meetings";

// /call/<meetingId>: a meeting's room with people and agents (docs/meetings.md).
export const metadata = { title: "Meeting · Sibyl" };

export default function CallPage({ params }: { params: { id: string } }) {
  return <MeetingRoom meetingId={decodeURIComponent(params.id)} />;
}
