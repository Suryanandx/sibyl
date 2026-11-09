import {
  buildSvgUpdateUrl,
  normalizeSvgColor,
  unwrapSvgUpdateUrl,
} from "@/lib/svg-color";

export function getSmartSlideIconSource(
  source: string,
  color: string | null,
  baseUrl: string,
): string {
  const normalizedColor = normalizeSvgColor(color);
  if (!normalizedColor) return source;

  const unwrappedSource = unwrapSvgUpdateUrl(source, baseUrl);
  if (!unwrappedSource) return source;

  try {
    const url = new URL(unwrappedSource, baseUrl);
    // The SVG transform serves bundled icons, including their cloud URLs.
    if (
      !url.pathname.startsWith("/static/icons/") ||
      !url.pathname.toLowerCase().endsWith(".svg")
    ) {
      return source;
    }
  } catch {
    return source;
  }

  return buildSvgUpdateUrl(source, baseUrl, {
    color: normalizedColor,
    // A saved legacy fill/stroke must not override the icon's current color.
    fill: null,
    stroke: null,
  }) ?? source;
}

export function applySmartSlideIconColors(root: ParentNode, baseUrl: string) {
  root.querySelectorAll<HTMLImageElement>('img[image-type="icon"][color]')
    .forEach((image) => {
      const source = image.getAttribute("src");
      if (!source) return;
      const nextSource = getSmartSlideIconSource(
        source,
        image.getAttribute("color"),
        baseUrl,
      );
      if (nextSource !== source) image.setAttribute("src", nextSource);
    });
}
