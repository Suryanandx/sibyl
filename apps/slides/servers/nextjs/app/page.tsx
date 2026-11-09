import { redirect } from "next/navigation";

// Sibyl Slides opens on the deck composer; providers come from the environment.
export default function Page() {
  redirect("/upload");
}
