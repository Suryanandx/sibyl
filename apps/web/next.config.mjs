import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";

const envCandidates = [
  process.env.OPEN_GPT_LIVE_ENV_FILE,
  process.env.INIT_CWD ? resolve(process.env.INIT_CWD, ".env") : undefined,
  resolve(process.cwd(), ".env"),
  resolve(process.cwd(), "../../.env")
].filter(Boolean);

for (const path of new Set(envCandidates)) {
  if (existsSync(path)) {
    loadDotenv({ path, override: false });
    break;
  }
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  transpilePackages: ["@open-gpt-live/protocol", "@open-gpt-live/core"],
  // Sibyl Slides (apps/slides) is served under this origin at /slides: its
  // web app (Next.js, basePath /slides) runs at SIBYL_SLIDES_WEB_URL.
  async rewrites() {
    const slides = (process.env.SIBYL_SLIDES_WEB_URL || "http://localhost:3100").replace(/\/+$/, "");
    return [
      { source: "/slides", destination: `${slides}/slides` },
      { source: "/slides/:path*", destination: `${slides}/slides/:path*` }
    ];
  },
  experimental: {
    // Deck exports through /slides can take a few minutes.
    proxyTimeout: 10 * 60 * 1000
  },
  webpack(config) {
    // @openuidev/react-headless has an optional import of the Vercel AI SDK
    // ("ai") for its AI SDK stream adapter. This app streams over its own
    // WebSocket protocol, so stub it out instead of installing it.
    // @openuidev/devtools is the third-party overlay react-lang auto-mounts in
    // development; Sibyl ships its own Visual inspector instead.
    config.resolve.alias = { ...config.resolve.alias, ai: false, "@openuidev/devtools": false };
    return config;
  }
};

export default nextConfig;
