/**
 * `currency_convert`: reference exchange rates (European Central Bank via the
 * Frankfurter API — free, no key).
 */
import type { ToolDefinition } from "@open-gpt-live/core";
import { errorResult, fetchJson, HttpError, type FetchLike } from "./http.js";

const FRANKFURTER_URL = "https://api.frankfurter.dev/v1";

export interface CurrencyInput {
  amount?: number;
  from: string;
  to: string | string[];
  date?: string;
}

export interface CurrencyData {
  amount: number;
  from: string;
  date: string;
  rates: Record<string, number>;
  converted: Record<string, number>;
}

const CODE = /^[A-Z]{3}$/;

export function createCurrencyTool(fetchImpl: FetchLike): ToolDefinition<CurrencyInput, CurrencyData> {
  async function supportedList(signal: AbortSignal): Promise<string> {
    try {
      const currencies = await fetchJson<Record<string, string>>(fetchImpl, `${FRANKFURTER_URL}/currencies`, { signal });
      return Object.keys(currencies ?? {}).join(", ");
    } catch {
      return "";
    }
  }

  return {
    name: "currency_convert",
    title: "Convert currency",
    description:
      "Convert an amount between currencies using European Central Bank reference rates (updated each working day, ~16:00 CET). " +
      "Use ISO 4217 codes (USD, EUR, JPY, GBP, CNY…). `to` may be one code or a list. Optional `date` (YYYY-MM-DD) for a historical rate. " +
      "Covers ~30 major fiat currencies; no crypto.",
    inputSchema: {
      type: "object",
      properties: {
        amount: { type: "number", description: "Amount in the `from` currency (default 1)." },
        from: { type: "string", description: "Source currency code, e.g. \"USD\"." },
        to: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 30,
          description: "Target currency codes, e.g. [\"EUR\"] or [\"EUR\", \"JPY\"]."
        },
        date: { type: "string", description: "Optional historical date YYYY-MM-DD (default: latest)." }
      },
      required: ["from", "to"],
      additionalProperties: false
    },
    effect: "read",
    source: "builtin",
    async run(input, context) {
      const amount = input?.amount === undefined ? 1 : Number(input.amount);
      if (!Number.isFinite(amount)) return { content: "Currency conversion failed: `amount` must be a number.", isError: true };
      const from = String(input?.from ?? "").trim().toUpperCase();
      const to = (Array.isArray(input?.to) ? input.to : String(input?.to ?? "").split(/[,\s]+/))
        .map((code) => String(code).trim().toUpperCase())
        .filter(Boolean)
        .filter((code) => code !== from);
      const bad = [from, ...to].filter((code) => !CODE.test(code));
      if (!from || to.length === 0 || bad.length > 0) {
        const list = await supportedList(context.signal);
        return {
          content:
            `Currency conversion failed: ${bad.length ? `invalid code(s) ${bad.join(", ")}` : "give `from` and at least one different `to` currency"}.` +
            (list ? ` Supported: ${list}.` : ""),
          isError: true
        };
      }
      let date = "latest";
      if (input.date !== undefined) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(input.date))) {
          return { content: "Currency conversion failed: `date` must be YYYY-MM-DD.", isError: true };
        }
        date = String(input.date);
      }

      try {
        const body = await fetchJson<{ base: string; date: string; rates: Record<string, number> }>(
          fetchImpl,
          `${FRANKFURTER_URL}/${date}?${new URLSearchParams({ base: from, symbols: to.join(",") })}`,
          { signal: context.signal }
        );
        const rates = body?.rates ?? {};
        const missing = to.filter((code) => typeof rates[code] !== "number");
        const converted = Object.fromEntries(
          Object.entries(rates).map(([code, rate]) => [code, Math.round(amount * rate * 10_000) / 10_000])
        );
        if (Object.keys(converted).length === 0) {
          const list = await supportedList(context.signal);
          return { content: `Currency conversion failed: no rates for ${to.join(", ")}.${list ? ` Supported: ${list}.` : ""}`, isError: true };
        }
        const lines = Object.entries(converted).map(
          ([code, value]) => `${formatAmount(amount)} ${from} = ${formatAmount(value)} ${code} (rate ${rates[code]})`
        );
        if (missing.length) lines.push(`No rate for: ${missing.join(", ")}.`);
        lines.push(`ECB reference rates for ${body.date}.`);
        return { content: lines.join("\n"), data: { amount, from, date: body.date, rates, converted } };
      } catch (error) {
        if (error instanceof HttpError && (error.status === 404 || error.status === 422 || error.status === 400)) {
          const list = await supportedList(context.signal);
          return {
            content:
              `Currency conversion failed: unsupported currency or date (${from} → ${to.join(", ")}${date === "latest" ? "" : ` on ${date}`}).` +
              (list ? ` Supported: ${list}.` : ""),
            isError: true
          };
        }
        return errorResult("Currency conversion failed", error, context.signal);
      }
    }
  };
}

function formatAmount(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 4 });
}
