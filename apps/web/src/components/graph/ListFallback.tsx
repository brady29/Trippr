"use client";

import type { GraphJSON, GraphNode } from "@trippr/contracts";
import { forwardRef } from "react";
import { readingOrder, type GraphIndex } from "@/lib/graph";
import { NODE_LABEL } from "@/lib/graph-palette";
import { NodeGlyph } from "./glyphs";

function detail(n: GraphNode): string {
  if (n.type === "activity") return [n.style.planned ? "planned" : "idea", n.style.fixedDate ? "fixed date" : "", (n.style.tags ?? []).join(", "), n.style.votes ? `${n.style.votes} votes` : ""].filter(Boolean).join(" · ");
  if (n.type === "leg") return [n.style.mode, n.style.status ?? "idea"].filter(Boolean).join(" · ");
  if (n.type === "hotel") return String(n.style.status ?? "");
  if (n.type === "stop") return n.attrs.nights != null ? `${String(n.attrs.nights)} nights` : "";
  if (n.type === "area" && Array.isArray(n.attrs.vibes)) return (n.attrs.vibes as string[]).join(", ");
  return "";
}

/** The same filtered graph as an accessible table: one row per node, with its connections. */
export const ListFallback = forwardRef<HTMLTableElement, {
  graph: GraphJSON;
  index: GraphIndex;
  selected: string | null;
  onSelect(id: string): void;
  notice?: string | null;
}>(function ListFallback({ graph, index, selected, onSelect, notice }, ref) {
  const rows = readingOrder(graph.nodes);
  const visible = new Set(graph.nodes.map((n) => n.id));
  return (
    <div className="h-full overflow-auto bg-paper p-3 sm:p-4">
      {notice ? <p role="status" className="mb-3 rounded-lg bg-warn/10 px-3 py-2 text-sm text-warn">{notice}</p> : null}
      <table ref={ref} tabIndex={-1} className="w-full min-w-[560px] border-collapse text-sm" data-testid="graph-list">
        <caption className="mb-2 text-left text-xs text-ink-soft">
          {graph.nodes.length} nodes and {graph.edges.length} connections in this view
        </caption>
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wide text-ink-faint">
            <th scope="col" className="border-b border-line px-2 py-2">Type</th>
            <th scope="col" className="border-b border-line px-2 py-2">Name</th>
            <th scope="col" className="border-b border-line px-2 py-2">City</th>
            <th scope="col" className="border-b border-line px-2 py-2">Details</th>
            <th scope="col" className="border-b border-line px-2 py-2">Connected to</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((n) => {
            const links = [
              ...(index.out.get(n.id) ?? []).map((e) => e.target),
              ...(index.in.get(n.id) ?? []).map((e) => e.source),
            ].filter((id) => visible.has(id));
            return (
              <tr key={n.id} data-testid="graph-list-row" data-node-id={n.id} className={n.id === selected ? "bg-mark/15" : "odd:bg-card"}>
                <td className="whitespace-nowrap px-2 py-1.5 align-top">
                  <span className="inline-flex items-center gap-1.5">
                    <NodeGlyph node={n} />
                    {NODE_LABEL[n.type]}
                  </span>
                </td>
                <td className="px-2 py-1.5 align-top">
                  <button type="button" onClick={() => onSelect(n.id)} className="min-h-11 text-left font-medium text-ink hover:underline sm:min-h-0">
                    {n.label}
                  </button>
                </td>
                <td className="whitespace-nowrap px-2 py-1.5 align-top text-ink-soft">{n.cityCode ?? ""}</td>
                <td className="px-2 py-1.5 align-top text-ink-soft">{detail(n)}</td>
                <td className="px-2 py-1.5 align-top text-xs text-ink-soft">
                  {links.slice(0, 4).map((id) => index.byId.get(id)?.label).filter(Boolean).join(", ")}
                  {links.length > 4 ? ` +${links.length - 4}` : ""}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
});
