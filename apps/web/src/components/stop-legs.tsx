"use client";

import { LEG_MODES, LEG_STATUSES, type Hub, type HubKind, type Leg, type LegMode, type LegStatus, type StopView } from "@trippr/contracts";
import { useEffect, useId, useState } from "react";
import {
  defaultOffset,
  formatLegTime,
  joinDateTime,
  OFFSET_CHOICES,
  splitDateTime,
  useHubSearch,
  useLegPrivate,
  useRouteWrite,
} from "@/lib/explorer";
import { ModeIcon, PlusIcon, XIcon } from "./icons";
import { FlightPricePanel } from "./flight-prices";
import { MapsLink } from "./maps-link";
import { Button, Input, Label, Select } from "./ui";

const MODE_LABEL: Record<LegMode, string> = {
  flight: "Flight",
  hsr: "High-speed train",
  train: "Train",
  road: "Road",
  boat: "Boat",
  maglev: "Maglev",
};
const STATUS_STYLE: Record<LegStatus, string> = {
  idea: "border border-dashed border-ink-faint text-ink-soft",
  held: "bg-warn/15 text-warn",
  booked: "bg-ok/15 text-ok",
};
const hubKindFor = (mode: LegMode): HubKind | undefined =>
  mode === "flight" ? "airport" : mode === "boat" || mode === "road" ? undefined : "station";
const hubCode = (h: Hub) => (h.kind === "airport" ? h.id : (h.code ?? h.name));

/** Search stations or airports; picking one fills the field. */
function HubPicker({
  label,
  value,
  onChange,
  kind,
  cityHint,
}: {
  label: string;
  value: Hub | null;
  onChange: (hub: Hub) => void;
  kind?: HubKind;
  cityHint?: string;
}) {
  const id = useId();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const search = useHubSearch(q.trim(), q.trim() ? undefined : cityHint, kind);
  return (
    <div className="relative">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        role="combobox"
        aria-expanded={open}
        value={open ? q : value ? `${value.name} (${hubCode(value)})` : ""}
        placeholder={kind === "airport" ? "Airport name or code" : "Station or airport"}
        onFocus={() => {
          setQ("");
          setOpen(true);
        }}
        onChange={(e) => setQ(e.target.value)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && search.data?.length ? (
        <ul role="listbox" className="absolute z-30 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-line bg-card py-1 shadow-lg">
          {search.data.map((h) => (
            <li key={`${h.kind}:${h.id}`}>
              <button
                type="button"
                role="option"
                aria-selected={value?.id === h.id}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-paper"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange(h);
                  setOpen(false);
                }}
              >
                <ModeIcon mode={h.kind === "airport" ? "flight" : "train"} className={h.kind === "airport" ? "text-sky" : "text-rail"} />
                <span className="min-w-0 flex-1 truncate">{h.name}</span>
                <span className="font-mono text-xs text-ink-faint">{hubCode(h)}</span>
                <span className="text-xs text-ink-faint">{h.cityName}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function DateTimeField({ label, value, onChange, cityCode }: { label: string; value?: string | null; onChange: (v: string | null) => void; cityCode?: string }) {
  const id = useId();
  const split = splitDateTime(value);
  const [local, setLocal] = useState(split.local);
  const [offset, setOffset] = useState(split.offset ?? defaultOffset(cityCode));
  useEffect(() => {
    if (!split.offset) setOffset(defaultOffset(cityCode));
  }, [cityCode, split.offset]);
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <div className="flex gap-1.5">
        <Input
          id={id}
          type="datetime-local"
          value={local}
          onChange={(e) => {
            setLocal(e.target.value);
            onChange(joinDateTime(e.target.value, offset));
          }}
        />
        <Select
          aria-label={`${label} UTC offset`}
          value={offset}
          onChange={(e) => {
            setOffset(e.target.value);
            onChange(joinDateTime(local, e.target.value));
          }}
          className="w-[5.5rem]"
        >
          {[...new Set([offset, ...OFFSET_CHOICES])].map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </Select>
      </div>
    </div>
  );
}

function LegForm({
  initial,
  stop,
  prevCityCode,
  canSeePrivate,
  pending,
  onSave,
  onCancel,
}: {
  initial?: Leg;
  stop: StopView;
  prevCityCode?: string;
  canSeePrivate: boolean;
  pending: boolean;
  onSave: (body: {
    mode: LegMode;
    from: { kind: HubKind; id: string };
    to: { kind: HubKind; id: string };
    operator: string | null;
    number: string | null;
    departAt: string | null;
    arriveAt: string | null;
    priceCad: number | null;
    status: LegStatus;
    bookingRef?: string | null;
  }) => void;
  onCancel: () => void;
}) {
  const [mode, setMode] = useState<LegMode>(initial?.mode ?? (stop.arriveMode as LegMode));
  const [from, setFrom] = useState<Hub | null>(initial?.from ?? null);
  const [to, setTo] = useState<Hub | null>(initial?.to ?? null);
  const [operator, setOperator] = useState(initial?.operator ?? "");
  const [number, setNumber] = useState(initial?.number ?? "");
  const [departAt, setDepartAt] = useState<string | null>(initial?.departAt ?? null);
  const [arriveAt, setArriveAt] = useState<string | null>(initial?.arriveAt ?? null);
  const [price, setPrice] = useState(initial?.priceCad != null ? String(initial.priceCad) : "");
  const [status, setStatus] = useState<LegStatus>(initial?.status ?? "idea");
  const priv = useLegPrivate(initial?.id ?? "", Boolean(initial && canSeePrivate));
  const [bookingRef, setBookingRef] = useState<string | undefined>(undefined);
  const kind = hubKindFor(mode);

  return (
    <form
      className="space-y-2.5 rounded-xl border border-ink-faint/50 bg-paper p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!from || !to) return;
        onSave({
          mode,
          from: { kind: from.kind, id: from.id },
          to: { kind: to.kind, id: to.id },
          operator: operator.trim() || null,
          number: number.trim() || null,
          departAt,
          arriveAt,
          priceCad: price ? Number(price) : null,
          status,
          ...(canSeePrivate && bookingRef !== undefined ? { bookingRef: bookingRef.trim() || null } : {}),
        });
      }}
    >
      <div className="grid gap-2 sm:grid-cols-[10rem_minmax(0,1fr)_minmax(0,1fr)]">
        <div>
          <Label htmlFor={`leg-mode-${stop.id}`}>Mode</Label>
          <Select id={`leg-mode-${stop.id}`} value={mode} onChange={(e) => setMode(e.target.value as LegMode)} className="w-full">
            {LEG_MODES.map((m) => (
              <option key={m} value={m}>
                {MODE_LABEL[m]}
              </option>
            ))}
          </Select>
        </div>
        <HubPicker label="From" value={from} onChange={setFrom} kind={kind} cityHint={prevCityCode} />
        <HubPicker label="To" value={to} onChange={setTo} kind={kind} cityHint={stop.city.code} />
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div>
          <Label htmlFor={`leg-op-${stop.id}`}>Operator</Label>
          <Input id={`leg-op-${stop.id}`} value={operator} onChange={(e) => setOperator(e.target.value)} placeholder="ANA, China Railway" />
        </div>
        <div>
          <Label htmlFor={`leg-no-${stop.id}`}>Number</Label>
          <Input id={`leg-no-${stop.id}`} value={number} onChange={(e) => setNumber(e.target.value)} placeholder="NH963, G2201" />
        </div>
        <div>
          <Label htmlFor={`leg-price-${stop.id}`}>Price per person</Label>
          <Input id={`leg-price-${stop.id}`} type="number" min={0} value={price} onChange={(e) => setPrice(e.target.value)} placeholder="CAD" />
        </div>
        <div>
          <Label htmlFor={`leg-status-${stop.id}`}>Status</Label>
          <Select id={`leg-status-${stop.id}`} value={status} onChange={(e) => setStatus(e.target.value as LegStatus)} className="w-full">
            {LEG_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <DateTimeField label="Departs (local time)" value={departAt} onChange={setDepartAt} cityCode={from?.cityCode ?? prevCityCode} />
        <DateTimeField label="Arrives (local time)" value={arriveAt} onChange={setArriveAt} cityCode={to?.cityCode ?? stop.city.code} />
      </div>
      {canSeePrivate ? (
        <div>
          <Label htmlFor={`leg-ref-${stop.id}`}>Booking reference (editors only)</Label>
          <Input
            id={`leg-ref-${stop.id}`}
            value={bookingRef ?? priv.data?.bookingRef ?? ""}
            onChange={(e) => setBookingRef(e.target.value)}
            placeholder="Not shown to viewers"
            autoComplete="off"
          />
        </div>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="primary" disabled={pending || !from || !to}>
          {initial ? "Save leg" : "Add leg"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** "Getting here": the ticket segments into this stop, between real stations and airports. */
export function StopLegs({
  routeId,
  stop,
  prevCityCode,
  canEdit,
  pricesOn = false,
}: {
  routeId: string;
  stop: StopView;
  prevCityCode?: string;
  canEdit: boolean;
  /** Flight price tracking is on: flights between airports get a "Prices" button. */
  pricesOn?: boolean;
}) {
  const write = useRouteWrite(routeId);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [pricesFor, setPricesFor] = useState<string | null>(null);
  const legs = stop.legs ?? [];

  return (
    <div className="space-y-1.5" data-testid="stop-legs">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">Getting here</span>
        {canEdit && editing === null ? (
          <button onClick={() => setEditing("new")} className="inline-flex items-center gap-1 text-xs font-medium text-sky hover:underline">
            <PlusIcon className="h-3.5 w-3.5" /> Add leg
          </button>
        ) : null}
      </div>
      {legs.length === 0 && editing === null ? (
        <p className="text-xs text-ink-faint">No tickets yet.{canEdit ? " Add the flight or train that gets you here." : ""}</p>
      ) : null}
      <ol className="space-y-1">
        {legs.map((leg) =>
          editing === leg.id ? (
            <li key={leg.id}>
              <LegForm
                initial={leg}
                stop={stop}
                prevCityCode={prevCityCode}
                canSeePrivate={canEdit}
                pending={write.isPending}
                onCancel={() => setEditing(null)}
                onSave={(body) => write.mutate({ kind: "patchLeg", legId: leg.id, body }, { onSuccess: () => setEditing(null) })}
              />
            </li>
          ) : (
            <li key={leg.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-paper px-2.5 py-1.5 text-xs">
              <ModeIcon mode={leg.mode === "maglev" ? "train" : leg.mode} className={leg.mode === "flight" ? "text-sky" : "text-rail"} />
              <span className="inline-flex items-center gap-1 font-mono font-semibold" title={`${leg.from.name} → ${leg.to.name}`}>
                {hubCode(leg.from)}
                <MapsLink name={leg.from.name} near={leg.from.cityName} lat={leg.from.lat} lon={leg.from.lon} label="" />
                → {hubCode(leg.to)}
                <MapsLink name={leg.to.name} near={leg.to.cityName} lat={leg.to.lat} lon={leg.to.lon} label="" />
              </span>
              {leg.operator || leg.number ? (
                <span className="text-ink-soft">{[leg.operator, leg.number].filter(Boolean).join(" ")}</span>
              ) : null}
              {leg.departAt ? <span className="text-ink-soft">{formatLegTime(leg.departAt)}</span> : null}
              {leg.priceCad != null ? (
                <span className="font-mono" title={leg.priceSource ? `Estimated from recent searches (${leg.priceAsOf ?? "recent"})` : undefined}>
                  {leg.priceSource ? "~" : ""}${leg.priceCad}
                </span>
              ) : null}
              <span className={`rounded-full px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide ${STATUS_STYLE[leg.status]}`}>{leg.status}</span>
              {pricesOn && leg.mode === "flight" && leg.from.kind === "airport" && leg.to.kind === "airport" ? (
                <button
                  onClick={() => setPricesFor(pricesFor === leg.id ? null : leg.id)}
                  className="font-medium text-sky hover:underline"
                  aria-expanded={pricesFor === leg.id}
                  aria-label={`Prices for ${hubCode(leg.from)} to ${hubCode(leg.to)}`}
                >
                  Prices
                </button>
              ) : null}
              {canEdit ? (
                <span className="ml-auto flex items-center gap-2">
                  <button onClick={() => setEditing(leg.id)} className="text-sky hover:underline" aria-label={`Edit leg ${hubCode(leg.from)} to ${hubCode(leg.to)}`}>
                    Edit
                  </button>
                  <button
                    onClick={() => {
                      if (window.confirm(`Remove the ${MODE_LABEL[leg.mode].toLowerCase()} ${hubCode(leg.from)} → ${hubCode(leg.to)}?`)) {
                        write.mutate({ kind: "deleteLeg", legId: leg.id });
                      }
                    }}
                    className="text-ink-faint hover:text-err"
                    aria-label={`Remove leg ${hubCode(leg.from)} to ${hubCode(leg.to)}`}
                  >
                    <XIcon className="h-3.5 w-3.5" />
                  </button>
                </span>
              ) : null}
              {pricesFor === leg.id ? <FlightPricePanel legId={leg.id} /> : null}
            </li>
          ),
        )}
      </ol>
      {editing === "new" ? (
        <LegForm
          stop={stop}
          prevCityCode={prevCityCode}
          canSeePrivate={canEdit}
          pending={write.isPending}
          onCancel={() => setEditing(null)}
          onSave={(body) => write.mutate({ kind: "addLeg", stopId: stop.id, body }, { onSuccess: () => setEditing(null) })}
        />
      ) : null}
    </div>
  );
}
