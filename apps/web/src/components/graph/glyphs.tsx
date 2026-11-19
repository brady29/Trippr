import type { GraphNode, GraphNodeType } from "@trippr/contracts";
import { ICON_PATHS, nodeColor, primaryTag, TAG_COLOR, type ActivityTag } from "@/lib/graph-palette";

/** The node's shape and colour as a small inline SVG, matching the canvas. */
export function TypeGlyph({ type, color, hollow = false, size = 16 }: { type: GraphNodeType; color?: string; hollow?: boolean; size?: number }) {
  const fill = hollow ? "none" : color ?? nodeColor(type, "paper", { tag: "other" });
  const stroke = color ?? nodeColor(type, "paper", { tag: "other" });
  const common = { fill, stroke, strokeWidth: hollow ? 2.5 : 1.2 };
  let shape;
  switch (type) {
    case "route":
    case "leg":
      shape = <rect x="2" y="7" width="20" height="10" rx="4" {...common} />;
      break;
    case "stop":
      shape = <path d="M12 5 19 12 12 19 5 12Z" {...common} />;
      break;
    case "country":
      shape = <path d="M7 4h10l5 8-5 8H7l-5-8Z" {...common} />;
      break;
    case "area":
      shape = <circle cx="12" cy="12" r="9" fill={color ?? stroke} fillOpacity={0.2} stroke={stroke} strokeWidth={2} strokeDasharray="3 2" />;
      break;
    case "hotel":
      shape = <rect x="4" y="4" width="16" height="16" rx="4" {...common} />;
      break;
    case "station":
      shape = <path d="M12 4 21 20H3Z" {...common} />;
      break;
    case "airport":
      shape = <path d="M3 4h18l-9 16Z" {...common} />;
      break;
    case "trip":
      shape = <path d="m12 3 2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.6 19.5l1.2-6-4.5-4.2 6.1-.7Z" {...common} />;
      break;
    default:
      shape = <circle cx="12" cy="12" r={type === "city" ? 9 : 7} {...common} />;
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="shrink-0">
      {shape}
    </svg>
  );
}

export function TagIcon({ tag, size = 14, color }: { tag: ActivityTag; size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="shrink-0" fill="none" stroke={color ?? TAG_COLOR[tag]} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d={ICON_PATHS[tag]} />
    </svg>
  );
}

export function NodeGlyph({ node, size = 16 }: { node: GraphNode; size?: number }) {
  const color = nodeColor(node.type, "paper", node.style);
  const hollow = (node.type === "activity" && !node.style.planned) || (node.type === "hotel" && node.style.status === "shortlist");
  if (node.type === "activity") {
    const tag = primaryTag(node.style.tags, node.style.tag);
    return (
      <span className="relative inline-flex">
        <TypeGlyph type="activity" color={color} hollow={hollow} size={size} />
        {node.style.fixedDate ? <span className="absolute -inset-0.5 rounded-full ring-2 ring-stamp" aria-hidden="true" /> : null}
        <span className="sr-only">{tag}</span>
      </span>
    );
  }
  return <TypeGlyph type={node.type} color={color} hollow={hollow} size={size} />;
}
