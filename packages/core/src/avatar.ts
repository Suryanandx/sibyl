/**
 * Agent avatars ("dots"): Sibyl's own generator.
 *
 * Small, cute characters built from a handful of SVG shapes: no image model,
 * no network, no cost. Everything here is pure and deterministic: the same
 * spec and mood always render the same SVG string, and `randomAvatar(seed)`
 * always picks the same character for the same seed. This file has no
 * imports so the web app can use it directly (`@open-gpt-live/core/avatar`).
 *
 * Style rules: one 64×64 view box, pastel body with a slightly darker
 * outline, features drawn in a soft ink with round caps (2.4 px), cheeks in
 * the palette's blush. Pastel bodies with dark features read well on both
 * light and dark backgrounds.
 *
 * Moods change the eyes and mouth and add an animation class
 * (`sa-mood-<mood>`); the keyframes ship inside the SVG so it animates
 * wherever it is shown, and `prefers-reduced-motion` turns them off.
 */

export const AVATAR_KINDS = ["dot", "blob", "cat", "bird", "bot", "ghost", "custom-image"] as const;
export type AvatarKind = (typeof AVATAR_KINDS)[number];

export const AVATAR_EYES = ["round", "happy", "sleepy", "wink", "sparkle", "dot"] as const;
export type AvatarEyes = (typeof AVATAR_EYES)[number];

export const AVATAR_MOUTHS = ["smile", "grin", "o", "flat", "cat", "tongue"] as const;
export type AvatarMouth = (typeof AVATAR_MOUTHS)[number];

export const AVATAR_ACCESSORIES = ["none", "glasses", "bow", "leaf", "headphones", "hat", "star", "scarf"] as const;
export type AvatarAccessory = (typeof AVATAR_ACCESSORIES)[number];

export const AVATAR_MOODS = ["idle", "listening", "thinking", "speaking", "happy", "sleeping"] as const;
export type AvatarMood = (typeof AVATAR_MOODS)[number];

export interface AvatarPalette {
  label: string;
  body: string;
  /** Outline and shading (a little darker than the body). */
  shade: string;
  cheek: string;
  /** Accessory colour. */
  accent: string;
}

/** Sibyl-friendly palettes, derived from the app's tints (sage, slate, amber, clay …). No purple. */
export const AVATAR_PALETTES = {
  sage: { label: "Sage", body: "#cfe0d6", shade: "#8fae9b", cheek: "#f2b8b0", accent: "#596c5d" },
  slate: { label: "Slate", body: "#d3dde8", shade: "#93a6bb", cheek: "#f0b9c0", accent: "#4f6378" },
  amber: { label: "Amber", body: "#f3dcc0", shade: "#d0a574", cheek: "#ee9f8f", accent: "#a86f38" },
  clay: { label: "Clay", body: "#ecd8cc", shade: "#c49a82", cheek: "#ee9f8f", accent: "#8f5a44" },
  rose: { label: "Rose", body: "#f4d4d6", shade: "#d79aa0", cheek: "#ea8f99", accent: "#b84f58" },
  sky: { label: "Sky", body: "#cfe6f2", shade: "#86b5cc", cheek: "#f3b2b8", accent: "#3f7f9c" },
  mint: { label: "Mint", body: "#cdeedf", shade: "#7fc0a3", cheek: "#f4b0a8", accent: "#327e62" },
  sand: { label: "Sand", body: "#ebe3d3", shade: "#bdae8f", cheek: "#eba99b", accent: "#7d6a48" }
} as const satisfies Record<string, AvatarPalette>;

export type AvatarPaletteId = keyof typeof AVATAR_PALETTES;
export const AVATAR_PALETTE_IDS = Object.keys(AVATAR_PALETTES) as AvatarPaletteId[];

export interface AvatarSpec {
  /** Any string; "Shuffle" picks a new one. */
  seed: string;
  kind: AvatarKind;
  palette: AvatarPaletteId;
  eyes: AvatarEyes;
  mouth: AvatarMouth;
  accessory: AvatarAccessory;
  /** Upload id of the person's own image (kind "custom-image"). */
  imageUploadId?: string;
}

export interface RenderAvatarOptions {
  mood?: AvatarMood;
  /** Rendered width and height in px (default 48). */
  size?: number;
  /** Accessible name (e.g. the agent's name). Without it the SVG is decorative. */
  title?: string;
  /** URL of the uploaded image for kind "custom-image" (falls back to a dot without it). */
  imageUrl?: string;
  /** Leave out the embedded keyframes (when the page already has them, e.g. in long lists). */
  omitStyles?: boolean;
}

const INK = "#2a2f2c";
const STROKE = 2.4;

/* ───────────── deterministic randomness ───────────── */

/** FNV-1a 32-bit hash. */
export function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Small deterministic generator (mulberry32) seeded from a string. */
function rng(seed: string): () => number {
  let state = hashSeed(seed) || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(next: () => number, items: readonly T[]): T {
  return items[Math.floor(next() * items.length) % items.length]!;
}

/** A complete, deterministic avatar for a seed (never "custom-image"). */
export function randomAvatar(seed: string): AvatarSpec {
  const next = rng(seed);
  const kinds = AVATAR_KINDS.filter((kind) => kind !== "custom-image");
  const kind = pick(next, kinds);
  const palette = pick(next, AVATAR_PALETTE_IDS);
  const eyes = pick(next, AVATAR_EYES);
  const mouth = pick(next, AVATAR_MOUTHS);
  // About half of the characters wear something.
  const accessory = next() < 0.5 ? "none" : pick(next, AVATAR_ACCESSORIES.filter((a) => a !== "none"));
  return { seed, kind, palette, eyes, mouth, accessory };
}

/** A fresh seed derived from the current one (the "Shuffle" button, deterministic for tests). */
export function nextSeed(seed: string): string {
  return (hashSeed(`${seed}:shuffle`) >>> 0).toString(36);
}

/** Coerce untrusted input into a valid spec (unknown values fall back to the seed's random choice). */
export function normalizeAvatar(input: unknown, fallbackSeed = "sibyl"): AvatarSpec {
  const value = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const seed = typeof value.seed === "string" && value.seed.trim() ? value.seed.trim().slice(0, 64) : fallbackSeed;
  const base = randomAvatar(seed);
  const oneOf = <T extends string>(items: readonly T[], candidate: unknown, fallback: T): T =>
    typeof candidate === "string" && (items as readonly string[]).includes(candidate) ? (candidate as T) : fallback;
  const spec: AvatarSpec = {
    seed,
    kind: oneOf(AVATAR_KINDS, value.kind, base.kind),
    // "lavender" was retired (no purple in Sibyl); avatars saved with it become clay.
    palette: oneOf(AVATAR_PALETTE_IDS, value.palette === "lavender" ? "clay" : value.palette, base.palette),
    eyes: oneOf(AVATAR_EYES, value.eyes, base.eyes),
    mouth: oneOf(AVATAR_MOUTHS, value.mouth, base.mouth),
    accessory: oneOf(AVATAR_ACCESSORIES, value.accessory, base.accessory)
  };
  if (typeof value.imageUploadId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value.imageUploadId)) {
    spec.imageUploadId = value.imageUploadId;
  }
  return spec;
}

/* ───────────── rendering ───────────── */

/** Eyes and mouth actually drawn for a mood (idle shows the spec's own). */
export function featuresForMood(spec: Pick<AvatarSpec, "eyes" | "mouth">, mood: AvatarMood): { eyes: AvatarEyes | "closed" | "up"; mouth: AvatarMouth | "talk" | "small-o" } {
  switch (mood) {
    case "listening":
      return { eyes: "round", mouth: "small-o" };
    case "thinking":
      return { eyes: "up", mouth: "flat" };
    case "speaking":
      return { eyes: spec.eyes === "sleepy" ? "round" : spec.eyes, mouth: "talk" };
    case "happy":
      return { eyes: "happy", mouth: "grin" };
    case "sleeping":
      return { eyes: "closed", mouth: "flat" };
    default:
      return { eyes: spec.eyes, mouth: spec.mouth };
  }
}

/** The SVG markup for an avatar in a mood. Pure: same input, same string. */
export function renderAvatarSvg(spec: AvatarSpec, options: RenderAvatarOptions = {}): string {
  const mood: AvatarMood = (AVATAR_MOODS as readonly string[]).includes(options.mood ?? "") ? options.mood! : "idle";
  const size = clampSize(options.size);
  const palette = AVATAR_PALETTES[spec.palette] ?? AVATAR_PALETTES.sage;
  const uid = `sa${hashSeed(`${spec.seed}|${spec.kind}|${spec.palette}`).toString(36)}`;
  const label = options.title?.trim();
  const a11y = label ? `role="img" aria-label="${escapeXml(label)}"` : `aria-hidden="true" focusable="false"`;
  const parts: string[] = [];

  if (!options.omitStyles) parts.push(`<style>${AVATAR_CSS}</style>`);
  if (label) parts.push(`<title>${escapeXml(label)}</title>`);

  const useImage = spec.kind === "custom-image" && options.imageUrl && /^(https?:\/\/|\/|blob:|data:image\/)/.test(options.imageUrl);
  const kind: Exclude<AvatarKind, "custom-image"> = spec.kind === "custom-image" ? "dot" : spec.kind;

  parts.push(`<g class="sa-body">`);
  if (useImage) {
    parts.push(
      `<defs><clipPath id="${uid}-clip"><circle cx="32" cy="32" r="27"/></clipPath></defs>`,
      `<circle cx="32" cy="32" r="28.5" fill="${palette.body}" stroke="${palette.shade}" stroke-width="1.5"/>`,
      `<image href="${escapeXml(options.imageUrl!)}" x="5" y="5" width="54" height="54" preserveAspectRatio="xMidYMid slice" clip-path="url(#${uid}-clip)"/>`
    );
  } else {
    parts.push(bodyShape(kind, palette));
    const features = featuresForMood(spec, mood);
    const faceY = kind === "ghost" ? -2 : kind === "bot" ? 1 : 0;
    parts.push(`<g transform="translate(0 ${faceY})">`);
    parts.push(cheeks(palette, kind));
    parts.push(`<g class="sa-eyes">${eyes(features.eyes)}</g>`);
    parts.push(kind === "bird" ? beak(palette) : "");
    parts.push(`<g class="sa-mouth">${mouth(features.mouth, palette)}</g>`);
    parts.push(`</g>`);
    parts.push(accessory(spec.accessory, palette, kind));
  }
  parts.push(`</g>`);
  parts.push(moodExtras(mood, palette));

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}" ` +
    `class="sibyl-avatar sa-kind-${kind} sa-mood-${mood}" data-mood="${mood}" ${a11y}>` +
    parts.join("") +
    `</svg>`
  );
}

function clampSize(size: number | undefined): number {
  if (typeof size !== "number" || !Number.isFinite(size)) return 48;
  return Math.max(12, Math.min(512, Math.round(size)));
}

function bodyShape(kind: Exclude<AvatarKind, "custom-image">, p: AvatarPalette): string {
  const fill = `fill="${p.body}" stroke="${p.shade}" stroke-width="1.6" stroke-linejoin="round"`;
  switch (kind) {
    case "dot":
      return `<circle cx="32" cy="34" r="23" ${fill}/>` + `<ellipse cx="24" cy="22" rx="6" ry="3.5" fill="#ffffff" opacity=".45"/>`;
    case "blob":
      return (
        `<path d="M32 10c10 0 21 6 22 18 1 9-2 15-6 20-5 6-12 8-17 8-8 0-16-3-20-10-3-5-4-12-1-19C13 17 21 10 32 10z" ${fill}/>` +
        `<ellipse cx="23" cy="21" rx="6" ry="3.2" fill="#ffffff" opacity=".45" transform="rotate(-18 23 21)"/>`
      );
    case "cat":
      return (
        `<path d="M14 26 L12 8 L26 16 Z" ${fill}/><path d="M50 26 L52 8 L38 16 Z" ${fill}/>` +
        `<path d="M16 13 L15.5 20 L21 16.5 Z" fill="${p.cheek}" opacity=".7"/><path d="M48 13 L48.5 20 L43 16.5 Z" fill="${p.cheek}" opacity=".7"/>` +
        `<ellipse cx="32" cy="36" rx="23" ry="20" ${fill}/>` +
        `<path d="M9 38 h-5 M9 42 l-5 2 M55 38 h5 M55 42 l5 2" stroke="${p.shade}" stroke-width="1.4" stroke-linecap="round"/>`
      );
    case "bird":
      return (
        `<path d="M30 12c-2-4 0-7 3-7-1 2 0 4 2 5" fill="none" stroke="${p.shade}" stroke-width="2" stroke-linecap="round"/>` +
        `<circle cx="32" cy="35" r="22" ${fill}/>` +
        `<path d="M12 40c-4 1-6 5-5 9 4-1 7-3 8-6" fill="${p.shade}" opacity=".55"/>` +
        `<path d="M52 40c4 1 6 5 5 9-4-1-7-3-8-6" fill="${p.shade}" opacity=".55"/>` +
        `<ellipse cx="32" cy="46" rx="11" ry="7" fill="#ffffff" opacity=".35"/>`
      );
    case "bot":
      return (
        `<line x1="32" y1="13" x2="32" y2="6" stroke="${p.shade}" stroke-width="2" stroke-linecap="round"/>` +
        `<circle class="sa-antenna" cx="32" cy="5.5" r="3" fill="${p.accent}"/>` +
        `<rect x="6" y="30" width="5" height="10" rx="2" fill="${p.shade}"/><rect x="53" y="30" width="5" height="10" rx="2" fill="${p.shade}"/>` +
        `<rect x="10" y="13" width="44" height="40" rx="13" ${fill}/>` +
        `<rect x="15" y="20" width="34" height="26" rx="9" fill="#ffffff" opacity=".35"/>`
      );
    case "ghost":
      return (
        `<path d="M12 34c0-13 9-23 20-23s20 10 20 23v20c-3 0-4-3-6.7-3S41 54 38.7 54 35 51 32 51s-4 3-6.7 3S22 51 19 51s-4 3-7 3z" ${fill}/>` +
        `<ellipse cx="23" cy="21" rx="5" ry="3" fill="#ffffff" opacity=".5" transform="rotate(-20 23 21)"/>`
      );
  }
}

function cheeks(p: AvatarPalette, kind: Exclude<AvatarKind, "custom-image">): string {
  if (kind === "bot") {
    return `<rect x="16" y="38" width="6" height="3" rx="1.5" fill="${p.cheek}" opacity=".8"/><rect x="42" y="38" width="6" height="3" rx="1.5" fill="${p.cheek}" opacity=".8"/>`;
  }
  return `<ellipse cx="18.5" cy="39.5" rx="4" ry="2.6" fill="${p.cheek}" opacity=".75"/><ellipse cx="45.5" cy="39.5" rx="4" ry="2.6" fill="${p.cheek}" opacity=".75"/>`;
}

function eyes(kind: AvatarEyes | "closed" | "up"): string {
  const s = `stroke="${INK}" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round" fill="none"`;
  const both = (draw: (x: number) => string): string => draw(24) + draw(40);
  switch (kind) {
    case "round":
      return both((x) => `<circle cx="${x}" cy="32" r="3.4" fill="${INK}"/><circle cx="${x + 1.2}" cy="30.8" r="1.1" fill="#ffffff"/>`);
    case "dot":
      return both((x) => `<circle cx="${x}" cy="32" r="2.2" fill="${INK}"/>`);
    case "happy":
      return both((x) => `<path d="M${x - 3.5} 33 q3.5 -4.5 7 0" ${s}/>`);
    case "sleepy":
      return both((x) => `<path d="M${x - 3.5} 32 q3.5 2.8 7 0" ${s}/><path d="M${x - 3.8} 30.2 h7.6" ${s} opacity=".5"/>`);
    case "wink":
      return `<circle cx="24" cy="32" r="3.4" fill="${INK}"/><circle cx="25.2" cy="30.8" r="1.1" fill="#ffffff"/><path d="M36.5 33 q3.5 -4 7 0" ${s}/>`;
    case "sparkle":
      return both(
        (x) =>
          `<circle cx="${x}" cy="32" r="3.8" fill="${INK}"/><circle cx="${x + 1.3}" cy="30.6" r="1.4" fill="#ffffff"/><circle cx="${x - 1.2}" cy="33.6" r=".7" fill="#ffffff"/>`
      );
    case "closed":
      return both((x) => `<path d="M${x - 3.5} 32.5 q3.5 2.5 7 0" ${s}/>`);
    case "up":
      return both((x) => `<circle cx="${x}" cy="32" r="3.4" fill="#ffffff" stroke="${INK}" stroke-width="1.4"/><circle cx="${x + 1}" cy="30.6" r="1.7" fill="${INK}"/>`);
  }
}

function mouth(kind: AvatarMouth | "talk" | "small-o", p: AvatarPalette): string {
  const s = `stroke="${INK}" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round" fill="none"`;
  switch (kind) {
    case "smile":
      return `<path d="M28 41 q4 4 8 0" ${s}/>`;
    case "grin":
      return `<path d="M27 40 q5 0 10 0 q-1 6 -5 6 q-4 0 -5 -6 z" fill="${INK}" stroke="${INK}" stroke-width="1.2" stroke-linejoin="round"/><path d="M29.5 44.2 q2.5 1.6 5 0" fill="${p.cheek}"/>`;
    case "o":
      return `<ellipse cx="32" cy="42.5" rx="2.6" ry="3" fill="${INK}"/>`;
    case "small-o":
      return `<ellipse cx="32" cy="42.5" rx="1.8" ry="2.1" fill="${INK}"/>`;
    case "flat":
      return `<path d="M29 42 h6" ${s}/>`;
    case "cat":
      return `<path d="M27.5 41 q2.25 2.6 4.5 0 q2.25 2.6 4.5 0" ${s}/>`;
    case "tongue":
      return `<path d="M28 40.5 q4 4 8 0" ${s}/><path d="M30.6 42.6 q1.4 3.6 2.8 0" fill="${p.cheek}" stroke="${INK}" stroke-width="1.2"/>`;
    case "talk":
      return `<ellipse class="sa-talk" cx="32" cy="42.5" rx="3.2" ry="2.6" fill="${INK}"/>`;
  }
}

function beak(p: AvatarPalette): string {
  return `<path d="M29 37.5 L35 37.5 L32 41.5 Z" fill="${p.accent}" stroke="${INK}" stroke-width="1" stroke-linejoin="round"/>`;
}

function accessory(kind: AvatarAccessory, p: AvatarPalette, body: Exclude<AvatarKind, "custom-image">): string {
  const s = `stroke="${INK}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"`;
  const top = body === "cat" ? 15 : body === "bot" ? 13 : body === "ghost" ? 12 : 12;
  switch (kind) {
    case "none":
      return "";
    case "glasses":
      return `<g class="sa-acc"><circle cx="24" cy="32" r="6" ${s}/><circle cx="40" cy="32" r="6" ${s}/><path d="M30 32 h4" ${s}/></g>`;
    case "bow":
      return `<g class="sa-acc" transform="translate(44 ${top + 2}) rotate(18)"><path d="M0 0 L-8 -5 L-8 5 Z M0 0 L8 -5 L8 5 Z" fill="${p.accent}" stroke="${INK}" stroke-width="1.2" stroke-linejoin="round"/><circle r="2.2" fill="${p.accent}" stroke="${INK}" stroke-width="1.2"/></g>`;
    case "leaf":
      return `<g class="sa-acc" transform="translate(34 ${top - 1}) rotate(-25)"><path d="M0 0 C 2 -9 10 -11 14 -9 C 12 -3 6 1 0 0 Z" fill="#7fb08d" stroke="${INK}" stroke-width="1.2"/><path d="M0 0 C 4 -3 8 -6 12 -8" stroke="${INK}" stroke-width="1" fill="none"/></g>`;
    case "headphones":
      return `<g class="sa-acc"><path d="M11 34 C 11 14 53 14 53 34" ${s}/><rect x="6.5" y="30" width="8" height="12" rx="3.5" fill="${p.accent}" stroke="${INK}" stroke-width="1.4"/><rect x="49.5" y="30" width="8" height="12" rx="3.5" fill="${p.accent}" stroke="${INK}" stroke-width="1.4"/></g>`;
    case "hat":
      return `<g class="sa-acc" transform="translate(0 ${top - 12})"><path d="M18 14 h28 l-3 -10 h-22 z" fill="${p.accent}" stroke="${INK}" stroke-width="1.4" stroke-linejoin="round"/><path d="M14 14.5 h36" stroke="${INK}" stroke-width="2.2" stroke-linecap="round"/><path d="M20 10 h24" stroke="#ffffff" stroke-width="1.6" opacity=".55"/></g>`;
    case "star":
      return `<g class="sa-acc sa-twinkle" transform="translate(47 ${top + 1})"><path d="M0 -6 L1.8 -1.8 L6 0 L1.8 1.8 L0 6 L-1.8 1.8 L-6 0 L-1.8 -1.8 Z" fill="#f4c95d" stroke="${INK}" stroke-width="1" stroke-linejoin="round"/></g>`;
    case "scarf":
      return `<g class="sa-acc"><path d="M15 50 q17 7 34 0 l0 4 q-17 7 -34 0 z" fill="${p.accent}" stroke="${INK}" stroke-width="1.3" stroke-linejoin="round"/><path d="M41 54 l3 8 l5 -2 l-3 -7" fill="${p.accent}" stroke="${INK}" stroke-width="1.3" stroke-linejoin="round"/></g>`;
  }
}

function moodExtras(mood: AvatarMood, p: AvatarPalette): string {
  switch (mood) {
    case "thinking":
      return `<g class="sa-dots" fill="${p.accent}"><circle cx="50" cy="12" r="2"/><circle cx="56" cy="9" r="2"/><circle cx="62" cy="6" r="2"/></g>`;
    case "sleeping":
      return `<g class="sa-zz" fill="none" stroke="${p.accent}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M48 8 h6 l-6 7 h6"/><path d="M56 2 h4 l-4 4.5 h4" opacity=".7"/></g>`;
    case "listening":
      return `<g class="sa-waves" fill="none" stroke="${p.accent}" stroke-width="1.8" stroke-linecap="round"><path d="M57 26 q3 6 0 12"/><path d="M60.5 22 q5 10 0 20" opacity=".6"/></g>`;
    case "happy":
      return `<g class="sa-twinkle" fill="#f4c95d" stroke="${INK}" stroke-width=".8"><path d="M54 10 l1.2 2.8 2.8 1.2 -2.8 1.2 -1.2 2.8 -1.2 -2.8 -2.8 -1.2 2.8 -1.2z"/></g>`;
    default:
      return "";
  }
}

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Keyframes and mood animations (scoped by the sibyl-avatar class). */
export const AVATAR_CSS = [
  ".sibyl-avatar{overflow:visible}",
  ".sibyl-avatar .sa-body{transform-origin:32px 56px;transform-box:view-box}",
  ".sibyl-avatar .sa-eyes{transform-origin:32px 32px;transform-box:view-box}",
  ".sibyl-avatar .sa-talk{transform-origin:32px 42.5px;transform-box:view-box}",
  ".sa-mood-idle .sa-body{animation:saBreathe 4.2s ease-in-out infinite}",
  ".sa-mood-idle .sa-eyes{animation:saBlink 5.5s infinite}",
  ".sa-mood-listening .sa-body{animation:saTilt 2.4s ease-in-out infinite}",
  ".sa-mood-listening .sa-waves{animation:saFade 1.6s ease-in-out infinite}",
  ".sa-mood-thinking .sa-dots circle{animation:saFade 1.4s ease-in-out infinite}",
  ".sa-mood-thinking .sa-dots circle:nth-child(2){animation-delay:.2s}",
  ".sa-mood-thinking .sa-dots circle:nth-child(3){animation-delay:.4s}",
  ".sa-mood-speaking .sa-talk{animation:saTalk .42s ease-in-out infinite alternate}",
  ".sa-mood-speaking .sa-body{animation:saBreathe 1.6s ease-in-out infinite}",
  ".sa-mood-happy .sa-body{animation:saBounce 1.1s ease-in-out infinite}",
  ".sa-mood-sleeping .sa-body{animation:saBreathe 5s ease-in-out infinite}",
  ".sa-mood-sleeping .sa-zz{animation:saFloat 3s ease-in-out infinite}",
  ".sibyl-avatar .sa-twinkle{animation:saFade 2.2s ease-in-out infinite}",
  "@keyframes saBreathe{0%,100%{transform:scale(1)}50%{transform:scale(1.025,.985)}}",
  "@keyframes saBlink{0%,92%,100%{transform:scaleY(1)}95%{transform:scaleY(.1)}}",
  "@keyframes saTilt{0%,100%{transform:rotate(0)}50%{transform:rotate(-4deg)}}",
  "@keyframes saTalk{from{transform:scaleY(.35)}to{transform:scaleY(1.15)}}",
  "@keyframes saBounce{0%,100%{transform:translateY(0)}40%{transform:translateY(-3px) scale(1.02,.98)}}",
  "@keyframes saFade{0%,100%{opacity:.25}50%{opacity:1}}",
  "@keyframes saFloat{0%{opacity:0;transform:translate(0,4px)}40%{opacity:1}100%{opacity:0;transform:translate(3px,-4px)}}",
  "@media (prefers-reduced-motion:reduce){.sibyl-avatar *{animation:none!important}}"
].join("");
