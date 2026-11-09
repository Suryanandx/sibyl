/**
 * Sibyl theme for OpenUI-generated visuals: quiet neutral surfaces, a sage
 * accent, and the muted-but-distinct chart palette from the Sibyl PRD.
 */
import type { Theme } from "@openuidev/react-ui";

/** Ordered, distinct-but-muted categorical palette (PRD §5.1). */
const chartPalette = [
  "#5F7F9F", // slate blue
  "#78A59B", // sage teal
  "#C89A6A", // amber
  "#A39785", // stone
  "#BA8792", // dusty rose
  "#9DA86F", // olive
  "#869AA8", // blue-gray
  "#B77F6B" // terracotta
];

const palettes = {
  defaultChartPalette: chartPalette,
  barChartPalette: chartPalette,
  lineChartPalette: chartPalette,
  areaChartPalette: chartPalette,
  pieChartPalette: chartPalette,
  radarChartPalette: chartPalette,
  radialChartPalette: chartPalette,
  horizontalBarChartPalette: chartPalette
};

export const sibylLightTheme: Theme = {
  ...palettes,
  background: "#FFFFFF",
  foreground: "#FFFFFF",
  popoverBackground: "#FFFFFF",
  sunkLight: "#F7F7F5",
  sunk: "#F1F2EF",
  textNeutralPrimary: "#1D211F",
  textNeutralSecondary: "#646B67",
  textNeutralTertiary: "#8B918D",
  textBrand: "#1D211F",
  textAccentPrimary: "#1D211F",
  interactiveAccentDefault: "#1D211F",
  interactiveAccentHover: "#343A37",
  interactiveAccentPressed: "#0E100F",
  borderDefault: "#E4E7E2",
  borderInteractive: "#D5D9D3",
  borderInteractiveSelected: "#596C5D",
  borderAccent: "#596C5D",
  highlightSubtle: "#F1F2EF",
  highlight: "#E9EEE8",
  chatUserResponseBg: "#F1F2EF",
  chatUserResponseText: "#1D211F"
};

export const sibylDarkTheme: Theme = {
  ...palettes,
  background: "#1A1C1B",
  foreground: "#1A1C1B",
  popoverBackground: "#202322",
  sunkLight: "#151716",
  sunk: "#121413",
  textNeutralPrimary: "#ECEDEA",
  textNeutralSecondary: "#A3A9A5",
  textNeutralTertiary: "#7C827E",
  textBrand: "#ECEDEA",
  textAccentPrimary: "#ECEDEA",
  interactiveAccentDefault: "#ECEDEA",
  interactiveAccentHover: "#D9DBD7",
  interactiveAccentPressed: "#FFFFFF",
  borderDefault: "#2B2F2D",
  borderInteractive: "#363B38",
  borderInteractiveSelected: "#9DB3A2",
  borderAccent: "#9DB3A2",
  highlightSubtle: "#222624",
  highlight: "#26302A",
  chatUserResponseBg: "#262A28",
  chatUserResponseText: "#ECEDEA"
};
