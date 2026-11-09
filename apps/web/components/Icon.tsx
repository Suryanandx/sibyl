"use client";

/** Minimal 1.6px-stroke icon set (24×24 grid) used across the Sibyl UI. */
const PATHS = {
  chat: "M7 18.5 3.5 21V6.5A2.5 2.5 0 0 1 6 4h12a2.5 2.5 0 0 1 2.5 2.5v9.5A2.5 2.5 0 0 1 18 18.5Z M8 9.5h8 M8 13h5",
  sparkle: "M12 3.5l1.6 4.4 4.4 1.6-4.4 1.6L12 15.5l-1.6-4.4L6 9.5l4.4-1.6Z M18.5 15l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7Z",
  mic: "M12 3.5a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0v-5a3 3 0 0 1 3-3Z M5.5 11a6.5 6.5 0 0 0 13 0 M12 17.5V21",
  hand: "M8 12V6.5a1.5 1.5 0 0 1 3 0V11 M11 10.5V5a1.5 1.5 0 0 1 3 0v6 M14 10.5V6.5a1.5 1.5 0 0 1 3 0V14a6 6 0 0 1-6 6h-.5a5.5 5.5 0 0 1-4.6-2.5L4 14.4a1.5 1.5 0 0 1 2.4-1.8L8 14.5",
  sliders: "M4 7h9 M17 7h3 M15 5v4 M4 17h3 M11 17h9 M9 15v4 M4 12h5 M13 12h7 M11 10v4",
  share: "M12 3.5v11 M8 7.5l4-4 4 4 M5.5 12.5v5A2.5 2.5 0 0 0 8 20h8a2.5 2.5 0 0 0 2.5-2.5v-5",
  plus: "M12 5v14 M5 12h14",
  search: "M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13Z M20 20l-4.8-4.8",
  sun: "M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9Z M12 2.5v2 M12 19.5v2 M2.5 12h2 M19.5 12h2 M5.3 5.3l1.4 1.4 M17.3 17.3l1.4 1.4 M5.3 18.7l1.4-1.4 M17.3 6.7l1.4-1.4",
  moon: "M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z",
  chevronDown: "M6 9.5l6 6 6-6",
  arrowUp: "M12 19V5 M6 11l6-6 6 6",
  stop: "M7.5 6.5h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z",
  copy: "M9 9h9.5a1 1 0 0 1 1 1v9.5a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1Z M16 9V5.5a1 1 0 0 0-1-1H5.5a1 1 0 0 0-1 1V15a1 1 0 0 0 1 1H8",
  code: "M8.5 7.5 4 12l4.5 4.5 M15.5 7.5 20 12l-4.5 4.5 M13.5 5l-3 14",
  activity: "M3.5 12h4l2.5-6 4 12 2.5-6h4",
  menu: "M4 7h16 M4 12h16 M4 17h16",
  close: "M6 6l12 12 M18 6 6 18",
  check: "M5 12.5l4.5 4.5L19 7.5",
  layers: "M12 4 3.5 8.5 12 13l8.5-4.5Z M3.5 12.5 12 17l8.5-4.5 M3.5 16.5 12 21l8.5-4.5",
  slides: "M4 5h16 M5 5v9.5a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5V5 M12 16v3.5 M9 21l3-1.5 3 1.5 M8.5 12.5l2.5-3 2 2 2.5-3",
  plug: "M9 3.5v4 M15 3.5v4 M6.5 7.5h11v3a5.5 5.5 0 0 1-11 0Z M12 16v4.5",
  history: "M4 12a8 8 0 1 0 2.4-5.7 M4 4.5v3.5h3.5 M12 8v4.5l3 2",
  pencil: "M15.5 5.5l3 3 M4.5 19.5l1-4L16 5a2.1 2.1 0 0 1 3 3L8.5 18.5Z"
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  size = 18,
  className,
  strokeWidth = 1.6
}: {
  name: IconName;
  size?: number;
  className?: string;
  strokeWidth?: number;
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
