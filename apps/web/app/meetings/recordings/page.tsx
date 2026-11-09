import { Suspense } from "react";
import { RecordingsScreen } from "../../../features/recordings";

// /meetings/recordings: call and meeting recordings (Sibyl Enterprise; docs/meetings.md#recordings).
export const metadata = { title: "Recordings · Meetings · Sibyl" };

export default function RecordingsPage() {
  return (
    <Suspense>
      <RecordingsScreen />
    </Suspense>
  );
}
