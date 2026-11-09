import { MeetingPage } from "../../../features/meetings";

// /meetings/<id>: a meeting's notes, transcript, playback and comments (docs/meetings.md).
export const metadata = { title: "Meeting notes · Sibyl" };

export default function MeetingNotesPage({ params }: { params: { id: string } }) {
  return <MeetingPage meetingId={decodeURIComponent(params.id)} />;
}
