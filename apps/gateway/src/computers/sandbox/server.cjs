/**
 * Runs inside the agent-computer sandbox (Dockerfile.computer): launches
 * Chromium as a Playwright browser server for the gateway to connect to.
 *
 * The network policy is fixed here, at launch: every request goes through
 * the gateway's egress proxy (SIBYL_COMPUTER_PROXY, required — the browser
 * never starts without it), loopback included, and WebRTC may not send UDP
 * around the proxy. The WebSocket path is a per-container secret.
 */
"use strict";
const { chromium } = require("playwright-core");

async function main() {
  const rawProxy = process.env.SIBYL_COMPUTER_PROXY;
  const path = process.env.SIBYL_COMPUTER_PATH;
  delete process.env.SIBYL_COMPUTER_PROXY;
  if (!rawProxy || !path) {
    console.error("SIBYL_COMPUTER_PROXY and SIBYL_COMPUTER_PATH are required");
    process.exit(2);
  }
  const proxy = JSON.parse(rawProxy);
  const server = await chromium.launchServer({
    host: "0.0.0.0",
    port: 3000,
    wsPath: `/${path}`,
    headless: true,
    chromiumSandbox: false,
    proxy,
    args: ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--disable-quic"]
  });
  console.log("sandbox browser ready");
  const stop = () => {
    server.close().finally(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
