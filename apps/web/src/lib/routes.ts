/** The route editor lives inside its trip. Old /routes/:id links redirect here. */
export const routeHref = (tripId: string, routeId: string, hash?: string) =>
  `/trips/${tripId}/routes/${routeId}${hash ? `#${hash}` : ""}`;

/** Reads the trip and route out of a pathname, for the menu. */
export function tripContext(path: string): { tripId?: string; routeId?: string } {
  const m = path.match(/^\/trips\/([^/]+)(?:\/routes\/([^/]+))?/);
  return { tripId: m?.[1], routeId: m?.[2] };
}

/** "Asia 2027" → "A27", "Japan rail circuit" → "JRC": the tile in the folded menu. */
export function tripTile(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const out = parts
    .map((w) => (/^\d+$/.test(w) ? w.slice(-2) : w[0]!.toUpperCase()))
    .join("");
  return out.slice(0, 3) || "T";
}
