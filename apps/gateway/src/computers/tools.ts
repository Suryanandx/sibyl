/**
 * Browser tools for agents with their own computer (registered once in the
 * tool registry, offered only to such agents through `isAvailable`, and
 * filtered by the agent's access like every other tool).
 *
 * Read tools (look, navigate, click links, fill fields, download) run
 * straight away. Anything that sends something to a site is a write tool
 * and goes through approvals: `computer_submit` (forms, sign-ins, sending,
 * posting), `computer_upload`, and `computer_purchase` (high risk: always
 * asks). The read tools refuse clicks and Enter presses that would send a
 * form, and the browser's request guard (session.ts) blocks anything that
 * slips through.
 *
 * Secrets: a password field only takes `${secret:NAME}` from the vault,
 * resolved on the gateway for the page's host (the secret's allowed hosts
 * apply). The model never sees the value.
 */
import { rm } from "node:fs/promises";
import { PERMISSIONS, authorize, type ToolContext, type ToolDefinition, type ToolResult } from "@open-gpt-live/core";
import { BlockedUrlError, assertPublicUrl } from "../net/safe-fetch.js";
import type { SecretVault } from "../secrets/vault.js";
import type { FileArea } from "./files.js";
import { errorText, type ActionOutcome, type ComputerService } from "./service.js";
import { VIEWPORT, hostOf, type BrowserSession } from "./session.js";

export const COMPUTER_PROVIDER = "computer";
const SNAPSHOT_MAX_CHARS = 10_000;
const TEXT_MAX_CHARS = 6_000;
const DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024;
const SECRET_ONLY = /^\$\{secret:([A-Z][A-Z0-9_]{0,63})\}$/;
const ANY_SECRET = /\$\{secret:/;
/** Buttons whose label says they send, sign in, buy or delete: only through the write tools. */
const SENDING_LABEL = /\b(send|submit|post|publish|reply|comment|sign ?in|log ?in|sign ?up|register|subscribe|join|confirm|save|apply|delete|remove|upload|share|invite|transfer|donate|buy|pay|purchase|order|checkout|check out|book|reserve)\b/i;
const PAYMENT_LABEL = /\b(buy|pay|purchase|place (your )?order|checkout|check out|complete (the )?order|donate|subscribe|upgrade)\b/i;

type ComputerTool = ToolDefinition<any, any> & { approvalSummary?(input: Record<string, unknown>): string | undefined };

export interface ComputerToolsInput {
  service: ComputerService;
  files: FileArea;
  vault(): SecretVault | undefined;
}

interface ElementInfo {
  tag: string;
  type: string;
  label: string;
  isPassword: boolean;
  isFileInput: boolean;
  isButton: boolean;
  /** Submits a form whose method is POST (or another non-GET method). */
  sendsForm: boolean;
  /** In a form that would be sent with POST when Enter is pressed. */
  inPostForm: boolean;
}

async function inspect(browser: BrowserSession, ref: string): Promise<ElementInfo> {
  return browser.element(ref).evaluate((el: Element) => {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") ?? "").toLowerCase();
    const form = (el as HTMLInputElement).form ?? el.closest("form");
    const method = ((el as HTMLButtonElement).formMethod || form?.getAttribute("method") || "get").toLowerCase();
    const isSubmit = (tag === "button" && (type === "" || type === "submit")) || (tag === "input" && (type === "submit" || type === "image"));
    const labelled = (el as HTMLInputElement).labels?.[0]?.innerText;
    const text = (labelled || (el as HTMLElement).innerText || (el as HTMLInputElement).value || el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("placeholder") || el.getAttribute("name") || "").replace(/\s+/g, " ").trim();
    return {
      tag,
      type,
      label: text.slice(0, 80),
      isPassword: tag === "input" && type === "password",
      isFileInput: tag === "input" && type === "file",
      isButton: isSubmit || tag === "button" || el.getAttribute("role") === "button" || (tag === "input" && (type === "button" || type === "reset")),
      sendsForm: Boolean(form && isSubmit && method !== "get" && method !== "dialog"),
      inPostForm: Boolean(form && method !== "get" && method !== "dialog")
    };
  }, undefined, { timeout: 8_000 });
}

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (cut; ${text.length - max} more characters)` : text;
}

async function pageState(browser: BrowserSession, withSnapshot: boolean): Promise<string> {
  const header = `Page: ${(await browser.title()) || "(untitled)"} — ${browser.url()}`;
  if (!withSnapshot) return header;
  const snapshot = await browser.current().ariaSnapshot({ mode: "ai", timeout: 10_000 }).catch((error: unknown) => `(snapshot failed: ${errorText(error)})`);
  return `${header}\n\nElements (use a [ref=…] with the computer tools):\n${cap(snapshot, SNAPSHOT_MAX_CHARS)}`;
}

function blockedText(blocked: string[]): string {
  return `Nothing was sent: the page tried to send data (${blocked.slice(0, 3).join(", ")}). If sending is intended, use computer_submit (it asks the user first).`;
}

/** The page is on `site` (or a subdomain of it). */
export function onSite(url: string, site: string): boolean {
  const want = site.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/[/:].*$/, "").replace(/^www\./, "");
  if (!want) return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return false;
  }
  return host === want || host.endsWith(`.${want}`);
}

function refusal(content: string, label: string): ActionOutcome {
  return { content, label, status: "blocked", detail: content };
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

const REF = { type: "string", description: "The element's ref from the latest snapshot, e.g. e12." };
const SITE = { type: "string", description: "The site the page is on now (hostname, e.g. shop.example.com). Nothing happens if the page is elsewhere." };

export function createComputerTools(input: ComputerToolsInput): ComputerTool[] {
  const { service, files } = input;
  const base = {
    source: COMPUTER_PROVIDER,
    provider: COMPUTER_PROVIDER,
    isAvailable: (scope: { agent?: { computer?: { enabled: boolean } } }) => Boolean(scope.agent?.computer?.enabled)
  } as const;

  /** Shared body of the three write tools: check the site, then act with sending allowed. */
  const write = async (
    context: ToolContext,
    tool: string,
    args: Record<string, unknown>,
    act: (browser: BrowserSession, ref: string) => Promise<ActionOutcome>
  ): Promise<ToolResult> =>
    service.act(context, tool, async (browser) => {
      const site = str(args.site);
      const ref = str(args.ref);
      if (!onSite(browser.url(), site)) return refusal(`The page is on ${hostOf(browser.url())}, not ${site}. Nothing was done.`, "Refused: wrong site");
      return act(browser, ref);
    });

  const sendingStep = (browser: BrowserSession, ref: string, args: Record<string, unknown>, verb: string, payment: boolean): Promise<ActionOutcome> =>
    (async () => {
      const info = await inspect(browser, ref);
      if (!payment && PAYMENT_LABEL.test(info.label)) {
        return refusal(`“${info.label}” looks like a purchase or payment. Use computer_purchase for that.`, "Refused: looks like a payment");
      }
      const enter = args.press_enter === true;
      await browser.guarded("write", () => (enter ? browser.element(ref).press("Enter") : browser.element(ref).click()));
      const label = `${verb} ${info.label ? `“${info.label}”` : str(args.description) || "the form"} on ${hostOf(browser.url())}`;
      return { content: `${label}.\n${await pageState(browser, true)}`, label, detail: str(args.description) };
    })();

  return [
    {
      ...base,
      name: "computer_open",
      title: "Open a web page",
      description: "Open a public web page in your own browser (http or https). Returns the page's elements with refs for the other computer tools.",
      inputSchema: { type: "object", properties: { url: { type: "string", description: "Full URL, e.g. https://example.com" } }, required: ["url"], additionalProperties: false },
      effect: "read",
      run: (args: { url?: unknown }, context) =>
        service.act(context, "computer_open", async (browser) => {
          const raw = str(args.url);
          let url: URL;
          try {
            url = await assertPublicUrl(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
          } catch (error) {
            const reason = error instanceof BlockedUrlError ? error.message : errorText(error);
            return refusal(`Blocked: ${reason}. The computer can only open public internet addresses.`, `Blocked ${raw.slice(0, 80)}`);
          }
          try {
            const { value: response } = await browser.guarded("read", () => browser.current().goto(url.toString(), { waitUntil: "domcontentloaded" }));
            const status = response ? ` (HTTP ${response.status()})` : "";
            return { content: `Opened${status}.\n${await pageState(browser, true)}`, label: `Opened ${url.host}` };
          } catch (error) {
            const reason = errorText(error);
            const blocked = /ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY|403/.test(reason);
            return blocked
              ? refusal(`Blocked: ${url.host} is not a public internet address (or the network refused it).`, `Blocked ${url.host}`)
              : { content: `Could not open ${url}: ${reason}`, label: `Could not open ${url.host}`, status: "error", detail: reason };
          }
        })
    },
    {
      ...base,
      name: "computer_read",
      title: "Read the page",
      description: "Read the current page: its visible text and its elements (an accessibility snapshot with refs to click, type into or select).",
      inputSchema: { type: "object", properties: { text: { type: "boolean", description: "Include the visible text (default true)." } }, additionalProperties: false },
      effect: "read",
      run: (args: { text?: unknown }, context) =>
        service.act(context, "computer_read", async (browser) => {
          const text = args.text === false ? "" : await browser.current().evaluate(() => document.body?.innerText ?? "").catch(() => "");
          const state = await pageState(browser, true);
          return { content: text ? `${state}\n\nVisible text:\n${cap(text.trim(), TEXT_MAX_CHARS)}` : state, label: "Read the page" };
        })
    },
    {
      ...base,
      name: "computer_click",
      title: "Click on the page",
      description:
        "Click a link, tab, checkbox or other control that does not send anything. Buttons that send a form, sign in, post, buy or delete are refused here: use computer_submit or computer_purchase for those.",
      inputSchema: { type: "object", properties: { ref: REF }, required: ["ref"], additionalProperties: false },
      effect: "read",
      run: (args: { ref?: unknown }, context) =>
        service.act(context, "computer_click", async (browser) => {
          const ref = str(args.ref);
          const info = await inspect(browser, ref);
          const name = info.label ? `“${info.label}”` : `element ${ref}`;
          if (info.sendsForm || (info.isButton && SENDING_LABEL.test(info.label))) {
            return refusal(`${name} would send something to the site. Use computer_submit (or computer_purchase for a payment); it asks the user first.`, `Refused to click ${name}`);
          }
          if (info.isFileInput) return refusal("That is a file picker: use computer_upload.", `Refused to click ${name}`);
          const { blocked } = await browser.guarded("read", () => browser.element(ref).click());
          if (blocked.length) return refusal(blockedText(blocked), `Blocked sending from ${name}`);
          return { content: `Clicked ${name}.\n${await pageState(browser, true)}`, label: `Clicked ${name}` };
        })
    },
    {
      ...base,
      name: "computer_type",
      title: "Type into a field",
      description:
        "Fill a text field (replaces its content). For a password field, text must be ${secret:NAME} (a secret from the vault; its value is filled in on the server and never shown to you). press_enter submits search boxes; forms that send data need computer_submit.",
      inputSchema: {
        type: "object",
        properties: { ref: REF, text: { type: "string" }, press_enter: { type: "boolean", description: "Press Enter after typing (search boxes)." } },
        required: ["ref", "text"],
        additionalProperties: false
      },
      effect: "read",
      run: (args: { ref?: unknown; text?: unknown; press_enter?: unknown }, context) =>
        service.act(context, "computer_type", async (browser, agent) => {
          const ref = str(args.ref);
          const text = typeof args.text === "string" ? args.text : "";
          const info = await inspect(browser, ref);
          const name = info.label ? `“${info.label}”` : `field ${ref}`;
          let value = text;
          let shown = `“${cap(text, 60)}”`;
          if (info.isPassword) {
            const secret = SECRET_ONLY.exec(text.trim());
            if (!secret) return refusal("Password fields only take a secret from the vault: text must be ${secret:NAME}. Use list_secrets to see the names.", `Refused to type into ${name}`);
            if (context.principal && !authorize(context.principal, PERMISSIONS.SECRETS_USE, { workspaceId: agent.workspaceId })) {
              return refusal("You don't have permission to use secrets in this workspace.", `Refused to type into ${name}`);
            }
            const vault = input.vault();
            if (!vault) return refusal("Secrets are not available on this gateway.", `Refused to type into ${name}`);
            try {
              value = await vault.resolve(context.ownerId, secret[1]!, { host: new URL(browser.url()).hostname });
            } catch (error) {
              return refusal(errorText(error), `Refused to use the secret ${secret[1]}`);
            }
            shown = `the secret ${secret[1]}`;
          } else if (ANY_SECRET.test(text)) {
            return refusal("Secrets can only go into password fields (other fields can be read back from the page).", `Refused to type into ${name}`);
          }
          if (args.press_enter === true && info.inPostForm) {
            return refusal(`Pressing Enter in ${name} would send the form. Type without press_enter, then use computer_submit.`, `Refused to press Enter in ${name}`);
          }
          const { blocked } = await browser.guarded("read", async () => {
            await browser.element(ref).fill(value);
            if (args.press_enter === true) await browser.element(ref).press("Enter");
          });
          if (blocked.length) return refusal(blockedText(blocked), `Blocked sending from ${name}`);
          const label = `Typed ${shown} into ${name}${args.press_enter === true ? " and pressed Enter" : ""}`;
          return { content: `${label}.${args.press_enter === true ? `\n${await pageState(browser, true)}` : ""}`, label };
        })
    },
    {
      ...base,
      name: "computer_select",
      title: "Choose an option",
      description: "Choose one or more options in a select (dropdown) element, by value or label.",
      inputSchema: {
        type: "object",
        properties: { ref: REF, values: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 20 } },
        required: ["ref", "values"],
        additionalProperties: false
      },
      effect: "read",
      run: (args: { ref?: unknown; values?: unknown }, context) =>
        service.act(context, "computer_select", async (browser) => {
          const ref = str(args.ref);
          const values = Array.isArray(args.values) ? args.values.filter((v): v is string => typeof v === "string").slice(0, 20) : [];
          if (!values.length) return { content: "Give at least one value to choose.", label: "Nothing chosen", status: "error" };
          const { value: chosen, blocked } = await browser.guarded("read", () => browser.element(ref).selectOption(values));
          if (blocked.length) return refusal(blockedText(blocked), "Blocked sending after a choice");
          const label = `Chose ${chosen.map((v) => `“${v}”`).join(", ")}`;
          return { content: `${label}.`, label };
        })
    },
    {
      ...base,
      name: "computer_scroll",
      title: "Scroll the page",
      description: "Scroll the current page (to load more content or show people watching a part of it).",
      inputSchema: {
        type: "object",
        properties: { direction: { type: "string", enum: ["down", "up", "top", "bottom"] }, pages: { type: "number", minimum: 0.25, maximum: 10 } },
        required: ["direction"],
        additionalProperties: false
      },
      effect: "read",
      run: (args: { direction?: unknown; pages?: unknown }, context) =>
        service.act(context, "computer_scroll", async (browser) => {
          const direction = ["down", "up", "top", "bottom"].includes(str(args.direction)) ? str(args.direction) : "down";
          const pages = typeof args.pages === "number" && args.pages > 0 ? Math.min(args.pages, 10) : 1;
          await browser.guarded("read", () =>
            browser.current().evaluate(
              ({ direction, pixels }) => {
                if (direction === "top") window.scrollTo(0, 0);
                else if (direction === "bottom") window.scrollTo(0, document.body.scrollHeight);
                else window.scrollBy(0, direction === "up" ? -pixels : pixels);
              },
              { direction, pixels: Math.round(pages * VIEWPORT.height * 0.9) }
            )
          );
          return { content: `Scrolled ${direction}.`, label: `Scrolled ${direction}` };
        })
    },
    {
      ...base,
      name: "computer_screenshot",
      title: "Take a screenshot",
      description: "Save a screenshot of the current page to your file area (people can see it in the computer's timeline).",
      inputSchema: { type: "object", properties: { full_page: { type: "boolean" } }, additionalProperties: false },
      effect: "read",
      run: (args: { full_page?: unknown }, context) =>
        service.act(context, "computer_screenshot", async (browser, agent) => {
          const bytes = await browser.current().screenshot({ type: "jpeg", quality: 80, fullPage: args.full_page === true });
          const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
          const saved = await files.write(agent.id, `screenshot-${stamp}.jpg`, bytes);
          return {
            content: `Saved a screenshot of ${hostOf(browser.url())} as ${saved.name} in the file area (${Math.round(saved.bytes / 1024)} KB).`,
            label: `Took a screenshot (${saved.name})`,
            data: { file: saved.name }
          };
        })
    },
    {
      ...base,
      name: "computer_download",
      title: "Download a file",
      description: "Download a file into your file area: either a public URL, or by clicking a download link (ref).",
      inputSchema: { type: "object", properties: { url: { type: "string" }, ref: REF }, additionalProperties: false },
      effect: "read",
      run: (args: { url?: unknown; ref?: unknown }, context) =>
        service.act(context, "computer_download", async (browser, agent) => {
          const free = Math.min(DOWNLOAD_MAX_BYTES, await files.free(agent.id));
          const ref = str(args.ref);
          const raw = str(args.url);
          if (!ref && !raw) return { content: "Give a url or a ref to download.", label: "Nothing downloaded", status: "error" };
          if (raw) {
            let url: URL;
            try {
              url = await assertPublicUrl(raw);
            } catch (error) {
              return refusal(`Blocked: ${errorText(error)}.`, `Blocked ${raw.slice(0, 80)}`);
            }
            // Through the sandbox browser (its cookies, its proxy).
            const response = await browser.current().context().request.get(url.toString(), { timeout: 60_000, maxRedirects: 5, failOnStatusCode: false });
            if (!response.ok()) return { content: `The download failed: HTTP ${response.status()}.`, label: `Download failed (HTTP ${response.status()})`, status: "error" };
            const declared = Number(response.headers()["content-length"] ?? 0);
            if (declared > free) return { content: `The file is too large (${Math.round(declared / 1_048_576)} MB; ${Math.round(free / 1_048_576)} MB free).`, label: "Download too large", status: "error" };
            const body = await response.body();
            if (body.byteLength > free) return { content: "The file is too large for the file area.", label: "Download too large", status: "error" };
            const disposition = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(response.headers()["content-disposition"] ?? "")?.[1];
            const wanted = decodeURIComponent(disposition ?? url.pathname.split("/").pop() ?? "") || "download";
            const saved = await files.write(agent.id, wanted, body);
            return { content: `Downloaded ${saved.name} (${Math.round(saved.bytes / 1024)} KB) into the file area.`, label: `Downloaded ${saved.name}`, data: { file: saved.name } };
          }
          const page = browser.current();
          const { value: download, blocked } = await browser.guarded("read", async () => {
            const [download] = await Promise.all([page.waitForEvent("download", { timeout: 20_000 }), browser.element(ref).click()]);
            return download;
          });
          if (blocked.length) return refusal(blockedText(blocked), "Blocked sending from a download link");
          const target = await files.reserve(agent.id, download.suggestedFilename() || "download");
          await download.saveAs(target.path);
          const size = (await files.list(agent.id)).find((file) => file.name === target.name)?.bytes ?? 0;
          if (size > free) {
            await rm(target.path, { force: true });
            return { content: "The file is too large for the file area; it was not kept.", label: "Download too large", status: "error" };
          }
          return { content: `Downloaded ${target.name} (${Math.round(size / 1024)} KB) into the file area.`, label: `Downloaded ${target.name}`, data: { file: target.name } };
        })
    },
    {
      ...base,
      name: "computer_files",
      title: "List computer files",
      description: "List the files in your computer's file area (downloads, screenshots).",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      effect: "read",
      async run(_args, context) {
        const agent = await service.agentFor(context);
        if (typeof agent === "string") return { content: agent, isError: true };
        const list = await files.list(agent.id);
        if (!list.length) return { content: "The file area is empty." };
        return { content: list.map((file) => `- ${file.name} (${Math.max(1, Math.round(file.bytes / 1024))} KB, ${new Date(file.modifiedAt).toISOString().slice(0, 16).replace("T", " ")})`).join("\n"), data: list };
      }
    },
    {
      ...base,
      name: "computer_read_file",
      title: "Read a computer file",
      description: "Read a text file (txt, csv, json, md, html, …) from your computer's file area.",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
      effect: "read",
      async run(args: { name?: unknown }, context) {
        const agent = await service.agentFor(context);
        if (typeof agent === "string") return { content: agent, isError: true };
        const read = await files.readText(agent.id, str(args.name));
        if ("error" in read) return { content: read.error, isError: true };
        return { content: read.truncated ? `${read.text}\n… (cut)` : read.text };
      }
    },
    {
      ...base,
      name: "computer_submit",
      title: "Submit on a website",
      description:
        "Send something to a website from your browser: submit a form, sign in, send a message, post, save or confirm. Clicks the button (or presses Enter in the field) given by ref. Needs the user's approval first.",
      inputSchema: {
        type: "object",
        properties: {
          site: SITE,
          description: { type: "string", description: "What will be sent, in plain words (shown to the user), e.g. “Sign in as ana@example.com”." },
          ref: REF,
          press_enter: { type: "boolean", description: "Press Enter in the field instead of clicking." }
        },
        required: ["site", "description", "ref"],
        additionalProperties: false
      },
      effect: "write",
      approvalSummary: (args) => `Submit on ${str(args.site) || "a website"} from the agent's browser: ${str(args.description) || "a form"}.`,
      run: (args: Record<string, unknown>, context) => write(context, "computer_submit", args, (browser, ref) => sendingStep(browser, ref, args, "Submitted", false))
    },
    {
      ...base,
      name: "computer_purchase",
      title: "Buy or pay on a website",
      description:
        "Buy, pay, order, donate or subscribe on a website from your browser (clicks the final button given by ref). Always needs the user's approval, whatever your autonomy.",
      inputSchema: {
        type: "object",
        properties: {
          site: SITE,
          description: { type: "string", description: "What is bought and from whom, e.g. “2 × USB-C cable from shop.example.com”." },
          amount: { type: "string", description: "The total as shown on the page, with currency, e.g. “€24.90”." },
          ref: REF
        },
        required: ["site", "description", "amount", "ref"],
        additionalProperties: false
      },
      effect: "write",
      risk: "high",
      approvalSummary: (args) => `Pay ${str(args.amount) || "an amount"} on ${str(args.site) || "a website"} from the agent's browser: ${str(args.description) || "a purchase"}.`,
      run: (args: Record<string, unknown>, context) => write(context, "computer_purchase", args, (browser, ref) => sendingStep(browser, ref, args, "Paid with", true))
    },
    {
      ...base,
      name: "computer_upload",
      title: "Upload a file to a website",
      description: "Put a file from your file area into a website's file picker (ref of the file input). Needs the user's approval first.",
      inputSchema: {
        type: "object",
        properties: { site: SITE, ref: REF, file: { type: "string", description: "Name of a file in the file area (computer_files)." } },
        required: ["site", "ref", "file"],
        additionalProperties: false
      },
      effect: "write",
      approvalSummary: (args) => `Upload ${str(args.file) || "a file"} to ${str(args.site) || "a website"} from the agent's browser.`,
      run: (args: Record<string, unknown>, context) =>
        write(context, "computer_upload", args, async (browser, ref) => {
          const agent = await service.agentFor(context);
          if (typeof agent === "string") return refusal(agent, "Refused");
          const path = await files.path(agent.id, str(args.file));
          if (!path) return { content: `There is no file named ${str(args.file)} in the file area.`, label: "Upload failed", status: "error" };
          const info = await inspect(browser, ref);
          if (!info.isFileInput) return refusal("That element is not a file picker (input type=file).", "Refused: not a file picker");
          await browser.guarded("write", () => browser.element(ref).setInputFiles(path));
          const label = `Attached ${str(args.file)} on ${hostOf(browser.url())}`;
          return { content: `${label}. Submit the form with computer_submit if the site needs it.`, label };
        })
    }
  ];
}

export const COMPUTER_TOOL_NAMES: readonly string[] = [
  "computer_open",
  "computer_read",
  "computer_click",
  "computer_type",
  "computer_select",
  "computer_scroll",
  "computer_screenshot",
  "computer_download",
  "computer_files",
  "computer_read_file",
  "computer_submit",
  "computer_purchase",
  "computer_upload"
];
