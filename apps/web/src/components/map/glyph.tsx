import { ICON_PATHS } from "@/lib/graph-palette";
import type { MapShape } from "@/lib/map-features";

/** The marker shape as a small SVG, for the list and the layer toggles (the legend). */
export function ShapeGlyph({ shape, color, className = "h-4 w-4", n }: { shape: MapShape; color: string; className?: string; n?: number }) {
  const common = { stroke: "#FFFFFF", strokeWidth: 1.5 } as const;
  return (
    <svg viewBox="0 0 20 20" className={`shrink-0 ${className}`} aria-hidden>
      {shape === "stop" ? (
        <>
          <circle cx="10" cy="10" r="8.5" fill="#1B1C1F" />
          <text x="10" y="13.5" textAnchor="middle" fontSize={n && n > 9 ? 8 : 10} fontFamily="monospace" fontWeight={600} fill="#FFFFFF">
            {n ?? ""}
          </text>
        </>
      ) : shape === "circle" ? (
        <circle cx="10" cy="10" r="6.5" fill={color} {...common} />
      ) : shape === "ring" ? (
        <circle cx="10" cy="10" r="6" fill="#FFFFFF" stroke={color} strokeWidth={2.5} />
      ) : shape === "diamond" ? (
        <path d="M10 2 18 10 10 18 2 10Z" fill={color} {...common} />
      ) : shape === "square" ? (
        <rect x="4" y="4" width="12" height="12" fill={color} {...common} />
      ) : shape === "square-outline" ? (
        <rect x="4.5" y="4.5" width="11" height="11" fill="#FFFFFF" stroke={color} strokeWidth={2.5} />
      ) : shape === "triangle" ? (
        <path d="M10 3 17.5 16H2.5Z" fill={color} {...common} />
      ) : shape === "plane" ? (
        <>
          <circle cx="10" cy="10" r="8.5" fill={color} />
          <path d={ICON_PATHS.airport} fill="#FFFFFF" transform="translate(3 3) scale(0.583)" />
        </>
      ) : (
        <circle cx="10" cy="10" r="8" fill={color} fillOpacity={0.2} stroke={color} strokeWidth={1.5} />
      )}
    </svg>
  );
}
