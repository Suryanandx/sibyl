import type { ModelPreset } from "@open-gpt-live/protocol";

/**
 * How Sibyl shows what a preset costs. Typing and talking cost different
 * amounts (a spoken turn adds the voice brain, transcription and speech), so
 * every place that shows a preset price uses these helpers.
 */

export function usd(value: number): string {
  if (value === 0) return "$0";
  if (value < 0.1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

/** "$0.07 typing · $0.29 voice" (per 100 messages / turns). */
export function presetPriceLine(preset: ModelPreset): string | undefined {
  const typed = preset.costPer100Messages;
  const voice = preset.costPer100Turns;
  if (typed === undefined && voice === undefined) return undefined;
  if (typed === undefined) return `${usd(voice!)} voice`;
  if (voice === undefined) return `${usd(typed)} typing`;
  return `${usd(typed)} typing · ${usd(voice)} voice`;
}

/** Compact, for tight rows: the typing price, with both in the tooltip. */
export function presetPriceShort(preset: ModelPreset): { text: string; title: string } | undefined {
  const line = presetPriceLine(preset);
  if (!line) return undefined;
  const primary = preset.costPer100Messages ?? preset.costPer100Turns!;
  return { text: usd(primary), title: `Per 100 messages: ${line}. Tools like web search add about $0.01 each.` };
}
