#!/usr/bin/env node
/*
 * Sibyl Slides launcher.
 *
 * Starts the deck engine (FastAPI, :8000) and the Sibyl Slides web app
 * (Next.js under basePath /slides, :3100). Used by `pnpm slides:dev` and by
 * the container (Dockerfile.slides).
 *
 *   node start.mjs           production (standalone Next.js build if present)
 *   node start.mjs --dev     development (next dev, uvicorn --reload)
 *
 * Environment (see apps/slides/API.md for the full list):
 *   OPENROUTER_API_KEY, SIBYL_SLIDES_MODEL, SIBYL_SLIDES_IMAGE_PROVIDER,
 *   SIBYL_OWNER_TOKEN, APP_DATA_DIRECTORY, SIBYL_SLIDES_API_PORT,
 *   SIBYL_SLIDES_WEB_PORT, SIBYL_SLIDES_HOST.
 *
 * Derived from Presenton's start.js (Apache-2.0); modified by Sibyl contributors.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const fastapiDir = join(root, "servers/fastapi");
const nextjsDir = join(root, "servers/nextjs");
const isDev = process.argv.includes("--dev");

/** Load the repo-root .env (dev convenience) without overriding real env vars. */
function loadDotenv() {
  const candidates = [
    process.env.OPEN_GPT_LIVE_ENV_FILE,
    resolve(root, "../../.env"),
    resolve(process.cwd(), ".env"),
  ].filter(Boolean);
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).replace(/^export\s+/, "").trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
    return file;
  }
  return null;
}

loadDotenv();

const apiPort = Number(process.env.SIBYL_SLIDES_API_PORT || 8000);
const webPort = Number(process.env.SIBYL_SLIDES_WEB_PORT || 3100);
// Loopback in development; the container sets SIBYL_SLIDES_HOST=0.0.0.0.
const host = process.env.SIBYL_SLIDES_HOST || "127.0.0.1";
const basePath = "/slides";

const appData =
  process.env.APP_DATA_DIRECTORY || resolve(root, "data");
for (const dir of ["", "exports", "images", "uploads", "fonts", "templates", "pptx-to-html", "pptx-to-json", "tmp"]) {
  mkdirSync(join(appData, dir), { recursive: true });
}

const env = {
  ...process.env,
  APP_DATA_DIRECTORY: appData,
  TEMP_DIRECTORY: process.env.TEMP_DIRECTORY || join(appData, "tmp"),
  // Outside TEMP_DIRECTORY: the engine empties that directory on start.
  PUPPETEER_CACHE_DIR: process.env.PUPPETEER_CACHE_DIR || join(appData, "puppeteer-cache"),
  USER_CONFIG_PATH: process.env.USER_CONFIG_PATH || join(appData, "userConfig.json"),
  // Presenton accounts are replaced by the Sibyl owner token.
  DISABLE_AUTH: "true",
  SIBYL_SLIDES_API_HOST: host,
  SIBYL_SLIDES_WEB_PORT: String(webPort),
  // Next.js server → FastAPI over loopback.
  FAST_API_INTERNAL_URL: process.env.FAST_API_INTERNAL_URL || `http://127.0.0.1:${apiPort}`,
  // Headless export renders the web app's /slides/pdf-maker page.
  NEXT_PUBLIC_URL: process.env.NEXT_PUBLIC_URL || `http://127.0.0.1:${webPort}${basePath}`,
  PRESENTON_APP_ROOT: root,
  // The Sibyl app (chat, /library/slides); editor links go there when the
  // editor is opened directly on this origin.
  SIBYL_APP_URL: process.env.SIBYL_APP_URL || "http://localhost:3000",
  EXPORT_PACKAGE_ROOT: process.env.EXPORT_PACKAGE_ROOT || join(root, "presentation-export"),
  // No telemetry from any bundled component.
  NEXT_TELEMETRY_DISABLED: "1",
  MEM0_TELEMETRY: "False",
  HF_HUB_DISABLE_TELEMETRY: "1",
  ANONYMIZED_TELEMETRY: "False",
  DO_NOT_TRACK: "1",
  START_OLLAMA: "false",
};

function pythonExecutable() {
  if (process.env.SIBYL_SLIDES_PYTHON) return process.env.SIBYL_SLIDES_PYTHON;
  const venv = join(fastapiDir, ".venv/bin/python");
  return existsSync(venv) ? venv : "python";
}

const children = new Set();
let stopping = false;

function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 500).unref();
}
process.once("SIGINT", () => stop(0));
process.once("SIGTERM", () => stop(0));

function run(name, command, args, options) {
  const child = spawn(command, args, { stdio: "inherit", ...options });
  children.add(child);
  child.on("error", (error) => {
    console.error(`[slides] ${name} failed to start:`, error.message);
    stop(1);
  });
  child.on("exit", (code, signal) => {
    children.delete(child);
    if (stopping) return;
    console.error(`[slides] ${name} exited (${signal ?? code}); stopping.`);
    stop(typeof code === "number" && code !== 0 ? code : 1);
  });
  return child;
}

run(
  "engine (FastAPI)",
  pythonExecutable(),
  ["server.py", "--port", String(apiPort), "--reload", process.env.SIBYL_SLIDES_RELOAD === "true" ? "true" : "false"],
  { cwd: fastapiDir, env }
);

const standalone = join(nextjsDir, "server.js");
if (!isDev && existsSync(standalone)) {
  run("web (Next.js)", process.execPath, [standalone], {
    cwd: nextjsDir,
    env: { ...env, NODE_ENV: "production", HOSTNAME: host, PORT: String(webPort) },
  });
} else {
  const nextCli = join(nextjsDir, "node_modules/next/dist/bin/next");
  if (!existsSync(nextCli)) {
    console.error(
      "[slides] Next.js is not installed. Run `npm ci` in apps/slides/servers/nextjs first."
    );
    stop(1);
  } else {
    run(
      "web (Next.js)",
      process.execPath,
      [nextCli, isDev ? "dev" : "start", ...(isDev ? ["--webpack"] : []), "-H", host, "-p", String(webPort)],
      { cwd: nextjsDir, env }
    );
  }
}

console.log(
  `[slides] engine http://${host}:${apiPort}  web http://${host}:${webPort}${basePath}  data ${appData}`
);
