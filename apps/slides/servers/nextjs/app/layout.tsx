import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import "./globals.css";
import "./sibyl.css";
import "katex/dist/katex.min.css";
import { Providers } from "./providers";
import { Toaster } from "@/components/ui/sonner";
import TailwindBrowserRuntime from "@/components/runtime/TailwindBrowserRuntime";
import { SessionBootstrap } from "@/components/sibyl/SessionBootstrap";
import { SibylShell } from "@/components/sibyl/SibylShell";
import { OwnerSignIn } from "@/components/sibyl/OwnerSignIn";
import {
  OWNER_TOKEN_COOKIE,
  ownerLoginRequired,
  ownerTokenMatches,
} from "@/lib/sibyl-owner-auth";

export const metadata: Metadata = {
  title: "Sibyl Slides",
  description: "Make and edit slide decks with Sibyl.",
  icons: {
    icon: [{ url: "/slides/brand/sibyl-mark.png", type: "image/png" }],
    apple: [{ url: "/slides/brand/sibyl-mark.png" }],
  },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "var(--text-3)" },
    { media: "(prefers-color-scheme: dark)", color: "var(--text)" },
  ],
};

// Same theme preference as the Sibyl chat ("sibyl.theme"), applied before paint.
const themeScript = `try{var t=localStorage.getItem("sibyl.theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t;else document.documentElement.dataset.theme=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}catch(e){}`;

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  let signedIn = true;
  if (ownerLoginRequired()) {
    const jar = await cookies();
    const token = jar.get(OWNER_TOKEN_COOKIE)?.value;
    signedIn = Boolean(token) && ownerTokenMatches(token);
  }

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="antialiased">
        <SessionBootstrap />
        {signedIn ? (
          <Providers>
            <SibylShell appUrl={process.env.SIBYL_APP_URL?.trim() ?? ""}>{children}</SibylShell>
          </Providers>
        ) : (
          <OwnerSignIn appUrl={process.env.SIBYL_APP_URL?.trim() ?? ""} />
        )}
        {signedIn ? <TailwindBrowserRuntime /> : null}
        <Toaster position="top-center" />
      </body>
    </html>
  );
}
