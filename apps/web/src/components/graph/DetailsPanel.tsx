"use client";

import type { GraphNode } from "@trippr/contracts";
import { isFixedDate, shortDate, whenLabel, type When } from "@trippr/rules";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { ThumbDownIcon, ThumbUpIcon, XIcon } from "@/components/icons";
import { Tag } from "@/components/ui";
import { api } from "@/lib/api";
import type { GraphIndex } from "@/lib/graph";
import { NODE_LABEL, primaryTag, TAG_LABEL } from "@/lib/graph-palette";
import { NodeGlyph } from "./glyphs";

const MODE: Record<string, string> = { flight: "Flight", hsr: "High-speed train", train: "Train", maglev: "Maglev", boat: "Boat", road: "Road" };

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 py-1 text-sm">
      <dt className="w-24 shrink-0 text-ink-faint">{label}</dt>
      <dd className="min-w-0 flex-1">{children}</dd>
    </div>
  );
}

function routeOf(node: GraphNode): string | null {
  return (node.attrs.routeId as string | undefined) ?? node.style.routes?.[0] ?? null;
}

export function DetailsPanel({
  node,
  index,
  tripId,
  canVote,
  onSelect,
  onClose,
  onExpand,
  onCityScope,
}: {
  node: GraphNode;
  index: GraphIndex;
  tripId: string;
  canVote: boolean;
  onSelect(id: string): void;
  onClose(): void;
  onExpand(id: string): void;
  onCityScope(code: string): void;
}) {
  const qc = useQueryClient();
  const vote = useMutation({
    mutationFn: (value: -1 | 0 | 1) => api(`/activities/${node.id.replace(/^act:/, "")}/vote`, { method: "PUT", body: { value } }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["graph", tripId] });
      void qc.invalidateQueries({ queryKey: ["library"] });
      void qc.invalidateQueries({ queryKey: ["trip-activities"] });
    },
  });

  const connections = [
    ...(index.out.get(node.id) ?? []).map((e) => ({ edge: e.type, other: index.byId.get(e.target) })),
    ...(index.in.get(node.id) ?? []).map((e) => ({ edge: e.type, other: index.byId.get(e.source) })),
  ].filter((c): c is { edge: (typeof c)["edge"]; other: GraphNode } => Boolean(c.other));

  const routeId = routeOf(node);
  const a = node.attrs;
  const when = a.when as When | null | undefined;
  const myVote = Number(a.myVote ?? 0) as -1 | 0 | 1;

  return (
    <section aria-label={`Details for ${node.label}`} className="flex h-full flex-col">
      <div className="flex items-start gap-3 border-b border-line p-4">
        <NodeGlyph node={node} size={22} />
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">{NODE_LABEL[node.type]}</div>
          <h2 className="text-lg font-semibold leading-snug">{node.label}</h2>
        </div>
        <button type="button" onClick={onClose} className="grid h-11 w-11 place-items-center rounded-lg text-ink-soft hover:bg-paper-2" aria-label="Close details">
          <XIcon />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        <dl className="mb-4">
          {node.type === "activity" ? (
            <>
              <Row label="Tags">
                <span className="flex flex-wrap gap-1">
                  {(node.style.tags?.length ? node.style.tags : [primaryTag(node.style.tags, node.style.tag)]).map((t) => (
                    <Tag key={t}>{TAG_LABEL[t as keyof typeof TAG_LABEL] ?? t}</Tag>
                  ))}
                </span>
              </Row>
              <Row label="Status">{node.style.planned ? "Planned" : "Idea"}</Row>
              {isFixedDate(when) ? <Row label="When">{whenLabel(when)}</Row> : null}
              {a.costCad != null ? <Row label="Cost">${String(a.costCad)} CAD per person</Row> : null}
              <Row label="Votes">
                <span className="inline-flex items-center gap-2">
                  <button
                    type="button"
                    disabled={!canVote || vote.isPending}
                    aria-pressed={myVote === 1}
                    aria-label={`Vote up ${node.label}`}
                    onClick={() => vote.mutate(myVote === 1 ? 0 : 1)}
                    className="grid h-11 w-11 place-items-center rounded-lg border border-line text-ink-soft hover:text-ok disabled:opacity-40"
                  >
                    <ThumbUpIcon />
                  </button>
                  <span className="font-mono">{node.style.votes ?? 0}</span>
                  <button
                    type="button"
                    disabled={!canVote || vote.isPending}
                    aria-pressed={myVote === -1}
                    aria-label={`Vote down ${node.label}`}
                    onClick={() => vote.mutate(myVote === -1 ? 0 : -1)}
                    className="grid h-11 w-11 place-items-center rounded-lg border border-line text-ink-soft hover:text-err disabled:opacity-40"
                  >
                    <ThumbDownIcon />
                  </button>
                </span>
              </Row>
            </>
          ) : null}
          {node.type === "stop" ? (
            <>
              {a.arrive ? <Row label="Dates">{`${shortDate(String(a.arrive))} → ${shortDate(String(a.depart))}`}</Row> : null}
              {a.nights != null ? <Row label="Nights">{String(a.nights)}</Row> : null}
              {a.routeName ? <Row label="Route">{String(a.routeName)}</Row> : null}
            </>
          ) : null}
          {node.type === "leg" ? (
            <>
              <Row label="Mode">{MODE[String(node.style.mode)] ?? String(node.style.mode ?? "")}</Row>
              <Row label="Status">{String(node.style.status ?? "idea")}</Row>
              {a.operator || a.number ? <Row label="Service">{[a.operator, a.number].filter(Boolean).join(" ")}</Row> : null}
              {a.departAt ? <Row label="Departs">{String(a.departAt).replace("T", " ")}</Row> : null}
              {a.arriveAt ? <Row label="Arrives">{String(a.arriveAt).replace("T", " ")}</Row> : null}
              {a.priceCad != null ? <Row label="Price">${String(a.priceCad)} CAD per person</Row> : null}
            </>
          ) : null}
          {node.type === "hotel" ? (
            <>
              <Row label="Status">{String(node.style.status ?? "shortlist")}</Row>
              {a.priceCadPerNight != null ? (
                <Row label="Price">
                  ${String(a.priceCadPerNight)} per {String(a.priceBasis ?? "room")} per night
                  {a.priceBasis !== "person" && a.sleeps ? ` (sleeps ${String(a.sleeps)})` : ""}
                </Row>
              ) : null}
              {a.example ? <Row label="Note">Example data for development</Row> : null}
            </>
          ) : null}
          {node.type === "area" && Array.isArray(a.vibes) ? (
            <Row label="Vibes">
              <span className="flex flex-wrap gap-1">
                {(a.vibes as string[]).map((v) => (
                  <Tag key={v}>{v}</Tag>
                ))}
              </span>
            </Row>
          ) : null}
          {(node.type === "station" || node.type === "airport") && a.code ? <Row label="Code">{String(a.code)}</Row> : null}
          {(node.type === "station" || node.type === "airport") && a.verify ? <Row label="Note">Check this hub against your tickets</Row> : null}
          {node.type === "city" && node.cityCode ? <Row label="Code">{node.cityCode}</Row> : null}
        </dl>

        <div className="mb-4 flex flex-wrap gap-2">
          {routeId && ["activity", "stop", "leg", "hotel"].includes(node.type) ? (
            <Link href={`/routes/${routeId}`} className="inline-flex min-h-11 items-center rounded-lg border border-line bg-card px-3 text-sm font-medium hover:border-ink-faint">
              Open in route editor
            </Link>
          ) : null}
          {node.type === "route" ? (
            <Link href={`/routes/${node.id.replace(/^route:/, "")}`} className="inline-flex min-h-11 items-center rounded-lg border border-line bg-card px-3 text-sm font-medium hover:border-ink-faint">
              Open route
            </Link>
          ) : null}
          {node.type === "city" && node.cityCode ? (
            <button type="button" onClick={() => onCityScope(node.cityCode!)} className="inline-flex min-h-11 items-center rounded-lg border border-line bg-card px-3 text-sm font-medium hover:border-ink-faint">
              Show this city&apos;s graph
            </button>
          ) : null}
          <button type="button" onClick={() => onExpand(node.id)} className="inline-flex min-h-11 items-center rounded-lg border border-line bg-card px-3 text-sm font-medium hover:border-ink-faint">
            Expand
          </button>
        </div>

        <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-ink-faint">Connected to ({connections.length})</h3>
        <ul className="space-y-1">
          {connections.slice(0, 40).map(({ edge, other }) => (
            <li key={`${edge}-${other.id}`}>
              <button type="button" onClick={() => onSelect(other.id)} className="flex min-h-11 w-full items-center gap-2 rounded-lg px-2 text-left text-sm hover:bg-paper">
                <NodeGlyph node={other} />
                <span className="min-w-0 flex-1 truncate">{other.label}</span>
                <span className="font-mono text-[10px] text-ink-faint">{edge}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
