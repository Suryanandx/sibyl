/**
 * Reading images and scanned PDFs for knowledge, through the LLM provider
 * (OpenRouter's OpenAI-compatible chat completions):
 *
 * - Images: a vision model transcribes the text and adds a short description,
 *   so photos, screenshots and whiteboards become searchable.
 * - Scanned PDFs: OpenRouter's file-parser plugin (default engine
 *   "mistral-ocr", $2 per 1,000 pages) parses the file; its text comes back as
 *   a `file` annotation, so the model only answers "OK". If that engine fails
 *   or returns nothing, the model reads the PDF itself (engine "native",
 *   models with file input only).
 *
 * Every call checks the budget first and is metered as "knowledge_ocr" with
 * the provider-reported cost (`usage.cost`, which includes the parser's
 * per-page fee), else an estimate. Chat attachments never come here: chats
 * send images to the model directly.
 *
 * Model: SIBYL_OCR_MODEL, else SIBYL_VISION_MODEL, else the cheapest
 * vision-capable model in the current model catalog (scout or config).
 */
import type { UsageMeter } from "@open-gpt-live/core";
import type { ModelCatalog } from "@open-gpt-live/protocol";
import { loadGatewayRuntimeConfig } from "../config.js";
import { GatewayUsageMeter } from "../metering/meter.js";
import { CostEstimator } from "../metering/pricing.js";
import { price, type OpenRouterModel } from "../scout.js";
import { supportsVision } from "../uploads/attachments.js";

export const DEFAULT_PDF_ENGINE = "mistral-ocr";
/** OpenRouter's published mistral-ocr price, used only to estimate before the call. */
export const DEFAULT_USD_PER_PAGE = 0.002;
/** Fallback estimate for one image when the model has no known price. */
const IMAGE_ESTIMATE_USD = 0.002;
const IMAGE_TOKENS = { prompt: 1_500, completion: 700 };
const TIMEOUT_MS = 180_000;
const CATALOG_WAIT_MS = 30_000;
/** Biggest file sent to the provider (data URLs are base64: +33%). */
export const MAX_OCR_BYTES = 30 * 1024 * 1024;

const IMAGE_PROMPT = [
  "Read this image for a searchable knowledge base.",
  "First write every piece of text you can see, exactly as written, keeping line breaks (write (no text) if there is none).",
  "Then write a line starting with \"Description:\" and describe the image in one to three plain sentences.",
  "Reply in this form and nothing else:",
  "Text in the image:",
  "<the text>",
  "",
  "Description: <the description>"
].join("\n");

const PDF_PROMPT = [
  "Transcribe the full text of this scanned document for a searchable knowledge base.",
  "Keep the reading order and line breaks. Start each page with a line \"--- Page N ---\".",
  "Reply with the transcription only."
].join("\n");

export type OcrFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface OcrResult {
  text: string;
  model: string;
  engine?: string;
  costUsd: number;
  estimated: boolean;
}

export class OcrError extends Error {
  constructor(message: string, readonly code: "budget" | "no_model" | "provider" | "empty" | "too_large") {
    super(message);
  }
}

export interface OcrClientOptions {
  baseUrl: string;
  apiKey?: string;
  extraHeaders?: Record<string, string>;
  meter: UsageMeter;
  ownerId: string;
  env?: NodeJS.ProcessEnv;
  /** OpenRouter file-parser engine for scanned PDFs. */
  pdfEngine?: string;
  usdPerPage?: number;
  fetch?: OcrFetch;
  timeoutMs?: number;
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: unknown; annotations?: unknown } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  error?: { message?: string };
}

/**
 * The OCR model: config override, else the cheapest image-reading model in the
 * catalog. "Reads images" and "cheapest" come from OpenRouter's model data
 * (input modalities, per-token price for a typical image) when the gateway has
 * it, else from the model id and the catalog's cost estimate.
 */
export function pickOcrModel(
  env: NodeJS.ProcessEnv,
  catalog: ModelCatalog | undefined,
  info: (id: string) => OpenRouterModel | undefined = () => undefined
): string | undefined {
  const configured = env.SIBYL_OCR_MODEL?.trim() || env.SIBYL_VISION_MODEL?.trim();
  if (configured) return configured;
  const ranked = (catalog?.llm ?? [])
    .map((option, index) => {
      const known = info(option.id);
      const modalities = known?.architecture?.input_modalities;
      const vision = modalities ? modalities.includes("image") : supportsVision(option.id);
      // Exact token prices rank first; the catalog's per-turn estimate is a different scale.
      const exact = known?.pricing ? price(known, "prompt") * IMAGE_TOKENS.prompt + price(known, "completion") * IMAGE_TOKENS.completion : undefined;
      return { id: option.id, vision, exact, rough: option.costPer100Turns ?? Number.POSITIVE_INFINITY, index };
    })
    .filter((candidate) => candidate.vision)
    .sort(
      (a, b) =>
        (a.exact === undefined ? 1 : 0) - (b.exact === undefined ? 1 : 0) ||
        (a.exact ?? 0) - (b.exact ?? 0) ||
        a.rough - b.rough ||
        a.index - b.index
    );
  return ranked[0]?.id;
}

export class OcrClient {
  readonly pdfEngine: string;
  private readonly fetchImpl: OcrFetch;
  private catalog: () => ModelCatalog | undefined = () => undefined;
  /** Resolves once the server hands over the model catalog (documents resumed at start-up wait for it). */
  private readonly catalogReady: Promise<void>;
  private markCatalogReady: () => void = () => undefined;
  private pricesLoading: Promise<void> | undefined;

  constructor(private readonly options: OcrClientOptions) {
    this.pdfEngine = options.pdfEngine?.trim() || DEFAULT_PDF_ENGINE;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.catalogReady = new Promise((resolve) => {
      this.markCatalogReady = resolve;
    });
  }

  /** The model catalog (from the scout or models config) the OCR model is picked from. */
  useCatalog(catalog: () => ModelCatalog | undefined): void {
    this.catalog = catalog;
    this.markCatalogReady();
  }

  model(): string | undefined {
    const meter = this.options.meter;
    return pickOcrModel(this.options.env ?? process.env, this.catalog(), meter instanceof GatewayUsageMeter ? (id) => meter.pricing.get(id) : undefined);
  }

  /** Transcription and a short description of an image. */
  async readImage(bytes: Buffer, mime: string, signal?: AbortSignal): Promise<OcrResult> {
    const model = await this.requireModel();
    this.checkSize(bytes);
    const estimate = this.tokenCost(model, IMAGE_TOKENS.prompt, IMAGE_TOKENS.completion) || IMAGE_ESTIMATE_USD;
    const body = {
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: IMAGE_PROMPT },
            { type: "image_url", image_url: { url: `data:${mime};base64,${bytes.toString("base64")}` } }
          ]
        }
      ],
      max_tokens: 4_000,
      temperature: 0
    };
    const { response, cost } = await this.call(model, body, estimate, signal);
    const text = messageText(response).trim();
    if (!text) throw new OcrError("The vision model returned no text.", "empty");
    return { text, model, ...cost };
  }

  /** Text of a scanned PDF: the file-parser engine first, then the model itself. */
  async readPdf(bytes: Buffer, name: string, pages: number | undefined, signal?: AbortSignal): Promise<OcrResult> {
    const model = await this.requireModel();
    this.checkSize(bytes);
    const pageCount = Math.max(1, pages ?? 1);
    const file = { type: "file", file: { filename: name.replace(/[^\w. -]/g, "_") || "document.pdf", file_data: `data:application/pdf;base64,${bytes.toString("base64")}` } };
    let firstError: Error | undefined;
    let spent = { costUsd: 0, estimated: false };
    if (this.pdfEngine !== "native") {
      try {
        const estimate = pageCount * (this.options.usdPerPage ?? DEFAULT_USD_PER_PAGE) + this.tokenCost(model, 100, 5);
        const { response, cost } = await this.call(
          model,
          {
            model,
            messages: [{ role: "user", content: [{ type: "text", text: "Reply with the single word OK." }, file] }],
            plugins: [{ id: "file-parser", pdf: { engine: this.pdfEngine } }],
            max_tokens: 5,
            temperature: 0
          },
          estimate,
          signal
        );
        spent = cost;
        const text = annotationText(response, pageCount);
        if (text.trim()) return { text, model, engine: this.pdfEngine, ...cost };
      } catch (error) {
        if (error instanceof OcrError && error.code === "budget") throw error;
        firstError = error as Error;
      }
    }
    // The model reads the PDF itself (only models with file input can).
    try {
      const estimate = this.tokenCost(model, pageCount * 1_500, pageCount * 700) || pageCount * IMAGE_ESTIMATE_USD;
      const { response, cost } = await this.call(
        model,
        {
          model,
          messages: [{ role: "user", content: [{ type: "text", text: PDF_PROMPT }, file] }],
          plugins: [{ id: "file-parser", pdf: { engine: "native" } }],
          max_tokens: Math.min(32_000, 1_500 * pageCount),
          temperature: 0
        },
        estimate,
        signal
      );
      const text = messageText(response).trim();
      if (!text) throw new OcrError("The model returned no text for the scanned PDF.", "empty");
      return { text, model, engine: "native", costUsd: spent.costUsd + cost.costUsd, estimated: spent.estimated || cost.estimated };
    } catch (error) {
      if (error instanceof OcrError && error.code === "budget") throw error;
      const reasons = [firstError ? `${this.pdfEngine}: ${firstError.message}` : "", `native: ${(error as Error).message}`].filter(Boolean);
      throw new OcrError(`The scanned PDF could not be read (${reasons.join("; ")}).`.slice(0, 280), "provider");
    }
  }

  private async requireModel(): Promise<string> {
    const env = this.options.env ?? process.env;
    if (!env.SIBYL_OCR_MODEL?.trim() && !env.SIBYL_VISION_MODEL?.trim()) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([this.catalogReady, new Promise<void>((resolve) => (timer = setTimeout(resolve, CATALOG_WAIT_MS)))]);
      clearTimeout(timer);
    }
    await this.ensurePrices();
    const model = this.model();
    if (!model) throw new OcrError("No vision model is available to read it. Set SIBYL_OCR_MODEL to a vision model.", "no_model");
    return model;
  }

  /**
   * Model data (input modalities, prices) normally arrives with the scout's
   * /models fetch; when the scout ran from its cache there is none, so fetch
   * the provider's public model list once (no cost) into the shared table.
   */
  private async ensurePrices(): Promise<void> {
    const meter = this.options.meter;
    if (!(meter instanceof GatewayUsageMeter) || meter.pricing.size > 0) return;
    this.pricesLoading ??= this.fetchImpl(`${this.options.baseUrl.replace(/\/+$/, "")}/models`, { method: "GET", signal: AbortSignal.timeout(10_000) })
      .then(async (response) => {
        if (response.ok) meter.pricing.ingest(((await response.json()) as { data?: OpenRouterModel[] }).data ?? []);
      })
      .catch(() => undefined);
    await this.pricesLoading;
  }

  private checkSize(bytes: Buffer): void {
    if (bytes.byteLength > MAX_OCR_BYTES) throw new OcrError(`The file is larger than ${MAX_OCR_BYTES / 1024 / 1024} MB, too large to read with OCR.`, "too_large");
  }

  /** Cost from token counts and the model's price, or 0 when the price is unknown. */
  private tokenCost(model: string, promptTokens: number, completionTokens: number): number {
    const meter = this.options.meter;
    if (!(meter instanceof GatewayUsageMeter)) return 0;
    return new CostEstimator(meter.pricing, this.catalog).llm("knowledge_ocr", model, promptTokens, completionTokens) || 0;
  }

  private async call(
    model: string,
    body: Record<string, unknown>,
    estimateUsd: number,
    signal?: AbortSignal
  ): Promise<{ response: ChatResponse; cost: { costUsd: number; estimated: boolean } }> {
    const decision = this.options.meter.check({ ownerId: this.options.ownerId, estimateUsd });
    if (!decision.allowed) throw new OcrError(decision.message, "budget");
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? TIMEOUT_MS);
    const response = await this.fetchImpl(`${this.options.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
        ...(this.options.extraHeaders ?? {})
      },
      body: JSON.stringify({ ...body, usage: { include: true } }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    });
    let parsed: ChatResponse = {};
    try {
      parsed = (await response.json()) as ChatResponse;
    } catch {
      parsed = {};
    }
    if (!response.ok || parsed.error) {
      throw new OcrError(`HTTP ${response.status}${parsed.error?.message ? `: ${String(parsed.error.message).slice(0, 160)}` : ""}`, "provider");
    }
    const usage = parsed.usage ?? {};
    const reported = typeof usage.cost === "number" && Number.isFinite(usage.cost) ? usage.cost : undefined;
    const promptTokens = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : undefined;
    const completionTokens = typeof usage.completion_tokens === "number" ? usage.completion_tokens : undefined;
    const costUsd = reported ?? estimateUsd;
    this.options.meter.record({
      ownerId: this.options.ownerId,
      feature: "knowledge_ocr",
      model,
      costUsd,
      estimated: reported === undefined,
      ...(promptTokens === undefined ? {} : { promptTokens }),
      ...(completionTokens === undefined ? {} : { completionTokens })
    });
    return { response: parsed, cost: { costUsd, estimated: reported === undefined } };
  }
}

function messageText(response: ChatResponse): string {
  const content = response.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")).join("");
  }
  return "";
}

/**
 * Text of the file-parser's `file` annotation: content parts without the
 * `<file name=…>` wrapper. One part per page gets "--- Page N ---" markers.
 */
export function annotationText(response: ChatResponse, pages: number): string {
  const annotations = response.choices?.[0]?.message?.annotations;
  if (!Array.isArray(annotations)) return "";
  const texts: string[] = [];
  for (const annotation of annotations) {
    const file = (annotation as { type?: unknown; file?: { content?: unknown } })?.file;
    if ((annotation as { type?: unknown })?.type !== "file" || !Array.isArray(file?.content)) continue;
    for (const part of file.content as Array<{ type?: unknown; text?: unknown }>) {
      if (part?.type !== "text" || typeof part.text !== "string") continue;
      const text = part.text.trim();
      if (!text || /^<\/?file\b[^>]*>$/.test(text)) continue;
      texts.push(text);
    }
  }
  if (texts.length > 1 && texts.length === pages) return texts.map((text, index) => `--- Page ${index + 1} ---\n${text}`).join("\n\n");
  return texts.join("\n\n");
}

/** The OCR client for the configured LLM provider, or undefined when it can't be configured. */
export function ocrFromEnv(input: {
  env: NodeJS.ProcessEnv;
  meter: UsageMeter;
  ownerId: string;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}): OcrClient | undefined {
  if (input.env.SIBYL_KNOWLEDGE_OCR?.trim().toLowerCase() === "false") return undefined;
  try {
    const config = loadGatewayRuntimeConfig(input.env);
    const perPage = Number(input.env.SIBYL_OCR_USD_PER_PAGE);
    return new OcrClient({
      baseUrl: input.env.SIBYL_OCR_BASE_URL?.trim() || config.llm.baseUrl,
      ...(config.llm.apiKey ? { apiKey: config.llm.apiKey } : {}),
      ...(config.extraHeaders ? { extraHeaders: config.extraHeaders } : {}),
      meter: input.meter,
      ownerId: input.ownerId,
      env: input.env,
      ...(input.env.SIBYL_OCR_PDF_ENGINE?.trim() ? { pdfEngine: input.env.SIBYL_OCR_PDF_ENGINE.trim() } : {}),
      ...(Number.isFinite(perPage) && perPage >= 0 && input.env.SIBYL_OCR_USD_PER_PAGE?.trim() ? { usdPerPage: perPage } : {})
    });
  } catch (error) {
    input.log?.("knowledge.ocr_unavailable", { error: (error as Error).message });
    return undefined;
  }
}
