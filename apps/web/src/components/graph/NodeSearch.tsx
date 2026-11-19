"use client";

import type { GraphNode } from "@trippr/contracts";
import { useId, useMemo, useState } from "react";
import { NODE_LABEL } from "@/lib/graph-palette";
import { NodeGlyph } from "./glyphs";

/** Combobox over node labels and codes; choosing a result focuses it in both views. */
export function NodeSearch({ nodes, onPick }: { nodes: GraphNode[]; onPick(id: string): void }) {
  const listId = useId();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    const score = (n: GraphNode) => {
      const code = String(n.attrs.code ?? n.cityCode ?? "").toLowerCase();
      const label = n.label.toLowerCase();
      if (code === needle) return 0;
      if (label.startsWith(needle)) return 1;
      if (label.includes(needle) || code.includes(needle)) return 2;
      return 9;
    };
    return nodes
      .map((n) => [n, score(n)] as const)
      .filter(([, s]) => s < 9)
      .sort((a, b) => a[1] - b[1] || a[0].label.localeCompare(b[0].label))
      .slice(0, 8)
      .map(([n]) => n);
  }, [nodes, q]);

  const pick = (n: GraphNode) => {
    onPick(n.id);
    setQ("");
    setOpen(false);
  };

  return (
    <div className="relative w-full min-w-0 sm:w-64">
      <input
        type="search"
        role="combobox"
        aria-expanded={open && results.length > 0}
        aria-controls={listId}
        aria-activedescendant={open && results[active] ? `${listId}-${active}` : undefined}
        aria-label="Find a node"
        placeholder="Find a place, activity or code"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, results.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter" && results[active]) {
            e.preventDefault();
            pick(results[active]!);
          } else if (e.key === "Escape") setOpen(false);
        }}
        className="h-10 w-full rounded-lg border border-line bg-card px-3 text-sm text-ink placeholder:text-ink-faint focus:border-ink-soft focus:outline-none"
      />
      {open && results.length ? (
        <ul id={listId} role="listbox" className="absolute z-30 mt-1 max-h-72 w-full overflow-auto rounded-lg border border-line bg-card py-1 shadow-lg">
          {results.map((n, i) => (
            <li key={n.id} id={`${listId}-${i}`} role="option" aria-selected={i === active}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(n)}
                className={`flex min-h-11 w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${i === active ? "bg-paper" : "hover:bg-paper"}`}
              >
                <NodeGlyph node={n} />
                <span className="min-w-0 flex-1 truncate">{n.label}</span>
                <span className="text-[11px] text-ink-faint">{NODE_LABEL[n.type]}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
