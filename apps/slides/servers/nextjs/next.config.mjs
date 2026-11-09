import path from "node:path";
import { fileURLToPath } from "node:url";

const nextjsRoot = path.dirname(fileURLToPath(import.meta.url));

// Sibyl Slides is served under the Sibyl origin at /slides (the Sibyl web app
// proxies /slides/* here). Every page, asset and API path lives under it.
const basePath = "/slides";

const nextConfig = {
  basePath,
  reactStrictMode: false,
  distDir: ".next-build",
  output: "standalone",
  poweredByHeader: false,
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath,
  },
  turbopack: {
    root: nextjsRoot,
  },
  experimental: {
    // Deck generation and export requests can take minutes.
    proxyTimeout: 30 * 60 * 1000,
  },
  async headers() {
    return [
      {
        source: "/vendor/fonts/:path*",
        // Sandboxed template previews load public fonts from an opaque origin.
        headers: [{ key: "Access-Control-Allow-Origin", value: "*" }],
      },
    ];
  },
  ...(process.env.NODE_ENV !== "production"
    ? {
        allowedDevOrigins: ["127.0.0.1", "localhost"],
      }
    : {}),

  images: {
    remotePatterns: [
      { protocol: "https", hostname: "images.unsplash.com" },
      { protocol: "https", hostname: "picsum.photos" },
      { protocol: "https", hostname: "unsplash.com" },
      { protocol: "https", hostname: "img.icons8.com" },
    ],
  },
};

export default nextConfig;
