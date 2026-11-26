"use client";

import type { Invite, Member, Role, RouteSummary, RouteView, TripDetail } from "@trippr/contracts";
import { hasRole } from "@trippr/contracts";
import { shortDate } from "@trippr/rules";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { cad } from "@/components/budget-panel";
import { BoardHeader, BoardStat, RequireAuth } from "@/components/shell";
import { Timeline } from "@/components/timeline";
import { useToast } from "@/components/toast";
import { ActionMenu, Button, ChecksBadge, ErrorNote, Input, Panel, Select, Spinner, Tag, type MenuAction } from "@/components/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { keys, useRoute, useTrip } from "@/lib/queries";
import { routeHref } from "@/lib/routes";

function RouteTags({ route }: { route: RouteSummary }) {
  const tags = route.tags.filter((t) => !(route.isCurrent && t === "current"));
  if (!route.isCurrent && tags.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {route.isCurrent ? <Tag tone="dark">current</Tag> : null}
      {tags.map((t) => (
        <Tag key={t}>{t}</Tag>
      ))}
    </span>
  );
}

/** A labelled number; the label sits above it on wide screens and beside it on phones. */
function Cell({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div className="flex items-baseline gap-1.5 sm:block">
      <span className="text-[10px] uppercase tracking-[0.16em] text-ink-faint sm:hidden">{label}</span>
      <span className="font-mono text-sm" data-testid={testId}>
        {children}
      </span>
    </div>
  );
}

/** One route in the list: name, its stops, the numbers to compare it by, and its actions. */
function RouteRow({
  route,
  trip,
  selected,
  onSelect,
}: {
  route: RouteSummary;
  trip: TripDetail;
  selected: boolean;
  onSelect: (checked: boolean) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const tripId = trip.trip.id;
  const canEdit = hasRole(trip.role, "editor");
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(route.name);
  const [tags, setTags] = useState(route.tags.join(", "));

  const refresh = () => qc.invalidateQueries({ queryKey: keys.trip(tripId) });
  const onError = (e: unknown) => toast(e instanceof Error ? e.message : "That didn't save", "error");

  const patch = useMutation({
    mutationFn: (body: { name?: string; tags?: string[]; isCurrent?: true }) =>
      api<RouteView>(`/routes/${route.id}`, { method: "PATCH", body: { ...body, version: route.version } }),
    onSuccess: (view) => {
      qc.setQueryData(keys.route(route.id), view);
      setEditing(false);
      void refresh();
    },
    onError: (e) => {
      onError(e);
      void refresh();
    },
  });
  const duplicate = useMutation({
    mutationFn: () => api<RouteView>(`/trips/${tripId}/routes`, { method: "POST", body: { fromRouteId: route.id } }),
    onSuccess: (view) => {
      qc.setQueryData(keys.route(view.route.id), view);
      void refresh();
      toast(`Created "${view.route.name}"`, "ok");
    },
    onError,
  });
  const remove = useMutation({
    mutationFn: () => api(`/routes/${route.id}`, { method: "DELETE" }),
    onSuccess: () => void refresh(),
    onError,
  });

  const actions: MenuAction[] = canEdit
    ? [
        { label: "Duplicate", onSelect: () => duplicate.mutate(), disabled: duplicate.isPending },
        ...(!route.isCurrent ? [{ label: "Set as current", onSelect: () => patch.mutate({ isCurrent: true }), disabled: patch.isPending }] : []),
        { label: "Rename or tag", onSelect: () => setEditing(true) },
        ...(trip.role === "owner"
          ? [
              {
                label: "Delete",
                danger: true,
                disabled: remove.isPending,
                onSelect: () => {
                  if (window.confirm(`Delete "${route.name}" and its stops? This can't be undone.`)) remove.mutate();
                },
              },
            ]
          : []),
      ]
    : [];

  return (
    <li
      data-testid="route-card"
      className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2 px-4 py-3.5 hover:bg-paper/60 sm:grid-cols-[auto_minmax(0,1fr)_3.5rem_4.25rem_5rem_7.25rem_2rem] sm:items-center"
    >
      <input
        type="checkbox"
        aria-label={`Select ${route.name} to compare`}
        checked={selected}
        onChange={(e) => onSelect(e.target.checked)}
        className="mt-1 h-4 w-4 accent-accent sm:mt-0"
      />
      <div className="min-w-0">
        {editing ? (
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              patch.mutate({
                name: name.trim() || route.name,
                tags: tags
                  .split(",")
                  .map((t) => t.trim().toLowerCase())
                  .filter(Boolean),
              });
            }}
          >
            <Input aria-label="Route name" value={name} onChange={(e) => setName(e.target.value)} />
            <Input aria-label="Tags, comma separated" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="budget, older" />
            <div className="flex gap-2">
              <Button size="sm" type="submit" variant="primary" disabled={patch.isPending}>
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <Link href={routeHref(tripId, route.id)} className="font-semibold hover:underline">
                {route.name}
              </Link>
              <RouteTags route={route} />
            </div>
            <p className="mt-0.5 line-clamp-1 text-xs text-ink-soft" title={route.cities.join(" → ")}>
              {route.cities.join(" → ") || "No stops yet"}
            </p>
            {route.derivedFrom ? <p className="text-[11px] text-ink-faint">Duplicated from {route.derivedFrom.name}</p> : null}
          </>
        )}
      </div>
      <div className="col-start-3 row-start-1 sm:col-start-auto sm:row-start-auto sm:order-last">
        {actions.length ? (
          <ActionMenu label={`More actions for ${route.name}`} actions={actions} />
        ) : (
          <Link href={routeHref(tripId, route.id)} className="text-xs font-medium text-sky hover:underline sm:sr-only">
            Open
          </Link>
        )}
      </div>
      {/* On phones these wrap under the name; on wide screens they become table columns. */}
      <div className="col-span-3 flex flex-wrap items-center gap-x-4 gap-y-1 pl-7 sm:col-span-1 sm:contents sm:pl-0">
        <Cell label="Nights">{route.totalNights}</Cell>
        <Cell label="Home">{shortDate(route.returnDate)}</Cell>
        <Cell label="Per person" testId="route-per-person">
          {cad(route.perPersonCad)}
        </Cell>
        <div>
          <ChecksBadge level={route.checksLevel} />
        </div>
      </div>
    </li>
  );
}

/** The route the group is going with, up top: its timeline and the numbers that matter. */
function CurrentRoute({ trip, route }: { trip: TripDetail; route: RouteSummary }) {
  const view = useRoute(route.id);
  const href = routeHref(trip.trip.id, route.id);
  return (
    <section className="ticket" aria-label="Current route">
      <div className="flex flex-wrap items-start justify-between gap-3 p-4 sm:p-5">
        <div className="min-w-0">
          <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">Current route</div>
          <h2 className="mt-1 text-xl font-semibold">
            <Link href={href} className="hover:underline">
              {route.name}
            </Link>
          </h2>
          <p className="mt-1 text-sm text-ink-soft">{route.cities.join(" → ") || "No stops yet"}</p>
        </div>
        <Link href={href}>
          <Button variant="primary">Open route</Button>
        </Link>
      </div>
      <div className="border-t-2 border-dashed border-line px-4 py-4 sm:px-5">
        {view.data ? <Timeline view={view.data} variant="inline" /> : <div className="h-9 animate-pulse rounded-md bg-paper-2" />}
        <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ["Nights", String(route.totalNights)],
            ["Stops", String(route.stopCount)],
            ["Home", shortDate(route.returnDate)],
            ["Per person", cad(route.perPersonCad)],
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg bg-paper px-3 py-2">
              <dt className="text-[10px] uppercase tracking-[0.16em] text-ink-faint">{label}</dt>
              <dd className="font-mono text-lg font-semibold">{value}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-3">
          <ChecksBadge level={route.checksLevel} />
        </div>
      </div>
    </section>
  );
}

/** Owner sets how many people are travelling; it drives every group budget. */
function GroupSize({ tripId, travellers }: { tripId: string; travellers: number }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [value, setValue] = useState(String(travellers));
  const save = useMutation({
    mutationFn: (n: number) => api(`/trips/${tripId}`, { method: "PATCH", body: { travellers: n } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.trip(tripId) });
      void qc.invalidateQueries({ queryKey: ["route"] });
      void qc.invalidateQueries({ queryKey: ["compare"] });
      toast("Group size saved", "ok");
    },
    onError: (e) => toast(e instanceof Error ? e.message : "That didn't save", "error"),
  });
  const n = Number(value);
  const valid = Number.isInteger(n) && n >= 1 && n <= 20;
  return (
    <div>
      <h3 className="text-xs font-semibold text-ink">Group size</h3>
      <form
        className="mt-1.5 flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && n !== travellers) save.mutate(n);
        }}
      >
        <Input
          type="number"
          min={1}
          max={20}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label="Number of travellers"
          className="h-9 w-20"
        />
        <span className="text-sm text-ink-soft">travellers</span>
        <Button type="submit" size="sm" disabled={!valid || n === travellers || save.isPending} className="ml-auto">
          Save
        </Button>
      </form>
      <p className="mt-1.5 text-xs text-ink-faint">Group budgets multiply the per-person estimate by this.</p>
    </div>
  );
}

function InviteFriends({ tripId }: { tripId: string }) {
  const [role, setRole] = useState<"editor" | "viewer">("editor");
  const [invite, setInvite] = useState<Invite | null>(null);
  const toast = useToast();
  const create = useMutation({
    mutationFn: () => api<Invite>(`/trips/${tripId}/invites`, { method: "POST", body: { role } }),
    onSuccess: setInvite,
  });
  return (
    <div>
      <h3 className="text-xs font-semibold text-ink">Invite friends</h3>
      <div className="mt-1.5 flex gap-2">
        <Select aria-label="Role for the invite" value={role} onChange={(e) => setRole(e.target.value as "editor" | "viewer")} className="h-9 min-w-0 flex-1">
          <option value="editor">Editor: can change routes</option>
          <option value="viewer">Viewer: can vote and comment</option>
        </Select>
        <Button size="sm" variant="primary" className="h-9" onClick={() => create.mutate()} disabled={create.isPending}>
          Create link
        </Button>
      </div>
      {invite ? (
        <div className="mt-2 space-y-1.5">
          <Input readOnly value={invite.url} onFocus={(e) => e.currentTarget.select()} aria-label="Invite link" className="h-9" />
          <div className="flex items-center justify-between text-xs text-ink-soft">
            <span>
              {invite.role} link, expires {shortDate(invite.expiresAt.slice(0, 10))}
            </span>
            <button
              className="font-medium text-sky hover:underline"
              onClick={() => {
                void navigator.clipboard?.writeText(invite.url).then(() => toast("Link copied", "ok"));
              }}
            >
              Copy
            </button>
          </div>
        </div>
      ) : null}
      {create.error ? <ErrorNote error={create.error} /> : null}
    </div>
  );
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

/** Who is on the trip; owners also invite people and set the group size here. */
function TravellersPanel({ trip }: { trip: TripDetail }) {
  const qc = useQueryClient();
  const router = useRouter();
  const toast = useToast();
  const { me } = useAuth();
  const tripId = trip.trip.id;
  const isOwner = trip.role === "owner";
  const owners = trip.members.filter((m) => m.role === "owner").length;
  const onError = (e: unknown) => toast(e instanceof Error ? e.message : "That didn't save", "error");

  const setRole = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: Role }) =>
      api<Member[]>(`/trips/${tripId}/members/${userId}`, { method: "PUT", body: { role } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.trip(tripId) }),
    onError,
  });
  const remove = useMutation({
    mutationFn: (userId: string) => api<Member[]>(`/trips/${tripId}/members/${userId}`, { method: "DELETE" }),
    onSuccess: (_data, userId) => {
      if (userId === me?.id) {
        void qc.invalidateQueries({ queryKey: keys.trips });
        router.push("/");
        return;
      }
      void qc.invalidateQueries({ queryKey: keys.trip(tripId) });
    },
    onError,
  });

  return (
    <Panel title={`Travellers · ${trip.members.length}`}>
      <ul className="space-y-2" data-testid="members">
        {trip.members.map((m) => {
          const self = m.id === me?.id;
          const lastOwner = m.role === "owner" && owners === 1;
          return (
            <li key={m.id} className="flex items-center gap-2.5 text-sm">
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-paper-2 font-mono text-[10px] font-semibold text-ink-soft">
                {initials(m.name)}
              </span>
              <span className="min-w-0 flex-1 truncate">
                {m.name}
                {self ? <span className="text-ink-faint"> (you)</span> : null}
              </span>
              {isOwner && !self ? (
                <Select
                  aria-label={`Role for ${m.name}`}
                  value={m.role}
                  disabled={setRole.isPending}
                  onChange={(e) => setRole.mutate({ userId: m.id, role: e.target.value as Role })}
                  className="h-8 text-xs"
                >
                  <option value="viewer">viewer</option>
                  <option value="editor">editor</option>
                  <option value="owner">owner</option>
                </Select>
              ) : (
                <Tag tone={m.role === "owner" ? "dark" : "plain"}>{m.role}</Tag>
              )}
              {(isOwner && !self) || (self && !lastOwner && !me?.isDemo) ? (
                <button
                  className="text-xs text-err hover:underline disabled:opacity-50"
                  disabled={remove.isPending}
                  aria-label={self ? "Leave this trip" : `Remove ${m.name}`}
                  onClick={() => {
                    const question = self
                      ? `Leave ${trip.trip.name}? You'll need a new invite to come back.`
                      : `Remove ${m.name} from ${trip.trip.name}?`;
                    if (window.confirm(question)) remove.mutate(m.id);
                  }}
                >
                  {self ? "Leave" : "Remove"}
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {isOwner && owners === 1 ? <p className="mt-3 text-xs text-ink-faint">To leave, first make someone else an owner.</p> : null}
      {isOwner ? (
        <div className="mt-4 space-y-4 border-t border-line pt-4">
          <InviteFriends tripId={tripId} />
          <GroupSize key={trip.trip.travellers ?? 1} tripId={tripId} travellers={trip.trip.travellers ?? 1} />
        </div>
      ) : null}
    </Panel>
  );
}

function TripHome({ tripId }: { tripId: string }) {
  const trip = useTrip(tripId);
  const qc = useQueryClient();
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>([]);
  const create = useMutation({
    mutationFn: () => api<RouteView>(`/trips/${tripId}/routes`, { method: "POST", body: { name: "New route" } }),
    onSuccess: (view) => {
      qc.setQueryData(keys.route(view.route.id), view);
      router.push(routeHref(tripId, view.route.id));
    },
  });

  if (trip.isPending) return <div className="mx-auto max-w-6xl px-4 py-8"><Spinner /></div>;
  if (trip.error) return <div className="mx-auto max-w-6xl px-4 py-8"><ErrorNote error={trip.error} /></div>;
  const t = trip.data;
  const current = t.routes.find((r) => r.isCurrent);
  const canEdit = hasRole(t.role, "editor");
  const compareReady = selected.length === 2;

  return (
    <>
      <BoardHeader
        eyebrow={`Trip · ${t.role}`}
        title={t.trip.name}
        meta={
          <>
            <BoardStat label="Departs" value={shortDate(t.trip.startDate)} />
            {t.trip.homeCity ? <BoardStat label="From" value={t.trip.homeCity} /> : null}
            <BoardStat label="Routes" value={t.routes.length} />
            <BoardStat label="Group size" value={t.trip.travellers ?? 1} />
          </>
        }
        actions={
          canEdit ? (
            <Button size="sm" variant="primary" onClick={() => create.mutate()} disabled={create.isPending}>
              New route
            </Button>
          ) : undefined
        }
      />
      <main className="mx-auto grid max-w-6xl grid-cols-1 gap-5 px-4 py-5 sm:px-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-5">
          {current ? <CurrentRoute trip={t} route={current} /> : null}

          <section aria-labelledby="routes-heading" className="overflow-visible rounded-2xl border border-line bg-card">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
              <div>
                <h2 id="routes-heading" className="text-sm font-semibold">
                  All routes
                </h2>
                <p className="text-xs text-ink-soft">Tick two to compare them side by side.</p>
              </div>
              <Button
                size="sm"
                variant={compareReady ? "primary" : "secondary"}
                disabled={!compareReady}
                onClick={() => router.push(`/trips/${tripId}/compare?a=${selected[0]}&b=${selected[1]}`)}
              >
                {compareReady ? "Compare selected" : `Compare (pick ${2 - selected.length} more)`}
              </Button>
            </div>
            <div
              className="hidden grid-cols-[auto_minmax(0,1fr)_3.5rem_4.25rem_5rem_7.25rem_2rem] gap-x-3 border-b border-line px-4 py-2 text-[10px] uppercase tracking-[0.16em] text-ink-faint sm:grid"
              aria-hidden
            >
              <span className="w-4" />
              <span>Route</span>
              <span>Nights</span>
              <span>Home</span>
              <span>Per person</span>
              <span>Checks</span>
              <span />
            </div>
            <ul className="divide-y divide-line">
              {t.routes.map((r) => (
                <RouteRow
                  key={`${r.id}-${r.version}`}
                  route={r}
                  trip={t}
                  selected={selected.includes(r.id)}
                  onSelect={(checked) =>
                    setSelected((s) => (checked ? [...s.filter((x) => x !== r.id), r.id].slice(-2) : s.filter((x) => x !== r.id)))
                  }
                />
              ))}
            </ul>
            {t.routes.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-ink-soft">
                No routes yet.{canEdit ? " Start one with New route." : ""}
              </p>
            ) : null}
          </section>
        </div>
        <aside className="space-y-4">
          <TravellersPanel trip={t} />
        </aside>
      </main>
    </>
  );
}

export default function TripPage() {
  const { tripId } = useParams<{ tripId: string }>();
  return (
    <RequireAuth>
      <TripHome tripId={tripId} />
    </RequireAuth>
  );
}
