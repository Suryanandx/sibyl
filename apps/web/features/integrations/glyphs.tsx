/**
 * Simple monochrome glyphs for the connector cards (currentColor, no
 * trademark artwork): a letter-mark, a four-square grid, a hash, a hub and a cloud.
 */
const GLYPHS: Record<string, string> = {
  // "G"-like arc
  google: "M19 12.2h-6.6 M19.2 12.2A7.2 7.2 0 1 1 17 7",
  // four squares
  microsoft: "M5 5h6.2v6.2H5Z M12.8 5H19v6.2h-6.2Z M5 12.8h6.2V19H5Z M12.8 12.8H19V19h-6.2Z",
  // hub with spokes
  hubspot: "M14.5 14.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M14.5 8.5V5 M14.5 5h0 M12.3 13.7 7 18.5 M12 11.5H6.5",
  // hash (channels)
  slack: "M9.5 4.5 7.5 19.5 M16.5 4.5l-2 15 M5 9h14.5 M4.5 15H19",
  // cloud
  salesforce: "M7.5 18h9.5a4 4 0 0 0 .6-7.95A5.5 5.5 0 0 0 7.2 9.1 4.5 4.5 0 0 0 7.5 18Z"
};

export function ConnectorGlyph({ id, size = 22 }: { id: string; size?: number }) {
  const path = GLYPHS[id] ?? "M6 6h12v12H6Z";
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {path.split(" M").map((segment, index) => (
        <path key={index} d={index === 0 ? segment : `M${segment}`} />
      ))}
    </svg>
  );
}
