import { withBasePathIfAppPath } from "@/utils/basePath";
export type LocalFontOption = {
  family: string;
  sourceUrl: string;
  italicSourceUrl?: string;
  faces?: LocalFontFace[];
  aliases?: string[];
};

type LocalFontFace = {
  sourceUrl: string;
  style: "italic" | "normal";
  weight: number | string;
};

export type TemplateFontOption = LocalFontOption;

const font = (
  family: string,
  category: string,
  directory: string,
  file: string,
  italicFile?: string,
): LocalFontOption => ({
  family,
  sourceUrl: `/vendor/fonts/${category}/${directory}/${file}`,
  ...(italicFile
    ? {
        italicSourceUrl: `/vendor/fonts/${category}/${directory}/${italicFile}`,
      }
    : {}),
});

const staticFont = (
  family: string,
  category: string,
  directory: string,
  files: string[],
): LocalFontOption => {
  const faces = files.map((fileName) => ({
    sourceUrl: `/vendor/fonts/${category}/${directory}/${fileName}`,
    style: /italic/i.test(fileName) ? "italic" as const : "normal" as const,
    weight: fontWeightFromFileName(fileName),
  }));
  const normalFace = faces.find(
    (face) => face.style === "normal" && face.weight === 400,
  ) ?? faces.find((face) => face.style === "normal") ?? faces[0];
  const italicFace = faces.find(
    (face) => face.style === "italic" && face.weight === 400,
  );
  return {
    family,
    sourceUrl: normalFace.sourceUrl,
    ...(italicFace ? { italicSourceUrl: italicFace.sourceUrl } : {}),
    faces,
  };
};

function fontWeightFromFileName(fileName: string) {
  if (/black/i.test(fileName)) return 900;
  if (/extra[-_ ]?bold/i.test(fileName)) return 800;
  if (/semi[-_ ]?bold/i.test(fileName)) return 600;
  if (/bold/i.test(fileName)) return 700;
  if (/medium/i.test(fileName)) return 500;
  if (/extra[-_ ]?light/i.test(fileName)) return 200;
  if (/light/i.test(fileName)) return 300;
  if (/thin/i.test(fileName)) return 100;
  return 400;
}

/**
 * Sibyl Slides ships a curated font set (Inter for every Sibyl template, plus
 * a small picker selection). Keep this list, `public/vendor/fonts` and
 * `servers/fastapi/assets/fonts.json` in step.
 */
export const LOCAL_FONT_OPTIONS: LocalFontOption[] = [
  font("Inter", "sans_serif", "inter", "Inter[opsz,wght].ttf", "Inter-Italic[opsz,wght].ttf"),
  font("DM Sans", "sans_serif", "dmsans", "DMSans[opsz,wght].ttf", "DMSans-Italic[opsz,wght].ttf"),
  staticFont("Lato", "sans_serif", "lato", ["Lato-Regular.ttf", "Lato-Italic.ttf", "Lato-Bold.ttf"]),
  font("Montserrat", "sans_serif", "montserrat", "Montserrat[wght].ttf", "Montserrat-Italic[wght].ttf"),
  font("Open Sans", "sans_serif", "opensans", "OpenSans[wdth,wght].ttf", "OpenSans-Italic[wdth,wght].ttf"),
  staticFont("Poppins", "sans_serif", "poppins", ["Poppins-Regular.ttf", "Poppins-Italic.ttf", "Poppins-Medium.ttf", "Poppins-SemiBold.ttf", "Poppins-Bold.ttf"]),
  font("Roboto", "sans_serif", "roboto", "Roboto[wdth,wght].ttf", "Roboto-Italic[wdth,wght].ttf"),

  font("Lora", "serif", "lora", "Lora[wght].ttf", "Lora-Italic[wght].ttf"),
  font("Playfair Display", "serif", "playfairdisplay", "PlayfairDisplay[wght].ttf", "PlayfairDisplay-Italic[wght].ttf"),
  font("Source Serif 4", "serif", "sourceserif4", "SourceSerif4[opsz,wght].ttf"),

  font("JetBrains Mono", "monospace", "jetbrainsmono", "JetBrainsMono[wght].ttf", "JetBrainsMono-Italic[wght].ttf"),

  font("Caveat", "handwritten", "caveat", "Caveat[wght].ttf"),
];

/**
 * Families from the upstream catalog that are no longer bundled. Decks (or
 * imported templates) that name one of them render in Inter instead of a
 * browser default, so text metrics stay predictable.
 */
export const REMOVED_FONT_FAMILIES: readonly string[] = [
  "Abril Fatface", "Anton", "Archivo Black", "Bebas Neue", "Black Ops One", "Bungee", "Cinzel", "Fugaz One",
  "League Spartan", "Lilita One", "Oswald", "Righteous", "Russo One", "Staatliches", "Unbounded",
  "Architects Daughter", "Coming Soon", "Gloria Hallelujah", "Indie Flower", "Kalam", "Nanum Pen Script",
  "Patrick Hand", "Schoolbell", "Shadows Into Light",
  "Anonymous Pro", "Cutive Mono", "DM Mono", "Fira Code", "Fira Mono", "IBM Plex Mono", "Inconsolata",
  "Noto Sans Mono", "PT Mono", "Red Hat Mono", "Roboto Mono", "Source Code Pro", "Space Mono", "Ubuntu Mono",
  "Manrope", "Mulish", "Nunito Sans", "Outfit", "Plus Jakarta Sans", "Rubik", "Source Sans 3", "Work Sans", "Syne",
  "Alex Brush", "Allura", "Dancing Script", "Great Vibes", "Italianno", "Parisienne", "Pinyon Script",
  "Sacramento", "Tangerine", "Yellowtail",
  "Cardo", "Cormorant Garamond", "Crimson Pro", "DM Serif Display", "EB Garamond", "Fraunces",
  "Libre Baskerville", "Merriweather", "Newsreader", "Noto Serif", "Spectral", "Vollkorn",
  "Aleo", "Alfa Slab One", "Arvo", "Bevan", "BioRhyme", "Bitter", "Bree Serif", "Crete Round", "Patua One",
  "Roboto Slab", "Rokkitt", "Slabo 27px", "Suez One", "Ultra", "Zilla Slab",
];

/** The fallback for removed families: Inter's files under the removed name. */
const INTER_OPTION = LOCAL_FONT_OPTIONS.find((option) => option.family === "Inter")!;
const REMOVED_FONT_FALLBACKS: LocalFontOption[] = REMOVED_FONT_FAMILIES.map((family) => ({
  ...INTER_OPTION,
  family,
}));

const SYSTEM_FONT_FAMILY_KEYS = new Set(
  [
    "arial",
    "helvetica",
    "times",
    "times new roman",
    "georgia",
    "courier",
    "courier new",
    "verdana",
    "tahoma",
    "trebuchet ms",
    "impact",
    "comic sans ms",
    "system-ui",
    "sans-serif",
    "serif",
    "monospace",
  ].map(fontFamilyKey),
);

const LOCAL_FONT_BY_FAMILY = new Map(
  [...REMOVED_FONT_FALLBACKS, ...LOCAL_FONT_OPTIONS].map((option) => [
    fontFamilyKey(option.family),
    option,
  ]),
);
LOCAL_FONT_BY_FAMILY.set("inter variable", INTER_OPTION);

/** True when `family` was dropped from the bundle and is served by Inter. */
export function isRemovedFontFamily(family: string) {
  const option = localFontOptionForFamily(family);
  return option != null && !LOCAL_FONT_OPTIONS.includes(option);
}

const pendingFontDescriptorLoads = new Map<string, Promise<void>>();

export function localFontOptionForFamily(family: string) {
  return LOCAL_FONT_BY_FAMILY.get(fontFamilyKey(family)) ?? null;
}

export function isLocalFontFamily(family: string) {
  return localFontOptionForFamily(family) != null;
}

export function ensureLocalFontLoaded(family: string) {
  const option = localFontOptionForFamily(family);
  return option ? ensureFontOptionLoaded(option) : null;
}

export function ensureLocalFontsForDescriptors(
  descriptors: Iterable<string>,
  excludedFamilies: Iterable<string> = [],
) {
  const excludedFamilyKeys = new Set(
    Array.from(excludedFamilies).map(fontFamilyKey),
  );
  const loads: Promise<void>[] = [];

  Array.from(descriptors).forEach((descriptor) => {
    const family = fontFamilyFromFontDescriptor(descriptor);
    if (!family || excludedFamilyKeys.has(fontFamilyKey(family))) return;
    if (SYSTEM_FONT_FAMILY_KEYS.has(fontFamilyKey(family))) return;
    const load = ensureLocalFontLoaded(family);
    if (load) loads.push(load);
  });

  return loads;
}

export function templateFontOptionsFromMap(fonts: unknown): TemplateFontOption[] {
  return localFontOptionsFromUnknown(fonts);
}

export function localFontOptionsFromUnknown(value: unknown): LocalFontOption[] {
  const fontOptions = new Map<string, LocalFontOption>();

  const addFontOption = (option: LocalFontOption, preferSource = false) => {
    const key = fontFamilyKey(option.family);
    if (!key || (!preferSource && fontOptions.has(key))) return;
    fontOptions.set(key, option);
  };

  const addSourceFont = (
    family: unknown,
    sourceUrl: unknown,
    weight?: unknown,
    style?: unknown,
  ) => {
    if (typeof family !== "string" || typeof sourceUrl !== "string") return;
    const normalizedFamily = normalizeFontFamily(family);
    const normalizedSourceUrl = sourceUrl.trim();
    if (!normalizedFamily || !isFontAssetUrl(normalizedSourceUrl)) return;

    const catalogOption = localFontOptionForFamily(normalizedFamily);
    if (catalogOption && normalizedSourceUrl.startsWith("/vendor/fonts/")) {
      addFontOption(catalogOption, true);
      return;
    }

    const inferredWeight =
      readFontWeight(weight) ??
      fontWeightFromSource(normalizedFamily, normalizedSourceUrl);
    const inferredStyle =
      readFontStyle(style) ??
      (/italic/i.test(`${normalizedFamily} ${normalizedSourceUrl}`)
        ? "italic"
        : "normal");

    addFontOption(
      {
        family: normalizedFamily,
        sourceUrl: normalizedSourceUrl,
        faces: [
          {
            sourceUrl: normalizedSourceUrl,
            style: inferredStyle,
            weight: inferredWeight,
          },
        ],
        aliases: fontFamilyAliases(normalizedFamily),
      },
      true,
    );
  };

  const addFamily = (family: unknown) => {
    if (typeof family !== "string") return;
    family.split(",").forEach((candidate) => {
      const normalizedCandidate = candidate
        .trim()
        .replace(/\s*!important\s*$/i, "")
        .replace(/^(['"])(.*)\1$/, "$2")
        .trim();
      if (!normalizedCandidate) return;
      const option = localFontOptionForFamily(normalizedCandidate);
      if (option) addFontOption(option);
    });
  };

  const visit = (entry: unknown, fallbackFamily?: string) => {
    if (typeof entry === "string") {
      if (fallbackFamily && addableFontMapKey(fallbackFamily)) {
        addSourceFont(fallbackFamily, entry);
      }
      if (isFontFamilyField(fallbackFamily)) addFamily(entry);
      else addFamily(fallbackFamily);
      for (const match of entry.matchAll(
        /font-family\s*:\s*([^;{}]+)/gi,
      )) {
        addFamily(match[1]?.trim());
      }
      return;
    }
    if (Array.isArray(entry)) {
      entry.forEach((item) => visit(item, fallbackFamily));
      return;
    }
    if (!entry || typeof entry !== "object") return;

    const record = entry as Record<string, unknown>;
    const declaredFamily =
      record.family ??
      record.name ??
      record.font_name ??
      record.fontFamily ??
      record.font_family ??
      record["font-family"];
    const declaredSource =
      record.url ?? record.src ?? record.href ?? record.source ?? record.data;
    addSourceFont(
      declaredFamily ??
        (addableFontMapKey(fallbackFamily) ? fallbackFamily : undefined),
      declaredSource,
      record.weight ?? record.fontWeight ?? record.font_weight,
      record.style ?? record.fontStyle ?? record.font_style,
    );
    addFamily(declaredFamily);
    Object.entries(record).forEach(([key, nested]) => {
      if (
        [
          "family",
          "name",
          "font_name",
          "fontFamily",
          "font_family",
          "font-family",
        ].includes(key)
      ) {
        return;
      }
      if (!["css", "font_css", "fonts", "url", "src", "href", "source"].includes(key)) {
        addFamily(key);
      }
      visit(nested, key);
    });
  };

  visit(value);
  return Array.from(fontOptions.values());
}

function addableFontMapKey(field: string | undefined) {
  if (!field) return false;
  return ![
    "css",
    "font_css",
    "fonts",
    "url",
    "src",
    "href",
    "source",
    "data",
  ].includes(field.toLowerCase());
}

function isFontAssetUrl(value: string) {
  return (
    /^data:font\//i.test(value) ||
    /\.(?:eot|otf|ttf|woff2?)(?:[?#].*)?$/i.test(value)
  );
}

function normalizeFontFamily(value: string) {
  return value
    .trim()
    .replace(/\s*!important\s*$/i, "")
    .replace(/^(['"])(.*)\1$/, "$2")
    .trim();
}

function fontWeightFromSource(family: string, sourceUrl: string) {
  if (/\[[^\]]*wght[^\]]*\]/i.test(sourceUrl)) return "100 900";
  // Sibyl templates before v0.4 shipped the variable Inter as "Inter.ttf";
  // declared as weight 400 only, bold text was synthesized and the canvas
  // measured words with different metrics than it drew (word-spacing glitch).
  if (/\/templates\/sibyl-[a-z-]+\/static\/Inter\.ttf(?:[?#].*)?$/i.test(sourceUrl)) return "100 900";
  return fontWeightFromFileName(`${family} ${sourceUrl}`);
}

function readFontWeight(value: unknown): number | string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.min(1000, Math.max(1, Math.round(value)));
  }
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (/^\d{1,4}(?:\s+\d{1,4})?$/.test(normalized)) return normalized;
  return null;
}

function readFontStyle(value: unknown): "italic" | "normal" | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized === "italic" || normalized === "oblique"
    ? "italic"
    : normalized === "normal"
      ? "normal"
      : null;
}

function fontFamilyAliases(family: string) {
  const alias = family
    .replace(
      /\s+(?:thin|extra[-_ ]?light|light|regular|medium|semi[-_ ]?bold|bold|extra[-_ ]?bold|black)(?:\s+italic)?$/i,
      "",
    )
    .replace(/\s+italic$/i, "")
    .trim();
  return alias && fontFamilyKey(alias) !== fontFamilyKey(family) ? [alias] : [];
}

function isFontFamilyField(field: string | undefined) {
  if (!field) return false;
  return ["family", "fontfamily", "fontname"].includes(
    field.replace(/[-_\s]/g, "").toLowerCase(),
  );
}

export function ensureTemplateFontLoaded(fontOption: TemplateFontOption) {
  return ensureFontOptionLoaded(fontOption);
}

export function ensureTemplateFontsForDescriptors(
  descriptors: Iterable<string>,
  templateFonts: TemplateFontOption[],
) {
  const templateFontsByFamily = new Map<string, TemplateFontOption[]>();
  templateFonts.forEach((fontOption) => {
    [fontOption.family, ...(fontOption.aliases ?? [])].forEach((family) => {
      const key = fontFamilyKey(family);
      const options = templateFontsByFamily.get(key) ?? [];
      if (!options.includes(fontOption)) options.push(fontOption);
      templateFontsByFamily.set(key, options);
    });
  });
  const loads: Promise<void>[] = [];

  Array.from(descriptors).forEach((descriptor) => {
    const family = fontFamilyFromFontDescriptor(descriptor);
    const fontOptions = family
      ? templateFontsByFamily.get(fontFamilyKey(family)) ?? []
      : [];
    fontOptions.forEach((fontOption) => {
      const load = ensureFontOptionLoaded(fontOption);
      if (load) loads.push(load);
    });
  });

  return loads;
}

export function renderLocalFontFaceCss(fontOption: LocalFontOption) {
  const families = Array.from(
    new Set([fontOption.family, ...(fontOption.aliases ?? [])]),
  );
  if (fontOption.faces?.length) {
    return families
      .flatMap((family) =>
        fontOption.faces!.map(
          (face) =>
            `@font-face{font-family:"${escapeCssString(family)}";src:${fontSource(face.sourceUrl)};font-style:${face.style};font-weight:${face.weight};font-display:swap}`,
        ),
      )
      .join("");
  }
  return families
    .map((family) => {
      const escapedFamily = escapeCssString(family);
      const normalFace = `@font-face{font-family:"${escapedFamily}";src:${fontSource(fontOption.sourceUrl)};font-style:normal;font-weight:100 900;font-display:swap}`;
      const italicFace = fontOption.italicSourceUrl
        ? `@font-face{font-family:"${escapedFamily}";src:${fontSource(fontOption.italicSourceUrl)};font-style:italic;font-weight:100 900;font-display:swap}`
        : "";
      return `${normalFace}${italicFace}`;
    })
    .join("");
}

function fontSource(sourceUrl: string) {
  const assetPath = sourceUrl.split(/[?#]/, 1)[0]?.toLowerCase() ?? "";
  const format = assetPath.endsWith(".woff2")
    ? "woff2"
    : assetPath.endsWith(".woff")
      ? "woff"
      : assetPath.endsWith(".otf")
        ? "opentype"
        : assetPath.endsWith(".eot")
          ? "embedded-opentype"
          : "truetype";
  return `url("${escapeCssString(withBasePathIfAppPath(sourceUrl))}") format("${format}")`;
}

export function waitForFontDescriptorsLoaded(descriptors: Iterable<string>) {
  if (typeof document === "undefined" || !document.fonts) {
    return Promise.resolve();
  }

  const normalizedDescriptors = Array.from(
    new Set(
      Array.from(descriptors)
        .map((descriptor) => descriptor.trim())
        .filter(Boolean),
    ),
  ).sort();
  if (!normalizedDescriptors.length) return Promise.resolve();

  const cacheKey = normalizedDescriptors.join("\n");
  const pendingLoad = pendingFontDescriptorLoads.get(cacheKey);
  if (pendingLoad) return pendingLoad;

  const fonts = document.fonts;
  const loadPromise = withTimeout(
    Promise.all(
      normalizedDescriptors.map((descriptor) =>
        loadFontDescriptor(fonts, descriptor),
      ),
    )
      .then(() => fonts.ready)
      .then(() => undefined),
    3000,
  ).finally(() => {
    pendingFontDescriptorLoads.delete(cacheKey);
  });

  pendingFontDescriptorLoads.set(cacheKey, loadPromise);
  return loadPromise;
}

function ensureFontOptionLoaded(fontOption: LocalFontOption) {
  if (typeof document === "undefined") return null;

  const selector = `style[data-local-font-family="${escapeSelectorAttribute(fontOption.family)}"]`;
  const css = renderLocalFontFaceCss(fontOption);
  const catalogOption = localFontOptionForFamily(fontOption.family);
  const sourceKind = catalogOption === fontOption ? "vendor" : "template";
  let style = document.querySelector<HTMLStyleElement>(selector);
  if (!style) {
    style = document.createElement("style");
    style.setAttribute("data-local-font-family", fontOption.family);
    style.setAttribute("data-font-source", sourceKind);
    style.textContent = css;
    document.head.appendChild(style);
  } else if (
    style.textContent !== css &&
    (sourceKind === "template" || style.dataset.fontSource !== "template")
  ) {
    pendingFontDescriptorLoads.clear();
    style.setAttribute("data-font-source", sourceKind);
    style.textContent = css;
  }

  return waitForFontDescriptorsLoaded(fontFamilyLoadDescriptors(fontOption.family));
}

function loadFontDescriptor(fonts: FontFaceSet, descriptor: string) {
  try {
    return fonts.load(descriptor).then(
      () => undefined,
      () => undefined,
    );
  } catch {
    return Promise.resolve();
  }
}

function withTimeout(promise: Promise<void>, timeoutMs: number) {
  return new Promise<void>((resolve) => {
    let settled = false;
    let timeoutId: number | null = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timeoutId != null) window.clearTimeout(timeoutId);
      resolve();
    };
    timeoutId = window.setTimeout(finish, timeoutMs);
    promise.then(finish, finish);
  });
}

function fontFamilyLoadDescriptors(family: string) {
  const escapedFamily = escapeCssString(family);
  return [`400 16px "${escapedFamily}"`, `700 16px "${escapedFamily}"`];
}

function fontFamilyFromFontDescriptor(descriptor: string) {
  const match = descriptor.match(/"((?:\\.|[^"])*)"\s*$/);
  return match ? match[1].replace(/\\(["\\])/g, "$1") : null;
}

function fontFamilyKey(family: string) {
  return family.trim().toLowerCase();
}

function escapeCssString(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapeSelectorAttribute(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
