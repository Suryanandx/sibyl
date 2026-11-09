"use client";

import { useEffect, useMemo, useState } from "react";
import { Image as KonvaImage, Text } from "react-konva";
import { loadKonvaImage } from "@/components/slide-editor/surface/exportAssets";
import { mathSvgDataUri, normalizeMathLatex } from "@/lib/math";

export function LatexRunNode({
  color,
  displayMode = false,
  fontSize,
  height,
  interactive,
  latex,
  width,
  x,
  y,
}: {
  color: string;
  displayMode?: boolean;
  fontSize: number;
  height: number;
  interactive: boolean;
  latex: string;
  width: number;
  x: number;
  y: number;
}) {
  const normalized = normalizeMathLatex(latex);
  const source = useMemo(
    () =>
      mathSvgDataUri({
        align: "left",
        color,
        displayMode,
        fontSize,
        height,
        latex: normalized,
        verticalAlign: "middle",
        width,
      }),
    [color, displayMode, fontSize, height, normalized, width],
  );
  const [loaded, setLoaded] = useState<{
    source: string;
    image: HTMLImageElement | null;
  } | null>(null);

  useEffect(() => {
    let active = true;
    if (source) {
      void loadKonvaImage(source).then((image) => {
        if (active) setLoaded({ source, image });
      });
    }
    return () => {
      active = false;
    };
  }, [source]);

  const image = loaded?.source === source ? loaded.image : null;

  if (image) {
    return (
      <KonvaImage
        x={x}
        y={y}
        image={image}
        width={width}
        height={height}
        listening={interactive}
      />
    );
  }

  return (
    <Text
      x={x}
      y={y}
      width={width}
      height={height}
      text={normalized}
      fill={color}
      fontFamily="Arial, Helvetica, sans-serif"
      fontSize={Math.max(8, Math.min(fontSize, 24))}
      fontStyle="italic"
      verticalAlign="middle"
      wrap="none"
      listening={interactive}
    />
  );
}
