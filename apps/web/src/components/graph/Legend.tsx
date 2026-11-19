"use client";

import type { GraphNodeType } from "@trippr/contracts";
import { ACTIVITY_TAGS, FIXED_DATE, NODE_LABEL, TAG_COLOR, TAG_LABEL, type ActivityTag } from "@/lib/graph-palette";
import { TagIcon, TypeGlyph } from "./glyphs";

const TYPES: GraphNodeType[] = ["city", "stop", "route", "activity", "area", "hotel", "station", "airport", "leg", "country"];

/** Every legend entry is also a filter toggle. */
export function Legend({
  counts,
  types,
  tags,
  onToggleType,
  onToggleTag,
}: {
  counts: Partial<Record<GraphNodeType, number>>;
  types: GraphNodeType[];
  tags: ActivityTag[];
  onToggleType(t: GraphNodeType): void;
  onToggleTag(t: ActivityTag): void;
}) {
  const chip = (active: boolean, filtering: boolean) =>
    `inline-flex min-h-9 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
      active ? "border-ink bg-card text-ink" : filtering ? "border-line bg-transparent text-ink-faint" : "border-line bg-card text-ink-soft hover:border-ink-faint"
    }`;
  return (
    <div className="space-y-2" aria-label="Legend and filters">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Node types">
        {TYPES.filter((t) => (counts[t] ?? 0) > 0).map((t) => {
          const active = types.includes(t);
          return (
            <button key={t} type="button" aria-pressed={active} className={chip(active, types.length > 0)} onClick={() => onToggleType(t)}>
              <TypeGlyph type={t} hollow={t === "leg"} />
              {NODE_LABEL[t]}
              <span className="font-mono text-[10px] text-ink-faint">{counts[t]}</span>
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Activity tags">
        {[...ACTIVITY_TAGS, "other" as const].map((t) => {
          const active = tags.includes(t);
          return (
            <button key={t} type="button" aria-pressed={active} className={chip(active, tags.length > 0)} onClick={() => onToggleTag(t)}>
              <span className="grid h-4 w-4 place-items-center rounded-full" style={{ background: TAG_COLOR[t] }}>
                <TagIcon tag={t} size={11} color="#FFFFFF" />
              </span>
              {TAG_LABEL[t]}
            </button>
          );
        })}
        <span className="mx-1 hidden h-4 w-px bg-line sm:inline-block" aria-hidden="true" />
        <span className="inline-flex items-center gap-1 text-xs text-ink-soft">
          <TypeGlyph type="activity" color={TAG_COLOR.tech} /> planned
        </span>
        <span className="inline-flex items-center gap-1 text-xs text-ink-soft">
          <TypeGlyph type="activity" color={TAG_COLOR.tech} hollow /> idea
        </span>
        <span className="inline-flex items-center gap-1 text-xs text-ink-soft">
          <span className="h-3.5 w-3.5 rounded-full border-[3px]" style={{ borderColor: FIXED_DATE.paper }} aria-hidden="true" /> fixed date
        </span>
        <span className="inline-flex items-center gap-1 text-xs text-ink-soft" title="Size grows with net votes">
          <span className="h-2 w-2 rounded-full bg-ink-faint" aria-hidden="true" />
          <span className="h-3.5 w-3.5 rounded-full bg-ink-faint" aria-hidden="true" /> more votes
        </span>
      </div>
    </div>
  );
}
