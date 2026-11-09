import "./globals.css";
import { AppShell } from "../components/AppFrame";
import { GatewayProvider } from "../lib/gateway";

export const metadata = {
  title: "Sibyl",
  description: "Talk naturally. Sibyl listens, thinks, and shows you."
};

export const viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F7F7F5" },
    { media: "(prefers-color-scheme: dark)", color: "#121413" }
  ]
};

// Apply the saved theme before first paint to avoid a flash. Also turn off
// @openuidev/react-lang's development auto-mount of the third-party OpenUI
// devtools overlay (Sibyl has its own Visual inspector, see
// components/VisualInspector.tsx); next.config.mjs aliases the package away too.
const themeScript = `globalThis[Symbol.for("openui.devtools.autoMount")]=true;try{var t=localStorage.getItem("sibyl.theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t;else document.documentElement.dataset.theme=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}catch(e){}`;

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        {/* One gateway connection for every screen; the frame (rail + content) around them. */}
        <GatewayProvider>
          <AppShell>{children}</AppShell>
        </GatewayProvider>
      </body>
    </html>
  );
}
