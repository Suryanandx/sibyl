/**
 * Ids for records the gateway creates: `<prefix>_<24 hex>` (96 random bits),
 * or the bare hex without a prefix. One length everywhere, so validators
 * share one pattern (idPattern).
 */
import { randomBytes } from "node:crypto";

export const ID_HEX_LENGTH = 24;

export function newId(prefix?: string): string {
  const hex = randomBytes(ID_HEX_LENGTH / 2).toString("hex");
  return prefix ? `${prefix}_${hex}` : hex;
}

/** Matches ids made by newId(prefix). */
export function idPattern(prefix?: string): RegExp {
  return new RegExp(`^${prefix ? `${prefix}_` : ""}[a-f0-9]{${ID_HEX_LENGTH}}$`);
}
