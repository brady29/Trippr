/**
 * The Trip Graph Explorer palette, exactly as the spec's colour tables.
 * Node types use shape first and a neutral or brand colour; activity tags
 * use the Okabe–Ito colour-blind-safe palette. Every colour has a variant
 * for light paper (#F4EFE4) and for the dark globe (#0F151D). The same
 * values exist as CSS tokens (--node-*, --tag-*) in globals.css.
 */
import type { GraphNodeType } from "@trippr/contracts";

export type Surface = "paper" | "globe";

export const BACKGROUND: Record<Surface, string> = { paper: "#F4EFE4", globe: "#0F151D" };
/** Label text, with a halo in the background colour. */
export const LABEL: Record<Surface, string> = { paper: "#1B222B", globe: "#F4EFE4" };
/** Outline in the opposite tone so nodes hold their edges on both backgrounds. */
export const OUTLINE: Record<Surface, string> = { paper: "#FFFDF8", globe: "#0F151D" };

export const NODE_FILL: Record<Exclude<GraphNodeType, "activity" | "country">, Record<Surface, string>> = {
  trip: { paper: "#0F151D", globe: "#FFC23D" },
  city: { paper: "#1B222B", globe: "#F4EFE4" },
  route: { paper: "#FFC23D", globe: "#FFC23D" },
  stop: { paper: "#59626E", globe: "#C9CED6" },
  area: { paper: "#9C7A00", globe: "#F0E442" },
  hotel: { paper: "#2B6CB0", globe: "#56B4E9" },
  station: { paper: "#2E7A59", globe: "#4CC38A" },
  airport: { paper: "#3867C8", globe: "#7AA2F7" },
  leg: { paper: "#59626E", globe: "#C9CED6" },
};

export const ACTIVITY_TAGS = ["sport", "tech", "nature", "culture", "food"] as const;
export type ActivityTag = (typeof ACTIVITY_TAGS)[number] | "other";

export const TAG_COLOR: Record<ActivityTag, string> = {
  sport: "#D55E00",
  tech: "#0072B2",
  nature: "#009E73",
  culture: "#CC79A7",
  food: "#E69F00",
  other: "#8C939C",
};

export const TAG_LABEL: Record<ActivityTag, string> = {
  sport: "Sport",
  tech: "Tech",
  nature: "Nature",
  culture: "Culture",
  food: "Food",
  other: "Other",
};

/** Fixed-date ring (stamp red). */
export const FIXED_DATE: Record<Surface, string> = { paper: "#C4452A", globe: "#FF7A59" };

/** Leg colours by mode: rail green, flight blue, boat/road brown, as on the route map. */
export const MODE_COLOR: Record<string, Record<Surface, string>> = {
  flight: { paper: "#3867C8", globe: "#7AA2F7" },
  hsr: { paper: "#2E7A59", globe: "#4CC38A" },
  train: { paper: "#2E7A59", globe: "#4CC38A" },
  maglev: { paper: "#2E7A59", globe: "#4CC38A" },
  boat: { paper: "#8A6D3B", globe: "#D9B77A" },
  road: { paper: "#8A6D3B", globe: "#D9B77A" },
};

export type LineKind = "arc" | "solid" | "dotted";
/** Flights draw as raised (or dashed) arcs, rail solid, boat and road dotted. */
export function lineKind(mode: string | undefined): LineKind {
  if (mode === "flight") return "arc";
  if (mode === "boat" || mode === "road") return "dotted";
  return "solid";
}

/** Leg status as opacity, never colour alone (a badge carries it too). */
export const STATUS_OPACITY: Record<string, number> = { booked: 1, held: 0.7, idea: 0.4 };
export const STATUS_BADGE: Record<string, string> = { booked: "✓", held: "…", idea: "?" };

/** Activity radius: 14px + 3px per net vote, clamped to 10–30px. */
export function activityRadius(votes: number | undefined): number {
  return Math.max(10, Math.min(30, 14 + 3 * (votes ?? 0)));
}

/** First tag in the spec's order wins the fill; the details panel lists them all. */
export function primaryTag(tags: readonly string[] | undefined, fallback?: string): ActivityTag {
  for (const t of ACTIVITY_TAGS) if (tags?.includes(t)) return t;
  if (fallback && (ACTIVITY_TAGS as readonly string[]).includes(fallback)) return fallback as ActivityTag;
  return "other";
}

export function nodeColor(type: GraphNodeType, surface: Surface, style: { tag?: string; tags?: string[]; color?: string; mode?: string }): string {
  if (type === "activity") return TAG_COLOR[primaryTag(style.tags, style.tag)];
  if (type === "country") return style.color ?? "#59626E";
  if (type === "leg") return (MODE_COLOR[style.mode ?? ""] ?? MODE_COLOR.train!)[surface];
  return NODE_FILL[type][surface];
}

export const NODE_LABEL: Record<GraphNodeType, string> = {
  trip: "Trip",
  route: "Route",
  stop: "Stop",
  city: "City",
  country: "Country",
  activity: "Activity",
  area: "Area to stay",
  hotel: "Hotel",
  station: "Station",
  airport: "Airport",
  leg: "Leg",
};

/** Shape is the second channel for node type. Cytoscape shape names (polygon points for the inverted triangle). */
export const NODE_SHAPE: Record<GraphNodeType, string> = {
  trip: "star",
  route: "round-rectangle",
  stop: "diamond",
  city: "ellipse",
  country: "hexagon",
  activity: "ellipse",
  area: "ellipse",
  hotel: "round-rectangle",
  station: "triangle",
  airport: "polygon",
  leg: "round-rectangle",
};
export const AIRPORT_POLYGON = "-1 -1 1 -1 0 1";

/** Tiny white glyphs (SVG paths on a 24-unit box) used as the icon channel. */
export const ICON_PATHS: Record<ActivityTag | "hotel" | "airport", string> = {
  // ball
  sport: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 3 3 2-1 4h-4l-1-4 3-2Z",
  // chip
  tech: "M8 6h8v12H8zM4 9h4M4 15h4M16 9h4M16 15h4M10 3v3M14 3v3M10 18v3M14 18v3",
  // leaf
  nature: "M5 19c0-9 6-14 14-14 0 8-5 14-14 14Zm0 0 7-7",
  // columns
  culture: "M4 9h16L12 4 4 9Zm2 0v9m4-9v9m4-9v9m4-9v9M3 20h18",
  // bowl
  food: "M4 11h16a8 8 0 0 1-16 0Zm4-6 2 4m4-4-2 4",
  other: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z",
  // bed
  hotel: "M3 18V8m0 6h18v4m0-4v-2a3 3 0 0 0-3-3h-7v5M7 11a1.5 1.5 0 1 0 0 .01",
  // plane
  airport: "M12 3v7l8 4v2l-8-2v4l3 2v1l-3-1-3 1v-1l3-2v-4l-8 2v-2l8-4V3Z",
};

export function iconDataUri(path: string, color = "#FFFFFF"): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

// --- colour maths shared by the unit test -------------------------------------

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map(toLinear) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Machado et al. (2009) full-severity simulation matrices, applied in linear RGB. */
const CVD: Record<"protanopia" | "deuteranopia" | "tritanopia", number[][]> = {
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};
export type Deficiency = keyof typeof CVD;
export const DEFICIENCIES = Object.keys(CVD) as Deficiency[];

/** Simulated colour as linear RGB (0–1). */
export function simulate(hex: string, kind: Deficiency): [number, number, number] {
  const lin = hexToRgb(hex).map(toLinear);
  const m = CVD[kind];
  return m.map((row) => Math.min(1, Math.max(0, row[0]! * lin[0]! + row[1]! * lin[1]! + row[2]! * lin[2]!))) as [
    number,
    number,
    number,
  ];
}

/** CIE L*a*b* (D65) from linear RGB. */
export function linearToLab([r, g, b]: [number, number, number]): [number, number, number] {
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const [fx, fy, fz] = [f(x), f(y), f(z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function hexToLab(hex: string) {
  return linearToLab(hexToRgb(hex).map(toLinear) as [number, number, number]);
}

/** CIE76 colour difference. */
export function deltaE(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

// Exported for completeness: converts a simulated linear colour back to hex for previews.
export function linearToHex(rgb: [number, number, number]): string {
  return `#${rgb.map((c) => Math.round(toGamma(c) * 255).toString(16).padStart(2, "0")).join("")}`;
}
