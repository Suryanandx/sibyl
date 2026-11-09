import Link from "next/link";

export const metadata = { title: "Not found · Sibyl" };

export default function NotFound() {
  return (
    <main className="notFound">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="notFoundMark" src="/brand/sibyl-mark.png" alt="" width={56} height={56} />
      <h1>This page isn&apos;t here</h1>
      <p>The link may be old, or the conversation was deleted.</p>
      <div className="notFoundActions">
        <Link className="darkBtn" href="/">
          Back to chat
        </Link>
        <Link className="ghostBtn" href="/library/slides">
          Open Slides
        </Link>
      </div>
    </main>
  );
}
