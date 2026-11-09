/**
 * One live browser in an agent's sandbox, driven with playwright-core over
 * WebSocket: the current page, a CDP screencast for the live view, small
 * thumbnails for the timeline, and the guard that keeps read actions from
 * sending data.
 *
 * The guard: while the agent is not running an approved write action, the
 * browser may not send a form (non-GET document requests), and during and
 * just after a read action (click, type, select) it may not send data with
 * fetch/XHR either. Blocked requests are aborted before they leave the
 * browser and reported, so "send", "post" and "sign in" can only happen
 * through the write tools, which need approval.
 */
import type { Browser, BrowserContext, CDPSession, Locator, Page } from "playwright-core";
import type { Sandbox } from "./docker.js";

export const VIEWPORT = { width: 1280, height: 800 } as const;
const CONNECT_ATTEMPTS = 40;
const CONNECT_RETRY_MS = 500;
/** Read-action window in which data-sending requests are refused. */
const GUARD_SETTLE_MS = 1_500;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const DATA_TYPES = new Set(["xhr", "fetch", "eventsource", "websocket", "ping"]);

export interface Frame {
  data: string;
  width: number;
  height: number;
  at: number;
}

export interface SessionEvents {
  frame(frame: Frame): void;
  navigated(page: { url: string; title: string }): void;
  /** The browser or its sandbox went away. */
  lost(reason: string): void;
}

export type GuardMode = "idle" | "read" | "write";
type Mode = GuardMode;

/**
 * The request guard: GET/HEAD/OPTIONS always pass; an approved write action
 * may send anything; otherwise a form (non-GET document) never goes out, and
 * during a read action neither does fetch/XHR data.
 */
export function requestAllowed(mode: GuardMode, method: string, resourceType: string): boolean {
  if (SAFE_METHODS.has(method.toUpperCase()) || mode === "write") return true;
  if (resourceType === "document") return false;
  return !(mode === "read" && DATA_TYPES.has(resourceType));
}

export class BrowserSession {
  private page!: Page;
  private cdp: CDPSession | undefined;
  private mode: Mode = "idle";
  private settleTimer: NodeJS.Timeout | undefined;
  private blocked: string[] = [];
  private chain: Promise<unknown> = Promise.resolve();
  private closed = false;
  lastFrame: Frame | undefined;

  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly events: SessionEvents
  ) {}

  /** Connect to a freshly started sandbox (retries while its server starts). */
  static async open(sandbox: Sandbox, events: SessionEvents, signal?: AbortSignal): Promise<BrowserSession> {
    const { chromium } = await import("playwright-core");
    let browser: Browser | undefined;
    let lastError: unknown;
    for (let attempt = 0; attempt < CONNECT_ATTEMPTS && !browser; attempt += 1) {
      if (signal?.aborted) throw new Error("Stopped while the computer was starting.");
      try {
        browser = await chromium.connect(sandbox.endpoint, { timeout: 5_000 });
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_MS));
      }
    }
    if (!browser) throw new Error(`The computer did not start (${lastError instanceof Error ? lastError.message.split("\n")[0] : "no answer"}).`);
    const context = await browser.newContext({
      viewport: VIEWPORT,
      acceptDownloads: true,
      // Service workers would bypass the request guard below.
      serviceWorkers: "block",
      locale: "en-US"
    });
    context.setDefaultTimeout(15_000);
    context.setDefaultNavigationTimeout(30_000);
    const session = new BrowserSession(browser, context, events);
    await context.route("**/*", (route) => {
      const request = route.request();
      if (session.allows(request.method(), request.resourceType())) return route.continue().catch(() => undefined);
      session.blocked.push(`${request.method()} ${hostOf(request.url())}`);
      return route.abort("blockedbyclient").catch(() => undefined);
    });
    browser.on("disconnected", () => {
      if (!session.closed) events.lost("The computer's browser stopped.");
    });
    context.on("page", (page) => void session.adopt(page));
    await session.adopt(await context.newPage());
    return session;
  }

  private allows(method: string, type: string): boolean {
    return requestAllowed(this.mode, method, type);
  }

  /** Make `page` the current one (new tabs and popups take over the screen). */
  private async adopt(page: Page): Promise<void> {
    if (this.closed) return;
    this.page = page;
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame() && page === this.page) void this.reportNavigation();
    });
    page.on("close", () => {
      if (page !== this.page || this.closed) return;
      const open = this.context.pages();
      if (open.length) void this.adopt(open.at(-1)!);
    });
    await this.startScreencast(page).catch(() => undefined);
  }

  private async startScreencast(page: Page): Promise<void> {
    await this.cdp?.detach().catch(() => undefined);
    const cdp = await this.context.newCDPSession(page);
    this.cdp = cdp;
    cdp.on("Page.screencastFrame", (event: { data: string; sessionId: number; metadata: { deviceWidth?: number; deviceHeight?: number } }) => {
      void cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => undefined);
      const frame = { data: event.data, width: Math.round(event.metadata.deviceWidth ?? VIEWPORT.width), height: Math.round(event.metadata.deviceHeight ?? VIEWPORT.height), at: Date.now() };
      this.lastFrame = frame;
      this.events.frame(frame);
    });
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height, everyNthFrame: 1 });
  }

  private async reportNavigation(): Promise<void> {
    this.events.navigated({ url: this.url(), title: await this.page.title().catch(() => "") });
  }

  url(): string {
    return this.page?.url() ?? "about:blank";
  }

  async title(): Promise<string> {
    return this.page.title().catch(() => "");
  }

  current(): Page {
    return this.page;
  }

  /** Run actions one at a time (several runs may share the agent's computer). */
  queue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /**
   * Run a browser action under the request guard. "read": data-sending
   * requests are refused during it and for a moment after; "write" (an
   * approved action): everything is allowed until it settles. Returns the
   * requests that were refused.
   */
  async guarded<T>(mode: "read" | "write", work: () => Promise<T>): Promise<{ value: T; blocked: string[] }> {
    clearTimeout(this.settleTimer);
    this.blocked = [];
    this.mode = mode;
    try {
      const value = await work();
      await this.settle();
      return { value, blocked: [...new Set(this.blocked)] };
    } finally {
      // Late requests fired by the action are still covered for a moment.
      this.settleTimer = setTimeout(() => {
        this.mode = "idle";
      }, GUARD_SETTLE_MS);
      this.settleTimer.unref?.();
    }
  }

  /** Wait briefly for the page to settle after an action. */
  async settle(): Promise<void> {
    await this.page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined);
    await this.page.waitForLoadState("networkidle", { timeout: 2_500 }).catch(() => undefined);
  }

  /** The element an aria ref (from the last snapshot) points at. */
  element(ref: string): Locator {
    return this.page.getByRef(ref);
  }

  /** A small JPEG of the visible page for the timeline (about 320×200). */
  async thumbnail(): Promise<Buffer | undefined> {
    if (!this.cdp) return undefined;
    try {
      const scroll = await this.page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
      const shot = (await this.cdp.send("Page.captureScreenshot", {
        format: "jpeg",
        quality: 50,
        clip: { x: scroll.x, y: scroll.y, width: VIEWPORT.width, height: VIEWPORT.height, scale: 0.25 }
      })) as { data: string };
      return Buffer.from(shot.data, "base64");
    } catch {
      return undefined;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.settleTimer);
    await this.cdp?.detach().catch(() => undefined);
    await this.browser.close().catch(() => undefined);
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 80);
  }
}
