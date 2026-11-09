/**
 * Metered fetch for the model scout: captures OpenRouter /models pricing
 * (used for every later estimate) and records an estimated cost for each
 * latency probe (/chat/completions, /audio/speech). Probes stop reading after
 * the first token, so no provider-reported cost is ever available for them.
 */
import type { UsageMeter } from "@open-gpt-live/core";
import type { OpenRouterModel } from "../scout.js";
import { GatewayUsageMeter } from "./meter.js";
import { CostEstimator, PricingTable, estimatePromptTokens } from "./pricing.js";

/** Probes are capped and read only the first tokens; assume a short answer. */
const PROBE_COMPLETION_TOKENS = 40;

export function createMeteredFetch(options: {
  meter: UsageMeter;
  ownerId: string;
  fetchImpl?: typeof fetch;
}): typeof fetch {
  const base = options.fetchImpl ?? fetch;
  const pricing = options.meter instanceof GatewayUsageMeter ? options.meter.pricing : new PricingTable();
  const estimator = new CostEstimator(pricing, () => undefined);

  const metered = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const response = await base(input, init);
    try {
      const path = new URL(url).pathname;
      if (/\/models$/.test(path) && response.ok) {
        void response
          .clone()
          .json()
          .then((body: { data?: OpenRouterModel[] }) => pricing.ingest(body.data ?? []))
          .catch(() => undefined);
      } else if (response.ok && typeof init?.body === "string") {
        const body = JSON.parse(init.body) as {
          model?: string;
          input?: string;
          messages?: Parameters<typeof estimatePromptTokens>[0];
        };
        if (/\/chat\/completions$/.test(path) && body.model) {
          const promptTokens = estimatePromptTokens(body.messages ?? []);
          options.meter.record({
            ownerId: options.ownerId,
            feature: "scout",
            model: body.model,
            costUsd: estimator.llm("brain", body.model, promptTokens, PROBE_COMPLETION_TOKENS),
            estimated: true,
            promptTokens,
            completionTokens: PROBE_COMPLETION_TOKENS
          });
        } else if (/\/audio\/speech$/.test(path) && body.model) {
          const characters = body.input?.length ?? 0;
          options.meter.record({
            ownerId: options.ownerId,
            feature: "scout",
            model: body.model,
            costUsd: estimator.tts(body.model, characters),
            estimated: true,
            units: characters
          });
        }
      }
    } catch {
      // Metering must never break the scout.
    }
    return response;
  };
  return metered as typeof fetch;
}
