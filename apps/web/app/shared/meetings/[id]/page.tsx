import { SharedNotes } from "../../../../features/meetings";

// /shared/meetings/<id>?t=…: a meeting's notes shared by link (read-only, no account; docs/meetings.md#share-notes).
export const metadata = { title: "Meeting notes · Sibyl", robots: { index: false, follow: false } };

export default function SharedMeetingPage({ params }: { params: { id: string } }) {
  return <SharedNotes meetingId={decodeURIComponent(params.id)} />;
}
