import { GuestJoin } from "../../../features/meetings";

// /join/<meetingId>?k=…: the guest link; no account needed, the host admits guests (docs/meetings.md).
export const metadata = { title: "Join a meeting · Sibyl" };

export default function JoinPage({ params }: { params: { id: string } }) {
  return <GuestJoin meetingId={decodeURIComponent(params.id)} />;
}
