import type { Metadata } from "next";
import { LibraryRedirect } from "@/components/sibyl/LibraryRedirect";

export const metadata: Metadata = {
  title: "Sibyl Slides",
};

/** Unknown engine routes never show "page not found": back to the deck library. */
export default function NotFound() {
  return <LibraryRedirect appUrl={process.env.SIBYL_APP_URL?.trim() ?? ""} />;
}
